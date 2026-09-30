import { randomUUID } from "node:crypto";
import { env } from "../../config/env.js";
import { logger } from "../../utils/logger.js";
import { UnprocessableError } from "../../utils/errors.js";
import { CloudinaryStorageProvider } from "./cloudinary.provider.js";
import { LocalStorageProvider } from "./local.provider.js";
import { S3StorageProvider } from "./s3.provider.js";
import type { FileKind, StorageProvider, UploadTarget } from "./storage.types.js";

/**
 * Uploads, as the rest of the backend sees them.
 *
 * Two kinds of file, with opposite rules:
 *
 *   **photo** — a face, shown to people you are matched with. Read access is
 *   ordinary: any signed-in member of the same institution may end up seeing
 *   it, because that is what it is for.
 *
 *   **badge** — a student card, uploaded to prove enrolment. Admin-only,
 *   forever. It is never served through a member-facing API, never included
 *   in a user response, and the column it lives in is `select: false` so it
 *   cannot join a response by accident.
 *
 * The key encodes the owner, which is what makes ownership checkable later
 * without a second lookup: a key that does not start with this user's id is
 * not theirs, whoever hands it to us.
 */

const RULES: Record<FileKind, { maxBytes: number; types: string[] }> = {
  // A phone camera photo, after the client resizes it. Generous enough not to
  // reject a normal picture, small enough that a bucket cannot be filled with
  // a handful of requests.
  photo: {
    maxBytes: 5 * 1024 * 1024,
    types: ["image/jpeg", "image/png", "image/webp", "image/heic"],
  },
  // A card, which people photograph or scan. PDFs are common from a scanner.
  badge: {
    maxBytes: 10 * 1024 * 1024,
    types: ["image/jpeg", "image/png", "image/webp", "image/heic", "application/pdf"],
  },
};

/** How long a read URL lives. Long enough to render a list, short enough to expire. */
const DOWNLOAD_TTL_SECONDS = 15 * 60;

/**
 * Two providers, chosen by what the file is — not by one global setting.
 *
 * A photo wants a CDN and a resized variant. A student card wants the
 * opposite: no CDN, no cache, no URL that outlives the request that asked for
 * it. Trying to serve both from one bucket means one of them gets the wrong
 * treatment, so `photo` follows MEDIA_PROVIDER and `badge` follows
 * UPLOADS_PROVIDER, and nothing outside this file has to know which is which.
 */
const instances = new Map<FileKind, StorageProvider>();

/** Substituted wholesale by tests, which then need no credentials at all. */
let override: StorageProvider | undefined;

/**
 * Which provider holds a given kind of file.
 *
 * Pure, and exported, so the one rule that matters can be asserted directly:
 * **a verification document is never routed to Cloudinary**, whatever
 * MEDIA_PROVIDER says. That is a privacy guarantee rather than a
 * configuration default, and a guarantee deserves a test that does not
 * depend on the environment to express it.
 */
export function chooseProvider(
  kind: FileKind,
  media: typeof env.MEDIA_PROVIDER,
  uploads: typeof env.UPLOADS_PROVIDER,
): "cloudinary" | "s3" | "local" {
  if (kind === "badge") return uploads;
  return media;
}

function build(kind: FileKind): StorageProvider {
  switch (chooseProvider(kind, env.MEDIA_PROVIDER, env.UPLOADS_PROVIDER)) {
    case "cloudinary":
      return new CloudinaryStorageProvider();
    case "s3":
      return new S3StorageProvider();
    case "local":
      return new LocalStorageProvider();
  }
}

export function storageProvider(kind: FileKind = "badge"): StorageProvider {
  if (override) return override;

  let instance = instances.get(kind);
  if (!instance) {
    instance = build(kind);
    instances.set(kind, instance);
    logger.info({ provider: instance.name, kind }, "storage ready");
  }
  return instance;
}

/** Lets a test substitute a provider without touching the environment. */
export function setStorageProvider(next: StorageProvider | null): void {
  override = next ?? undefined;
  if (!next) instances.clear();
}

/**
 * Which kind of file a key holds, read from the key itself.
 *
 * `keyFor` puts the kind in the first segment precisely so that a key alone
 * is enough to find the provider that stored it. Callers holding only a key —
 * rendering a photo, cleaning up a replaced file — would otherwise have to
 * pass a kind they do not always know.
 */
function kindOfKey(key: string): FileKind {
  return key.startsWith("photos/") ? "photo" : "badge";
}

const EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
  "application/pdf": "pdf",
};

/**
 * Where a file lives.
 *
 * The owner's id is the first segment, so `keyBelongsTo` is a string check
 * rather than a database round trip — and a client that invents a key can
 * only ever invent one inside its own folder.
 */
function keyFor(kind: FileKind, userId: string, contentType: string): string {
  const extension = EXTENSIONS[contentType] ?? "bin";
  // A fresh name every time: reusing one means a cached photo somewhere still
  // shows the old image, and a deleted file's URL quietly resurrects.
  return `${kind}s/${userId}/${randomUUID()}.${extension}`;
}

export function keyBelongsTo(key: string, kind: FileKind, userId: string): boolean {
  return key.startsWith(`${kind}s/${userId}/`) && !key.includes("..");
}

/**
 * Agrees to accept one file, and says where to put it.
 *
 * The type and size are checked here rather than after the upload: the point
 * of a signed URL is that the storage provider enforces what we agreed, so
 * the agreement has to be right before it is signed.
 */
export async function signUpload(input: {
  kind: FileKind;
  userId: string;
  contentType: string;
  bytes: number;
}): Promise<UploadTarget> {
  const rules = RULES[input.kind];

  if (!rules.types.includes(input.contentType)) {
    throw new UnprocessableError(
      input.kind === "photo"
        ? "Photos must be a JPEG, PNG or WebP image."
        : "Upload your card as an image or a PDF.",
    );
  }

  if (!Number.isFinite(input.bytes) || input.bytes <= 0) {
    throw new UnprocessableError("That file looks empty.");
  }

  if (input.bytes > rules.maxBytes) {
    const mb = Math.floor(rules.maxBytes / (1024 * 1024));
    throw new UnprocessableError(`That file is too large. The limit is ${mb} MB.`);
  }

  return storageProvider(input.kind).signUpload({
    key: keyFor(input.kind, input.userId, input.contentType),
    contentType: input.contentType,
    maxBytes: input.bytes,
  });
}

/**
 * Confirms a file actually arrived before anything is recorded against it.
 *
 * Without this, a client can sign an upload, never perform it, and set its
 * photo to a key that is not there — leaving a broken image nobody can
 * explain, and for a badge, an admin reviewing nothing.
 */
export async function confirmUploaded(key: string, kind: FileKind): Promise<void> {
  const found = await storageProvider(kind).head(key);
  if (!found.exists) {
    throw new UnprocessableError("That upload did not finish. Try again.");
  }
  if (found.size > RULES[kind].maxBytes) {
    // The provider should have refused it; if one ever does not, it does not
    // get to be recorded.
    await storageProvider(kind).remove(key);
    throw new UnprocessableError("That file is too large.");
  }
}

/** A short-lived URL for reading a stored file, or null for nothing stored. */
export async function readUrlFor(key: string | null | undefined): Promise<string | null> {
  if (!key) return null;
  // Already a URL: photos uploaded before object storage existed, and the
  // seeded demo accounts. Passed through rather than signed.
  if (key.startsWith("http://") || key.startsWith("https://")) return key;
  return storageProvider(kindOfKey(key)).signDownload(key, DOWNLOAD_TTL_SECONDS);
}

export async function removeFile(key: string | null | undefined): Promise<void> {
  if (!key || key.startsWith("http")) return;
  await storageProvider(kindOfKey(key))
    .remove(key)
    .catch((error: unknown) => {
      // A file we failed to delete is rubbish in a bucket, not a failed
      // request: the row that pointed at it has already gone.
      logger.warn({ err: error, key }, "could not remove stored file");
    });
}

export type { FileKind, StorageProvider, UploadTarget } from "./storage.types.js";
