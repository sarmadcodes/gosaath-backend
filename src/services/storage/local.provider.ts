import { createHmac, timingSafeEqual } from "node:crypto";
import { mkdir, rm, stat, writeFile, readFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { env } from "../../config/env.js";
import type { StorageProvider, UploadTarget } from "./storage.types.js";

/**
 * Files on local disk, for development and tests.
 *
 * Not for production: it survives neither a second server nor a redeploy that
 * replaces the machine. It exists so the whole upload flow — signing, the
 * upload itself, expiry, ownership, admin-only reads — can be built and
 * tested without anybody's cloud credentials, and so the S3 provider is a
 * swap rather than a rewrite.
 *
 * Its URLs are signed the same way a real provider's are: an HMAC over the
 * key, the expiry and what the URL is for. A link that leaks stops working,
 * and one signed for reading cannot be used for writing.
 */
export class LocalStorageProvider implements StorageProvider {
  readonly name = "local" as const;

  constructor(
    private readonly root = env.UPLOADS_DIR,
    private readonly baseUrl = env.PUBLIC_URL,
    // Development only, so a fallback is fine: production runs the S3
    // provider, and env refuses to boot without JWT_SECRET there anyway.
    private readonly secret = env.JWT_SECRET ?? "local-development-signing-key",
  ) {}

  /** Refuses any key that would escape the uploads directory. */
  private pathFor(key: string): string {
    const base = resolve(this.root);
    const full = resolve(join(base, key));
    if (full !== base && !full.startsWith(base + sep)) {
      throw new Error("Refusing a key that escapes the uploads directory.");
    }
    return full;
  }

  private sign(key: string, expiresAt: number, purpose: "put" | "get"): string {
    return createHmac("sha256", this.secret)
      .update(`${purpose}:${key}:${expiresAt}`)
      .digest("hex");
  }

  /**
   * Checks a signature without leaking how wrong it was.
   *
   * Compared in constant time: a comparison that returns early tells an
   * attacker how many leading characters were right.
   */
  verify(key: string, expiresAt: number, purpose: "put" | "get", token: string): boolean {
    if (!Number.isFinite(expiresAt) || expiresAt * 1000 < Date.now()) return false;
    const expected = Buffer.from(this.sign(key, expiresAt, purpose));
    const given = Buffer.from(token);
    return expected.length === given.length && timingSafeEqual(expected, given);
  }

  async signUpload(input: {
    key: string;
    contentType: string;
    maxBytes: number;
  }): Promise<UploadTarget> {
    const expiresInSeconds = 15 * 60;
    const expiresAt = Math.floor(Date.now() / 1000) + expiresInSeconds;
    const token = this.sign(input.key, expiresAt, "put");

    return {
      url: `${this.baseUrl}/api/v1/files/${encodeURI(input.key)}?exp=${expiresAt}&sig=${token}`,
      headers: { "Content-Type": input.contentType },
      key: input.key,
      expiresInSeconds,
    };
  }

  async signDownload(key: string, expiresInSeconds: number): Promise<string> {
    const expiresAt = Math.floor(Date.now() / 1000) + expiresInSeconds;
    const token = this.sign(key, expiresAt, "get");
    return `${this.baseUrl}/api/v1/files/${encodeURI(key)}?exp=${expiresAt}&sig=${token}`;
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
    await writeFile(`${path}.type`, contentType, "utf8");
  }

  async read(key: string): Promise<{ body: Buffer; contentType: string }> {
    const path = this.pathFor(key);
    const [body, contentType] = await Promise.all([
      readFile(path),
      readFile(`${path}.type`, "utf8").catch(() => "application/octet-stream"),
    ]);
    return { body, contentType };
  }

  async head(key: string) {
    try {
      const info = await stat(this.pathFor(key));
      const contentType = await readFile(`${this.pathFor(key)}.type`, "utf8").catch(
        () => null,
      );
      return { exists: true, size: info.size, contentType };
    } catch {
      return { exists: false, size: 0, contentType: null };
    }
  }

  async remove(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
    await rm(`${this.pathFor(key)}.type`, { force: true });
  }
}
