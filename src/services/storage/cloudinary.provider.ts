import { v2 as cloudinary } from "cloudinary";
import { env } from "../../config/env.js";
import { logger } from "../../utils/logger.js";
import type { StorageProvider, UploadTarget } from "./storage.types.js";

/**
 * Cloudinary, for profile photos only.
 *
 * Photos get a CDN and on-the-fly resizing, which matters: a match list
 * renders a dozen faces, and shipping a dozen 4 MB camera originals to a
 * phone on mobile data is the difference between a list that appears and a
 * list that loads. Every delivery URL below carries a transformation, so the
 * bytes that reach the app are a face-cropped thumbnail regardless of what
 * was uploaded.
 *
 * **Verification documents never come here.** They stay on the private
 * signed-storage provider, where every read is authorised by us per request
 * and written to the audit log. See the note on `signDownload`: Cloudinary's
 * authenticated URLs are unguessable, not expiring, and "unguessable" is the
 * wrong guarantee for a student's ID card.
 */

export type CloudinaryConfig = {
  cloudName: string;
  apiKey: string;
  apiSecret: string;
};

/**
 * How a photo is delivered, always.
 *
 * `face` gravity rather than a centre crop: a photo taken at arm's length
 * puts the face in the top third, and a centre crop of that is a picture of
 * somebody's shirt. `auto` format serves WebP or AVIF to phones that accept
 * it and JPEG to those that do not.
 */
const DELIVERY = [
  { width: 512, height: 512, crop: "fill", gravity: "face" },
  { quality: "auto", fetch_format: "auto" },
];

/**
 * Our storage key, as Cloudinary names it.
 *
 * Cloudinary's public id carries no extension — the format is a property of
 * the stored asset, not of its name. Everything else in the backend passes
 * keys around with one, so the translation lives here rather than leaking a
 * Cloudinary-shaped identifier into the user model.
 */
function publicIdOf(key: string): string {
  return key.replace(/\.[^./]+$/, "");
}

export class CloudinaryStorageProvider implements StorageProvider {
  readonly name = "cloudinary" as const;

  /**
   * Credentials are passed in rather than read from the environment here.
   *
   * The environment is process-wide, and a test that sets it to exercise this
   * provider changes it for everything else running in the same worker. That
   * is not a hypothetical: an earlier version of this class read env directly,
   * and its test quietly rerouted every profile-photo upload in the
   * integration suite to Cloudinary.
   */
  constructor(private readonly config: CloudinaryConfig = {
    cloudName: env.CLOUDINARY_CLOUD_NAME ?? "",
    apiKey: env.CLOUDINARY_API_KEY ?? "",
    apiSecret: env.CLOUDINARY_API_SECRET ?? "",
  }) {}

  /**
   * The SDK, configured for this instance.
   *
   * The Cloudinary SDK keeps configuration in module-level state, so it is set
   * on every call rather than once: two providers with different credentials
   * must not depend on which was constructed last.
   */
  private client(): typeof cloudinary {
    cloudinary.config({
      cloud_name: this.config.cloudName,
      api_key: this.config.apiKey,
      api_secret: this.config.apiSecret,
      secure: true,
    });
    return cloudinary;
  }

  /**
   * Signs a direct upload from the device.
   *
   * The bytes go phone → Cloudinary, never through us. Only the fields listed
   * here are signed, which is the whole point of signing: a client cannot add
   * `type: upload` to make the asset public, or point `public_id` at somebody
   * else's photo, because either one invalidates the signature.
   */
  async signUpload(input: {
    key: string;
    contentType: string;
    maxBytes: number;
  }): Promise<UploadTarget> {
    const api = this.client();
    const timestamp = Math.round(Date.now() / 1000);
    const params = {
      public_id: publicIdOf(input.key),
      timestamp,
      type: "authenticated",
    };

    const signature = api.utils.api_sign_request(params, this.config.apiSecret);

    return {
      url: `https://api.cloudinary.com/v1_1/${this.config.cloudName}/image/upload`,
      method: "POST",
      // Multipart, so the boundary has to be chosen by whatever builds the
      // body. Setting Content-Type here would override it and break the
      // upload in a way that looks like a signature failure.
      headers: {},
      fields: {
        ...params,
        timestamp: String(timestamp),
        signature,
        api_key: this.config.apiKey,
      },
      key: input.key,
      // Cloudinary rejects a signature older than an hour. We are stricter:
      // a target handed out and not used within ten minutes was abandoned.
      expiresInSeconds: 600,
    };
  }

  /**
   * A delivery URL for a stored photo.
   *
   * Signed and tied to the `authenticated` delivery type, so the URL cannot
   * be guessed from the public id and cannot be altered to request a
   * different transformation.
   *
   * It does not expire, and that is a deliberate, narrow exception to the
   * rule the rest of this module follows. Expiring delivery URLs on
   * Cloudinary need token-based authentication, which is not on this account's
   * plan. The exception is acceptable for a face photo that every matched
   * member is shown anyway; it would not be acceptable for a document, which
   * is exactly why documents are not stored here.
   *
   * `ttlSeconds` is therefore accepted and ignored, rather than removed from
   * the interface — the S3 provider needs it, and a caller should not have to
   * know which provider is behind a given kind of file.
   */
  async signDownload(key: string, _ttlSeconds: number): Promise<string> {
    return this.client().url(publicIdOf(key), {
      type: "authenticated",
      resource_type: "image",
      sign_url: true,
      secure: true,
      transformation: DELIVERY,
    });
  }

  /** Invalidated as well as deleted, or the CDN serves the old face for hours. */
  async remove(key: string): Promise<void> {
    await this.client().uploader.destroy(publicIdOf(key), {
      type: "authenticated",
      resource_type: "image",
      invalidate: true,
    });
  }

  async head(
    key: string,
  ): Promise<{ exists: boolean; size: number; contentType: string | null }> {
    try {
      const resource = await this.client().api.resource(publicIdOf(key), {
        type: "authenticated",
        resource_type: "image",
      });
      return {
        exists: true,
        size: resource.bytes ?? 0,
        contentType: resource.format ? `image/${resource.format}` : null,
      };
    } catch (error: unknown) {
      // Cloudinary answers 404 for an asset that never arrived, which is the
      // expected case here — the client signed an upload and abandoned it.
      const status = (error as { error?: { http_code?: number } })?.error?.http_code;
      if (status === 404) return { exists: false, size: 0, contentType: null };
      logger.warn({ err: error, key }, "cloudinary head failed");
      throw error;
    }
  }
}
