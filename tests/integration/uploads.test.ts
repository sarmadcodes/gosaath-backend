import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app/app.js";
import { connectToDatabase, disconnectFromDatabase } from "../../src/db/mongodb.js";
import {
  AreaModel,
  CampusModel,
  InstitutionModel,
  SessionModel,
  UserModel,
} from "../../src/db/models/index.js";
import { readUrlFor } from "../../src/services/storage/index.js";

/**
 * Uploads.
 *
 * Two kinds of file with opposite rules. A photo is meant to be seen by
 * people you match with; a student card is meant to be seen by an admin and
 * nobody else, ever. Most of this file exists to prove the second one.
 */

let app: FastifyInstance;
let institutionId: string;
let campusId: string;
let areaId: string;
let alice: { id: string; access: string };
let bob: { id: string; access: string };

const api = (
  method: "POST" | "PUT" | "GET",
  url: string,
  token: string,
  payload?: object,
) =>
  app.inject({
    method,
    url: `/api/v1${url}`,
    headers: { authorization: `Bearer ${token}` },
    ...(payload ? { payload } : {}),
  });

async function makeUser(email: string) {
  await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: {
      name: `${email.split("@")[0]} Person`,
      email,
      password: "a-long-enough-passphrase",
      phone: "0300 1234567",
      userType: "student",
      institutionId,
      campusId,
      areaId,
    },
  });
  await UserModel.updateOne({ email }, { $set: { emailVerifiedAt: new Date() } });
  const login = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email, password: "a-long-enough-passphrase" },
  });
  const refresh = await app.inject({
    method: "POST",
    url: "/api/v1/auth/refresh",
    payload: { token: login.json().data.token },
  });
  const user = await UserModel.findOne({ email });
  return {
    id: user!._id.toString(),
    access: refresh.json().data.accessToken as string,
  };
}

/** Signs, uploads a byte, and returns the key — the whole client flow. */
async function upload(
  who: { access: string },
  kind: "photo" | "badge",
  contentType = "image/jpeg",
): Promise<string> {
  const signed = await api("POST", "/uploads/sign", who.access, {
    kind,
    contentType,
    bytes: 1024,
  });
  const target = signed.json().data as { url: string; key: string };

  const put = await app.inject({
    method: "PUT",
    url: target.url.replace(/^https?:\/\/[^/]+/, ""),
    headers: { "content-type": contentType },
    payload: Buffer.from("not-really-a-jpeg"),
  });
  expect(put.statusCode).toBe(200);

  return target.key;
}

beforeAll(async () => {
  await connectToDatabase();
  app = await buildApp({ rateLimit: false });
  await app.ready();

  institutionId = (
    await InstitutionModel.findOne({ name: "SZABIST University" })
  )!._id.toString();
  campusId = (await CampusModel.findOne({ name: "Clifton Campus" }))!._id.toString();
  areaId = (await AreaModel.findOne({ name: "Gulshan-e-Iqbal" }))!._id.toString();
}, 60_000);

afterAll(async () => {
  // Left behind, these join another suite's member counts. Files share one
  // database and run in sequence, so tidying up is part of the test.
  await UserModel.deleteMany({ email: /@szabist\.edu\.pk$/ });
  await app.close();
  await disconnectFromDatabase();
});

beforeEach(async () => {
  await UserModel.deleteMany({ email: /@szabist\.edu\.pk$/ });
  await SessionModel.deleteMany({});
  alice = await makeUser("alice@szabist.edu.pk");
  bob = await makeUser("bob@szabist.edu.pk");
});

describe("asking to upload", () => {
  it("refuses a file type that is not an image", async () => {
    const response = await api("POST", "/uploads/sign", alice.access, {
      kind: "photo",
      contentType: "application/x-msdownload",
      bytes: 1024,
    });
    expect(response.statusCode).toBe(422);
  });

  it("refuses a file that is too large", async () => {
    const response = await api("POST", "/uploads/sign", alice.access, {
      kind: "photo",
      contentType: "image/jpeg",
      bytes: 20 * 1024 * 1024,
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.message).toContain("too large");
  });

  it("accepts a PDF for a card but not for a photo", async () => {
    const asBadge = await api("POST", "/uploads/sign", alice.access, {
      kind: "badge",
      contentType: "application/pdf",
      bytes: 1024,
    });
    expect(asBadge.statusCode).toBe(200);

    const asPhoto = await api("POST", "/uploads/sign", alice.access, {
      kind: "photo",
      contentType: "application/pdf",
      bytes: 1024,
    });
    expect(asPhoto.statusCode).toBe(422);
  });

  it("refuses an unauthenticated caller", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/uploads/sign",
      payload: { kind: "photo", contentType: "image/jpeg", bytes: 1024 },
    });
    expect(response.statusCode).toBe(401);
  });

  it("puts the owner in the key, so it cannot be used by anyone else", async () => {
    const signed = await api("POST", "/uploads/sign", alice.access, {
      kind: "photo",
      contentType: "image/jpeg",
      bytes: 1024,
    });
    expect(signed.json().data.key).toContain(alice.id);
  });
});

describe("recording an upload", () => {
  it("sets the photo from a finished upload", async () => {
    const key = await upload(alice, "photo");
    const response = await api("PUT", "/me/photo", alice.access, { key });
    expect(response.statusCode).toBe(200);

    // Never the storage key: what a client receives is an address it can
    // actually fetch, and the key is not one.
    expect(response.json().data.photoUrl).toContain(`/photos/${alice.id}`);
    expect(response.json().data.photoUrl).not.toContain(key);
  });

  it("refuses somebody else's upload key", async () => {
    const key = await upload(bob, "photo");
    const response = await api("PUT", "/me/photo", alice.access, { key });
    expect(response.statusCode).toBe(422);
  });

  it("refuses a key for an upload that never happened", async () => {
    const signed = await api("POST", "/uploads/sign", alice.access, {
      kind: "photo",
      contentType: "image/jpeg",
      bytes: 1024,
    });
    // Signed but never uploaded: recording it would leave a photo that is a
    // broken image for everyone but the person who chose it.
    const response = await api("PUT", "/me/photo", alice.access, {
      key: signed.json().data.key,
    });
    expect(response.statusCode).toBe(422);
  });

  it("refuses a URL where a key belongs", async () => {
    const response = await api("PUT", "/me/photo", alice.access, {
      key: "https://example.com/somebody-elses-image.jpg",
    });
    expect(response.statusCode).toBe(400);
  });

  it("refuses a key that tries to climb out of its folder", async () => {
    const response = await api("PUT", "/me/photo", alice.access, {
      key: `photos/${alice.id}/../../badges/${bob.id}/card.jpg`,
    });
    expect(response.statusCode).toBe(400);
  });
});

describe("the student card", () => {
  it("is never returned by a member-facing API", async () => {
    const key = await upload(alice, "badge");
    await api("POST", "/me/badge", alice.access, { key });

    const me = await api("GET", "/me", alice.access);
    expect(me.body).not.toContain(key);
    expect(me.body).not.toContain("badgeDocument");

    // Not through anyone else's view of her either.
    const asOther = await api("GET", "/me", bob.access);
    expect(asOther.body).not.toContain(key);
  });

  it("moves the badge to pending for an admin to look at", async () => {
    const key = await upload(alice, "badge");
    const response = await api("POST", "/me/badge", alice.access, { key });
    expect(response.json().data.badgeStatus).toBe("pending");
  });
});

describe("serving files to another origin", () => {
  /**
   * Found in a browser, not in a test: helmet sets
   * Cross-Origin-Resource-Policy: same-origin across the API, which is right
   * for JSON and wrong for a file. The admin panel runs on its own origin, so
   * without this the browser downloads the document, gets a 200, and then
   * silently refuses to draw it. Reading the response tells you nothing.
   */
  it("lets a stored file be embedded by a page on another origin", async () => {
    const key = await upload(alice, "badge");
    const signed = await readUrlFor(key);

    const file = await app.inject({
      method: "GET",
      url: (signed ?? "").replace(/^https?:\/\/[^/]+/, ""),
    });

    expect(file.statusCode).toBe(200);
    expect(file.headers["cross-origin-resource-policy"]).toBe("cross-origin");
  });

  it("does the same for a member photo, which is fetched the same way", async () => {
    const key = await upload(alice, "photo");
    await api("PUT", "/me/photo", alice.access, { key });

    const redirect = await api("GET", `/photos/${alice.id}`, bob.access);
    expect(redirect.statusCode).toBe(302);
    expect(redirect.headers["cross-origin-resource-policy"]).toBe("cross-origin");
  });
});

describe("serving a photo", () => {
  it("redirects a signed-in member to the file", async () => {
    const key = await upload(alice, "photo");
    await api("PUT", "/me/photo", alice.access, { key });

    // Bob may see Alice's photo: that is what a photo on a match card is.
    const response = await api("GET", `/photos/${alice.id}`, bob.access);
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toContain("sig=");
  });

  it("refuses an unauthenticated request", async () => {
    const key = await upload(alice, "photo");
    await api("PUT", "/me/photo", alice.access, { key });

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/photos/${alice.id}`,
    });
    expect(response.statusCode).toBe(401);
  });

  it("refuses a tampered signature on the file itself", async () => {
    const key = await upload(alice, "photo");
    await api("PUT", "/me/photo", alice.access, { key });

    const redirect = await api("GET", `/photos/${alice.id}`, bob.access);
    const url = new URL(redirect.headers.location as string);
    url.searchParams.set("sig", "0".repeat(64));

    const response = await app.inject({
      method: "GET",
      url: `${url.pathname}${url.search}`,
    });
    expect(response.statusCode).toBe(404);
  });
});
