import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CloudinaryStorageProvider } from "../../src/services/storage/cloudinary.provider.js";
import { chooseProvider } from "../../src/services/storage/index.js";

/**
 * Cloudinary carries profile photos and nothing else.
 *
 * The two things worth pinning down are the ones that would fail silently:
 * whether a signed upload is signed over exactly the fields the client is
 * given, and whether a student card can ever be routed here. The second is a
 * privacy rule, not a configuration preference — a document delivered over a
 * CDN URL that does not expire has left our control for good.
 *
 * Credentials are injected rather than set in `process.env`. Vitest shares a
 * worker between test files, so an earlier version of this file that set
 * MEDIA_PROVIDER globally rerouted every profile-photo upload in the
 * integration suite to Cloudinary and broke six unrelated tests.
 */

const SECRET = "test-secret-value";

const provider = new CloudinaryStorageProvider({
  cloudName: "test-cloud",
  apiKey: "123456789",
  apiSecret: SECRET,
});

const KEY = "photos/64b7f1c2e4b0a1d2c3e4f5a6/abc-123.jpg";

describe("Cloudinary upload signing", () => {
  it("signs exactly the fields the client is handed", async () => {
    const target = await provider.signUpload({
      key: KEY,
      contentType: "image/jpeg",
      maxBytes: 1024,
    });

    const { signature, api_key, ...signed } = target.fields!;

    // Recomputed the way Cloudinary does it: sorted k=v pairs, joined with &,
    // the secret appended, SHA-1. If the provider ever signs a field it does
    // not send — or sends one it did not sign — this diverges.
    const expected = createHash("sha1")
      .update(
        Object.keys(signed)
          .sort()
          .map((key) => `${key}=${signed[key]}`)
          .join("&") + SECRET,
      )
      .digest("hex");

    expect(signature).toBe(expected);
    expect(api_key).toBe("123456789");
  });

  it("pins the asset to the authenticated delivery type", async () => {
    const target = await provider.signUpload({
      key: KEY,
      contentType: "image/jpeg",
      maxBytes: 1024,
    });

    // A client that flipped this to "upload" would make the photo publicly
    // readable at a guessable URL. It is inside the signature, so it cannot.
    expect(target.fields!["type"]).toBe("authenticated");
    expect(target.method).toBe("POST");
  });

  it("sets no Content-Type, so the multipart boundary survives", async () => {
    const target = await provider.signUpload({
      key: KEY,
      contentType: "image/jpeg",
      maxBytes: 1024,
    });

    expect(target.headers).toEqual({});
  });

  it("drops the extension, because a public id has no format", async () => {
    const url = await provider.signDownload(KEY, 900);

    expect(url).toContain("photos/64b7f1c2e4b0a1d2c3e4f5a6/abc-123");
    expect(url).not.toContain("abc-123.jpg");
  });

  it("delivers a resized, face-cropped, re-encoded variant", async () => {
    const url = await provider.signDownload(KEY, 900);

    // Without these the app receives whatever the camera produced, which on a
    // match list is a dozen multi-megabyte originals.
    expect(url).toContain("c_fill");
    expect(url).toContain("g_face");
    expect(url).toContain("f_auto");
    expect(url).toContain("q_auto");
    expect(url).toContain("/authenticated/");
    // Signed, so the transformation cannot be rewritten by whoever holds it.
    expect(url).toMatch(/\/s--[^-]+--\//);
  });
});

describe("what Cloudinary is allowed to hold", () => {
  it("takes photos when that is how media is configured", () => {
    expect(chooseProvider("photo", "cloudinary", "s3")).toBe("cloudinary");
  });

  it("never takes verification documents", () => {
    // Media is set to cloudinary here and a badge still does not go there.
    // This is the privacy rule, in one assertion.
    expect(chooseProvider("badge", "cloudinary", "s3")).toBe("s3");
    expect(chooseProvider("badge", "cloudinary", "local")).toBe("local");
  });

  it("leaves documents on private storage whatever media does", () => {
    for (const media of ["cloudinary", "s3", "local"] as const) {
      expect(chooseProvider("badge", media, "s3")).toBe("s3");
    }
  });
});
