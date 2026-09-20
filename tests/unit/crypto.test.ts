import { describe, expect, it } from "vitest";
import {
  ARGON_OPTIONS,
  PRODUCTION_ARGON_OPTIONS,
  generateOtp,
  generateRefreshToken,
  hashPassword,
  hashToken,
  safeEqual,
  verifyPassword,
} from "../../src/utils/crypto.js";

/**
 * Hashing, tokens and one-time codes.
 *
 * The parameter test exists because a work factor is the kind of number that
 * gets quietly lowered to make something else faster — which was tried here,
 * and reverted when it turned out to buy 1.6%.
 */
describe("Argon2 parameters", () => {
  it("keeps OWASP's baseline everywhere, tests included", () => {
    // The same parameters in the suite as in production, so what is exercised
    // is what actually runs.
    expect(ARGON_OPTIONS).toEqual({
      memoryCost: 19_456,
      timeCost: 2,
      parallelism: 1,
    });
    expect(PRODUCTION_ARGON_OPTIONS).toEqual(ARGON_OPTIONS);
  });
});

describe("password hashing", () => {
  it("never stores the password itself", async () => {
    const hash = await hashPassword("a-long-enough-passphrase");
    expect(hash).not.toContain("a-long-enough-passphrase");
    expect(hash.startsWith("$argon2id$")).toBe(true);
  });

  it("salts, so the same password hashes differently each time", async () => {
    const a = await hashPassword("identical-passphrase");
    const b = await hashPassword("identical-passphrase");
    // Without a salt, two people with the same password share a hash and one
    // cracked password breaks both accounts.
    expect(a).not.toBe(b);
    expect(await verifyPassword(a, "identical-passphrase")).toBe(true);
    expect(await verifyPassword(b, "identical-passphrase")).toBe(true);
  });

  it("rejects the wrong password", async () => {
    const hash = await hashPassword("the-real-passphrase");
    expect(await verifyPassword(hash, "not-the-passphrase")).toBe(false);
  });

  it("returns false rather than throwing on a corrupted hash", async () => {
    // A hand-edited or truncated record is a failed login, not a 500 — and
    // certainly not a reason to tell the caller anything about the account.
    expect(await verifyPassword("not-a-hash-at-all", "anything")).toBe(false);
    expect(await verifyPassword("", "anything")).toBe(false);
  });
});

describe("OTP generation", () => {
  it("is always six digits, leading zeros preserved", () => {
    for (let i = 0; i < 300; i++) {
      const code = generateOtp();
      // "042913" silently becoming "42913" would fail verification for one
      // user in ten.
      expect(code).toMatch(/^\d{6}$/);
    }
  });

  it("covers the whole range rather than clustering", () => {
    const codes = new Set(Array.from({ length: 500 }, () => generateOtp()));
    // A generator stuck on a narrow range is a brute-force shortcut.
    expect(codes.size).toBeGreaterThan(400);
  });
});

describe("refresh tokens", () => {
  it("is long, url-safe and unique", () => {
    const tokens = new Set(Array.from({ length: 200 }, generateRefreshToken));
    expect(tokens.size).toBe(200);
    for (const token of tokens) {
      expect(token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    }
  });

  it("hashes to a stable digest that is not the token", () => {
    const token = generateRefreshToken();
    const digest = hashToken(token);
    // A database leak must not hand over usable sessions.
    expect(digest).not.toBe(token);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(token)).toBe(digest);
  });
});

describe("safeEqual", () => {
  it("matches identical strings and rejects everything else", () => {
    expect(safeEqual("abc123", "abc123")).toBe(true);
    expect(safeEqual("abc123", "abc124")).toBe(false);
    // Different lengths must not throw — timingSafeEqual requires equal
    // lengths, so the guard has to come first.
    expect(safeEqual("short", "considerably-longer")).toBe(false);
    expect(safeEqual("", "")).toBe(true);
  });
});
