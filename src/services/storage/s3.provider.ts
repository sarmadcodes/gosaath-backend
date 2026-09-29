import {
  DeleteObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  GetObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "../../config/env.js";
import type { StorageProvider, UploadTarget } from "./storage.types.js";

/**
 * S3-compatible object storage: AWS S3, Cloudflare R2, or anything speaking
 * the same protocol. R2 is the cheaper fit for this product — no egress
 * charges, and profile photos are read far more often than they are written.
 *
 * The bucket is private. Nothing here ever makes an object public: every URL
 * handed out is signed and expires, so a link that leaks stops working and a
 * photo cannot outlive the account that owns it.
 *
 * Uploads go straight from the phone to the bucket rather than through this
 * server. A 2 MB photo relayed through the API is 2 MB of request body, an
 * event loop stall, and a memory spike per upload, all to end up in the same
 * place.
 */
export class S3StorageProvider implements StorageProvider {
  readonly name = "s3" as const;

  private readonly client: S3Client;
  private readonly bucket: string;

  constructor() {
    if (!env.S3_BUCKET) throw new Error("S3_BUCKET is not configured.");
    this.bucket = env.S3_BUCKET;
    this.client = new S3Client({
      region: env.S3_REGION,
      // R2 and MinIO need an explicit endpoint; AWS infers one from the region.
      ...(env.S3_ENDPOINT ? { endpoint: env.S3_ENDPOINT, forcePathStyle: true } : {}),
      credentials: {
        accessKeyId: env.S3_ACCESS_KEY_ID!,
        secretAccessKey: env.S3_SECRET_ACCESS_KEY!,
      },
    });
  }

  async signUpload(input: {
    key: string;
    contentType: string;
    maxBytes: number;
  }): Promise<UploadTarget> {
    const expiresInSeconds = 15 * 60;

    // ContentType and ContentLength are part of what is signed, so the URL
    // cannot be reused to upload a different kind or a much larger file than
    // the one we agreed to.
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: input.key,
      ContentType: input.contentType,
      ContentLength: input.maxBytes,
    });

    const url = await getSignedUrl(this.client, command, { expiresIn: expiresInSeconds });

    return {
      url,
      headers: { "Content-Type": input.contentType },
      key: input.key,
      expiresInSeconds,
    };
  }

  async signDownload(key: string, expiresInSeconds: number): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      { expiresIn: expiresInSeconds },
    );
  }

  async head(key: string) {
    try {
      const result = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return {
        exists: true,
        size: result.ContentLength ?? 0,
        contentType: result.ContentType ?? null,
      };
    } catch {
      // A missing object is an answer, not a failure.
      return { exists: false, size: 0, contentType: null };
    }
  }

  async remove(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}
