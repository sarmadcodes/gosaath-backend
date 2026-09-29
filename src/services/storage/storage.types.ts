/**
 * What the rest of the backend is allowed to know about file storage.
 *
 * Domain code asks for "a URL this person can upload a photo to", never
 * "PutObject on this bucket". Swapping R2 for S3, or either for local disk in
 * development, is then one file — and no domain service ends up holding a
 * secret or knowing a provider's error shape.
 *
 * **Bytes never go through MongoDB.** A profile photo in a document is a
 * document that gets read on every match query, and a 2 MB image in a row is
 * a 2 MB read nobody asked for.
 */

/** What a file is for. Decides where it lives and who may read it. */
export type FileKind = "photo" | "badge";

export type UploadTarget = {
  /**
   * Where the client PUTs the bytes. Short-lived and single-purpose: it
   * carries the content type and size it was signed for, so it cannot be
   * reused to upload something else.
   */
  url: string;
  /** Header the client must send, matching what was signed. */
  headers: Record<string, string>;
  /**
   * The stored object's key. The client hands this back when it tells us the
   * upload finished; it is not a URL and cannot be fetched directly.
   */
  key: string;
  expiresInSeconds: number;
};

export interface StorageProvider {
  readonly name: "s3" | "local";

  /** A URL the client may upload one specific file to, once, soon. */
  signUpload(input: {
    key: string;
    contentType: string;
    maxBytes: number;
  }): Promise<UploadTarget>;

  /**
   * A URL to read a stored object, valid briefly.
   *
   * Always signed and always expiring, even for profile photos: a permanent
   * public URL is one leak away from being a permanent public URL for
   * everyone, and it would outlive the account that owns it.
   */
  signDownload(key: string, expiresInSeconds: number): Promise<string>;

  /** Removes an object. Missing objects are not an error. */
  remove(key: string): Promise<void>;

  /** Whether the object actually arrived, and how big it is. */
  head(key: string): Promise<{ exists: boolean; size: number; contentType: string | null }>;
}
