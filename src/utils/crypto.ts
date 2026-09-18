import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { hash as argonHash, verify as argonVerify } from "@node-rs/argon2";

/**
 * Password, OTP and token handling.
 *
 * Every secret in the system is created and checked here, so the parameters
 * are in one reviewable place rather than chosen per call site.
 */

/**
 * OWASP's recommended Argon2id baseline: 19 MiB, 2 passes, 1 lane.
 *
 * Argon2id rather than bcrypt because it resists GPU cracking through memory
 * cost, not just iterations. The memory figure is the important number — an
 * attacker cannot parallelise thousands of these on a graphics card the way
 * they can with bcrypt.
 */
const ARGON_OPTIONS = {
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export async function hashPassword(plain: string): Promise<string> {
  return argonHash(plain, ARGON_OPTIONS);
}

/**
 * Verifies a password, returning false rather than throwing on a malformed
 * hash.
 *
 * A stored value that is not a valid Argon2 string means a corrupted or
 * hand-edited record. That is a failed login, not a 500 — and certainly not a
 * reason to tell the caller anything about the account.
 */
export async function verifyPassword(
  hash: string,
  plain: string,
): Promise<boolean> {
  try {
    return await argonVerify(hash, plain, ARGON_OPTIONS);
  } catch {
    return false;
  }
}

/**
 * A six-digit numeric code.
 *
 * `randomInt` draws from the CSPRNG, not `Math.random`. Six digits is only
 * ~20 bits, which is exactly why the challenge that holds it enforces a short
 * expiry and a hard attempt limit — the entropy alone is not the defence.
 *
 * Leading zeros are preserved: "042913" is a valid code and silently becoming
 * "42913" would fail verification for one user in ten.
 */
export function generateOtp(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

/**
 * OTPs are hashed with Argon2id, the same as passwords.
 *
 * A six-digit code is a small keyspace: if the database leaked, a plain SHA
 * digest of every possible code could be precomputed in seconds. Argon2's
 * memory cost makes that sweep expensive instead of instant.
 */
export async function hashOtp(code: string): Promise<string> {
  return argonHash(code, ARGON_OPTIONS);
}

export async function verifyOtp(hash: string, code: string): Promise<boolean> {
  try {
    return await argonVerify(hash, code, ARGON_OPTIONS);
  } catch {
    return false;
  }
}

/**
 * An opaque refresh token: 256 bits of randomness, url-safe.
 *
 * Not a JWT. A refresh token needs to be revocable, and a self-contained
 * signed token cannot be revoked without a lookup anyway — so it may as well
 * be a random string whose only meaning is the row it points at.
 */
export function generateRefreshToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Refresh tokens are stored as a SHA-256 digest, not Argon2.
 *
 * Deliberate, and the opposite call to passwords: this value already carries
 * 256 bits of entropy, so there is nothing to brute force and a slow hash
 * would only add latency to every token refresh. The digest exists so a
 * database leak does not hand over usable sessions.
 */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Constant-time compare for digests, so a match cannot be timed out byte by byte. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
