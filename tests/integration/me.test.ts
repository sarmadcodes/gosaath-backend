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
  it("moves to pending and never self-approves", async () => {
    const response = await api("POST", "/me/badge", alice.access, {
      documentUri: "https://example.com/id.jpg",
    });

    expect(response.statusCode).toBe(200);
    // One badge, reviewed by a person. There is no path from "requested" to
    // "approved" that does not go through an admin.
    expect(response.json().data.badgeStatus).toBe("pending");
  });

  it("never returns the submitted identity document", async () => {
    await api("POST", "/me/badge", alice.access, {
      documentUri: "https://example.com/secret-id-card.jpg",
    });
    const response = await api("GET", "/me", alice.access);

    // select:false on the model. It is an identity document and has no
    // business in a response that merely happens to load a user.
    expect(response.body).not.toContain("secret-id-card");
    expect(response.body).not.toContain("badgeDocumentUrl");
  });

  it("refuses a second request while one is in review", async () => {
    await api("POST", "/me/badge", alice.access, {
      documentUri: "https://example.com/id.jpg",
    });
    const second = await api("POST", "/me/badge", alice.access, {
      documentUri: "https://example.com/other.jpg",
    });
    expect(second.statusCode).toBe(409);
  });
});

describe("vehicles", () => {
  const car = {
    type: "car" as const,
    model: "Toyota Corolla GLi",
    plate: "ABC-123",
    colour: "White",
  };

  it("creates and lists only the caller's own", async () => {
    await api("PUT", "/vehicles", alice.access, car);
    await api("PUT", "/vehicles", bob.access, { ...car, plate: "XYZ-999" });

    const mine = await api("GET", "/vehicles", alice.access);
    expect(mine.json().data).toHaveLength(1);
    expect(mine.json().data[0].plate).toBe("ABC-123");
  });

  it("cannot edit somebody else's vehicle", async () => {
    const created = await api("PUT", "/vehicles", alice.access, car);
    const id = created.json().data.id as string;

    const attempt = await api("PUT", "/vehicles", bob.access, {
      ...car,
      id,
      model: "Stolen",
    });

    // 404, not 403: a 403 would confirm the id is real and owned by somebody.
    expect(attempt.statusCode).toBe(404);

    const unchanged = await VehicleModel.findById(id);
    expect(unchanged!.model).toBe("Toyota Corolla GLi");
  });

  it("cannot delete somebody else's vehicle", async () => {
    const created = await api("PUT", "/vehicles", alice.access, car);
    const id = created.json().data.id as string;

    const attempt = await api("DELETE", `/vehicles/${id}`, bob.access);
    expect(attempt.statusCode).toBe(404);
    expect(await VehicleModel.countDocuments({ _id: id })).toBe(1);
  });

  it("cannot claim ownership through the body", async () => {
    const response = await api("PUT", "/vehicles", alice.access, {
      ...car,
      ownerId: bob.id,
    });
    expect(response.statusCode).toBe(400);
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
