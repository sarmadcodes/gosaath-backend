import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app/app.js";
import { connectToDatabase, disconnectFromDatabase } from "../../src/db/mongodb.js";
import {
  AreaModel,
  CampusModel,
  InstitutionModel,
  InstitutionRequestModel,
  PreferencesModel,
  PushTokenModel,
  SessionModel,
  UserModel,
  VehicleModel,
} from "../../src/db/models/index.js";

/**
 * Phase 3 gate.
 *
 * The contract types `me.update` as `Partial<User>`, which includes `role`,
 * `institutionId` and `badgeStatus`. Most of this file exists to prove the
 * server does not take that literally.
 */

let app: FastifyInstance;
let institutionId: string;
let campusId: string;
let areaId: string;

/** Two accounts, so "can I touch someone else's row?" is answerable. */
let alice = { token: "", access: "", id: "" };
let bob = { token: "", access: "", id: "" };

const api = (
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
  url: string,
  token: string,
  payload?: Record<string, unknown>,
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
      name: "Test Person",
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
  const token = login.json().data.token as string;

  const refresh = await app.inject({
    method: "POST",
    url: "/api/v1/auth/refresh",
    payload: { token },
  });
  const access = refresh.json().data.accessToken as string;

  const user = await UserModel.findOne({ email });
  return { token, access, id: user!._id.toString() };
}

beforeAll(async () => {
  await connectToDatabase();
  app = await buildApp({ rateLimit: false });
  await app.ready();

  institutionId = (await InstitutionModel.findOne({ name: "SZABIST University" }))!._id.toString();
  campusId = (await CampusModel.findOne({ name: "Clifton Campus" }))!._id.toString();
  areaId = (await AreaModel.findOne({ name: "Gulshan-e-Iqbal" }))!._id.toString();
}, 60_000);

afterAll(async () => {
  await app.close();
  await disconnectFromDatabase();
});

beforeEach(async () => {
  await UserModel.deleteMany({ email: /@szabist\.edu\.pk$/ });
  await SessionModel.deleteMany({});
  await VehicleModel.deleteMany({});
  await PreferencesModel.deleteMany({});

  alice = await makeUser("alice@szabist.edu.pk");
  bob = await makeUser("bob@szabist.edu.pk");
});

describe("authentication gate", () => {
  it("refuses a request with no token", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/me" });
    expect(response.statusCode).toBe(401);
  });

  it("refuses a forged token", async () => {
    const response = await api("GET", "/me", "not.a.real.token");
    expect(response.statusCode).toBe(401);
  });

  it("refuses the refresh token used as a bearer", async () => {
    // These are different credentials with different lifetimes. A refresh
    // token accepted as a bearer would defeat the short access-token life.
    const response = await api("GET", "/me", alice.token);
    expect(response.statusCode).toBe(401);
  });

  it("returns the caller's own account", async () => {
    const response = await api("GET", "/me", alice.access);
    expect(response.statusCode).toBe(200);
    expect(response.json().data.email).toBe("alice@szabist.edu.pk");
  });

  it("never includes the password hash", async () => {
    const response = await api("GET", "/me", alice.access);
    expect(response.body).not.toContain("passwordHash");
    expect(response.body).not.toContain("$argon2");
  });
});

describe("mass assignment", () => {
  for (const [field, value] of [
    ["role", "superAdmin"],
    ["badgeStatus", "approved"],
    ["institutionId", "6aacdce2048d5e8d0d29dbd7"],
    ["campusId", "6aacdce2048d5e8d0d29dbd8"],
    ["email", "attacker@szabist.edu.pk"],
    ["emailVerifiedAt", "2020-01-01T00:00:00.000Z"],
    ["suspendedAt", null],
  ] as const) {
    it(`rejects an attempt to set ${field}`, async () => {
      const response = await api("PATCH", "/me", alice.access, {
        name: "Legitimate Change",
        [field]: value,
      });

      // 400, not a 200 that quietly ignored it. Silent dropping hides the
      // attempt, and an attacker probing for what sticks learns nothing from
      // a success that did nothing.
      expect(response.statusCode).toBe(400);
      expect(response.json().error.message).toBeTruthy();
    });
  }

  it("does not apply the legitimate part of a rejected patch", async () => {
    await api("PATCH", "/me", alice.access, {
      name: "Should Not Stick",
      role: "superAdmin",
    });

    const user = await UserModel.findById(alice.id);
    expect(user!.name).toBe("Test Person");
    expect(user!.role).toBe("member");
  });

  it("allows the four fields a member actually owns", async () => {
    const otherArea = await AreaModel.findOne({ name: "Clifton" });
    const response = await api("PATCH", "/me", alice.access, {
      name: "Alice Updated",
      phone: "0321 7654321",
      areaId: otherArea!._id.toString(),
      photoUrl: "https://example.com/photo.jpg",
    });

    expect(response.statusCode).toBe(200);
    const data = response.json().data;
    expect(data.name).toBe("Alice Updated");
    expect(data.areaId).toBe(otherArea!._id.toString());
    // Returns the whole updated object, which is what the client re-renders
    // from — not { ok: true }.
    expect(data.email).toBe("alice@szabist.edu.pk");
  });

  it("refuses an area that does not exist", async () => {
    // An unknown area would silently break matching: the commute points at
    // nothing and the person simply never appears to anybody.
    const response = await api("PATCH", "/me", alice.access, {
      areaId: "6aacdce1048d5e8d0d29dbff",
    });
    expect(response.statusCode).toBe(422);
  });
});

describe("badge", () => {
  /**
   * The document is a real upload now, not a URL: a URL would let anyone
   * point their badge at any address on the internet. The upload flow itself
   * is covered in uploads.test.ts; here it is just the shortest way to get a
   * key that exists.
   */
  async function uploadCard(who: { access: string }): Promise<string> {
    const signed = await api("POST", "/uploads/sign", who.access, {
      kind: "badge",
      contentType: "image/jpeg",
      bytes: 1024,
    });
    const target = signed.json().data as { url: string; key: string };
    await app.inject({
      method: "PUT",
      url: target.url.replace(/^https?:\/\/[^/]+/, ""),
      headers: { "content-type": "image/jpeg" },
      payload: Buffer.from("card"),
    });
    return target.key;
  }

  it("moves to pending and never self-approves", async () => {
    const response = await api("POST", "/me/badge", alice.access, {
      key: await uploadCard(alice),
    });

    expect(response.statusCode).toBe(200);
    // One badge, reviewed by a person. There is no path from "requested" to
    // "approved" that does not go through an admin.
    expect(response.json().data.badgeStatus).toBe("pending");
  });

  it("never returns the submitted identity document", async () => {
    const key = await uploadCard(alice);
    await api("POST", "/me/badge", alice.access, { key });
    const response = await api("GET", "/me", alice.access);

    // select:false on the model. It is an identity document and has no
    // business in a response that merely happens to load a user.
    expect(response.body).not.toContain(key);
    expect(response.body).not.toContain("badgeDocumentUrl");
  });

  it("refuses a second request while one is in review", async () => {
    await api("POST", "/me/badge", alice.access, { key: await uploadCard(alice) });
    const second = await api("POST", "/me/badge", alice.access, {
      key: await uploadCard(alice),
    });
    expect(second.statusCode).toBe(409);
  });
});

describe("preferences", () => {
  it("returns defaults before anything is saved", async () => {
    const response = await api("GET", "/preferences", alice.access);
    expect(response.statusCode).toBe(200);
    // Not a 404: somebody who has never opened the screen still has
    // preferences, and they are the defaults.
    expect(response.json().data.sameCampusOnly).toBe(true);
  });

  it("writes through and is idempotent", async () => {
    const first = await api("PATCH", "/preferences", alice.access, { womenOnly: true });
    const second = await api("PATCH", "/preferences", alice.access, { womenOnly: true });

    expect(first.json().data.womenOnly).toBe(true);
    expect(second.json().data.womenOnly).toBe(true);
    expect(await PreferencesModel.countDocuments({ userId: alice.id })).toBe(1);
  });

  it("keeps two people's preferences apart", async () => {
    await api("PATCH", "/preferences", alice.access, { womenOnly: true });
    const bobs = await api("GET", "/preferences", bob.access);
    expect(bobs.json().data.womenOnly).toBe(false);
  });

  it("rejects an unknown preference key", async () => {
    const response = await api("PATCH", "/preferences", alice.access, {
      giveMeEverything: true,
    });
    expect(response.statusCode).toBe(400);
  });
});

describe("institutions", () => {
  it("lists only active institutions", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/institutions",
    });

    const names = response.json().data.map((i: { name: string }) => i.name);
    // Rule 7: SZABIST only for now. The other 24 are seeded but must be
    // invisible until the activation checklist has been through them.
    expect(names).toEqual(["SZABIST University"]);
  });

  it("does not let a search pattern match everything", async () => {
    // Unescaped, ".*" would return the lot — including inactive institutions
    // if the filter ever slipped.
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/institutions?q=" + encodeURIComponent(".*"),
    });
    expect(response.json().data).toEqual([]);
  });

  it("creates a pending request, never an institution", async () => {
    const before = await InstitutionModel.countDocuments({});

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/institution-requests",
      payload: {
        name: "Totally Real University",
        type: "university",
        requestedByEmail: "someone@example.com",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.status).toBe("pending");
    // A user-submitted institution becoming live would be a way to conjure a
    // community with unverified email domains and register into it.
    expect(await InstitutionModel.countDocuments({})).toBe(before);

    await InstitutionRequestModel.deleteMany({ name: "Totally Real University" });
  });

  it("refuses campuses for an institution that is not live", async () => {
    const inactive = await InstitutionModel.create({
      name: `Hidden ${Date.now()}`,
      type: "university",
      city: "Karachi",
      brandColor: "#112233",
      active: false,
    });
    try {
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/institutions/${inactive._id.toString()}/campuses`,
      });
      expect(response.statusCode).toBe(404);
    } finally {
      await inactive.deleteOne();
    }
  });
});

describe("areas", () => {
  it("never returns a centroid", async () => {
    const response = await api("GET", "/areas", alice.access);

    expect(response.statusCode).toBe(200);
    expect(response.json().data.length).toBeGreaterThanOrEqual(16);
    // The centroid decides what counts as nearby. Shipping it would turn an
    // area-level product into one that hands out coordinates.
    expect(response.body).not.toContain("centroid");
    expect(response.body).not.toContain("lat");
    expect(response.body).not.toContain("lng");
  });
});

describe("deleting the account", () => {
  const api = (method: "DELETE", url: string, token: string, payload?: object) =>
    app.inject({
      method,
      url: `/api/v1${url}`,
      headers: { authorization: `Bearer ${token}` },
      ...(payload ? { payload } : {}),
    });

  it("refuses without the right password", async () => {
    const response = await api("DELETE", "/me", alice.access, {
      password: "not-the-password",
    });
    expect(response.statusCode).toBe(401);

    const still = await UserModel.findById(alice.id);
    expect(still!.deletedAt).toBeNull();
  });

  it("removes what identifies a person and keeps the row", async () => {
    const response = await api("DELETE", "/me", alice.access, {
      password: "a-long-enough-passphrase",
    });
    expect(response.statusCode).toBe(204);

    // SYSTEM.md 4.5.8. The row survives because reports, blocks and audit
    // entries point at it; a hard delete would erase a safety record, which
    // would make deleting your account the way to undo what you did.
    const after = await UserModel.findById(alice.id).select("+badgeDocumentUrl");
    expect(after).not.toBeNull();
    expect(after!.deletedAt).not.toBeNull();
    expect(after!.name).toBe("Former member");
    // Not an empty string: the schema requires a phone, and "every member has
    // a number" is worth keeping. It is not a dialable one.
    expect(after!.phone).toBe("removed");
    expect(after!.photoUrl).toBeNull();
    expect(after!.badgeDocumentUrl).toBeNull();
    expect(after!.email).not.toContain("szabist");
  });

  it("locks the account out everywhere", async () => {
    await api("DELETE", "/me", alice.access, {
      password: "a-long-enough-passphrase",
    });

    // Every session is gone, so the refresh token in the app is worthless.
    expect(await SessionModel.countDocuments({ userId: alice.id })).toBe(0);

    const restored = await app.inject({
      method: "POST",
      url: "/api/v1/auth/restore",
      payload: { token: alice.token },
    });
    expect(restored.json().data).toBeNull();

    // And the old password cannot be used to sign back in.
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "alice@szabist.edu.pk", password: "a-long-enough-passphrase" },
    });
    expect(login.statusCode).toBeGreaterThanOrEqual(400);
  });

  it("takes the vehicles and push tokens with it", async () => {
    await VehicleModel.create({
      ownerId: alice.id,
      type: "car",
      model: "Toyota Corolla",
      plate: "BKT-512",
      colour: "White",
    });

    await api("DELETE", "/me", alice.access, {
      password: "a-long-enough-passphrase",
    });

    expect(await VehicleModel.countDocuments({ ownerId: alice.id })).toBe(0);
    expect(await PushTokenModel.countDocuments({ userId: alice.id })).toBe(0);
  });

  it("is safe to ask for twice", async () => {
    const first = await api("DELETE", "/me", alice.access, {
      password: "a-long-enough-passphrase",
    });
    expect(first.statusCode).toBe(204);

    // The access token is still valid for its remaining minutes, and a
    // retry must not throw at somebody who has already gone.
    const second = await api("DELETE", "/me", alice.access, {
      password: "a-long-enough-passphrase",
    });
    expect(second.statusCode).toBe(204);
  });
});

describe("a deleted account and the admin views", () => {
  it("stops being counted as a member", async () => {
    // Found by a test failing for the right reason: deleted accounts kept
    // their row, and the row kept turning up in the institution's member
    // count. Somebody who left is not a member, and counting them overstates
    // the pilot to the people deciding whether it worked.
    const before = await UserModel.countDocuments({
      institutionId,
      emailVerifiedAt: { $ne: null },
      deletedAt: null,
    });

    await app.inject({
      method: "DELETE",
      url: "/api/v1/me",
      headers: { authorization: `Bearer ${alice.access}` },
      payload: { password: "a-long-enough-passphrase" },
    });

    expect(
      await UserModel.countDocuments({
        institutionId,
        emailVerifiedAt: { $ne: null },
        deletedAt: null,
      }),
    ).toBe(before - 1);

    // The row itself is still there, holding the safety history together.
    expect(await UserModel.countDocuments({ _id: alice.id })).toBe(1);
  });
});
