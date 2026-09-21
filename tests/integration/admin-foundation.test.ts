import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { Types } from "mongoose";
import { buildApp } from "../../src/app/app.js";
import { connectToDatabase, disconnectFromDatabase } from "../../src/db/mongodb.js";
import {
  AreaModel,
  AuditLogModel,
  CampusModel,
  InstitutionModel,
  SessionModel,
  UserModel,
} from "../../src/db/models/index.js";
import { recordAudit } from "../../src/modules/audit/audit.service.js";
import { assertInScope, scopeFilter } from "../../src/middleware/admin.js";

/**
 * Phase 9 gate: the foundation every admin route will stand on.
 *
 * Roles gate access, revocation is immediate, the audit log cannot be edited,
 * secrets never reach it, and a university admin's scope cannot be widened.
 */

let app: FastifyInstance;
let institutionId: string;
let campusId: string;
let areaId: string;
type Person = { access: string; id: string };
let member: Person;
let uniAdmin: Person;
let superAdmin: Person;

const get = (url: string, token: string) =>
  app.inject({
    method: "GET",
    url: `/api/v1${url}`,
    headers: { authorization: `Bearer ${token}` },
  });

async function makeUser(email: string, role: string): Promise<Person> {
  await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: {
      name: `${email.split("@")[0]} Person`,
      email,
      password: "a-long-enough-passphrase",
      phone: "0300 1234567",
      userType: "teacher",
      institutionId,
      campusId,
      areaId,
    },
  });
  // Roles are assigned directly: there is deliberately no API a member can
  // use to give themselves one, and admin invitations arrive in Phase 11.
  await UserModel.updateOne({ email }, { $set: { emailVerifiedAt: new Date(), role } });

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
  return { access: refresh.json().data.accessToken as string, id: user!._id.toString() };
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
  // The raw collection, because the model refuses deletes by design.
  await AuditLogModel.collection.deleteMany({});

  member = await makeUser("member@szabist.edu.pk", "member");
  uniAdmin = await makeUser("uniadmin@szabist.edu.pk", "universityAdmin");
  superAdmin = await makeUser("super@szabist.edu.pk", "superAdmin");
});

describe("role gates", () => {
  it("keeps members out of the admin area", async () => {
    expect((await get("/admin/me", member.access)).statusCode).toBe(403);
    expect((await get("/admin/audit", member.access)).statusCode).toBe(403);
  });

  it("gives a university admin an institution scope", async () => {
    const response = await get("/admin/me", uniAdmin.access);
    expect(response.statusCode).toBe(200);
    expect(response.json().data.scope).toEqual({ kind: "institution", institutionId });
  });

  it("gives a super admin the platform scope", async () => {
    const response = await get("/admin/me", superAdmin.access);
    expect(response.json().data.scope).toEqual({ kind: "platform" });
  });

  it("keeps the platform audit log from university admins", async () => {
    // It spans every institution. Their own actions are recorded in it, not
    // reviewed through it.
    expect((await get("/admin/audit", uniAdmin.access)).statusCode).toBe(403);
    expect((await get("/admin/audit", superAdmin.access)).statusCode).toBe(200);
  });

  it("refuses an unauthenticated request", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/admin/me" });
    expect(response.statusCode).toBe(401);
  });
});

describe("revocation", () => {
  it("takes effect on the very next request, with the same token", async () => {
    expect((await get("/admin/me", uniAdmin.access)).statusCode).toBe(200);

    await UserModel.updateOne({ _id: uniAdmin.id }, { $set: { role: "member" } });

    // The token still says universityAdmin and is valid for another quarter
    // of an hour. The role is read from the database, so it no longer matters.
    expect((await get("/admin/me", uniAdmin.access)).statusCode).toBe(403);
  });

  it("locks out a suspended admin", async () => {
    await UserModel.updateOne({ _id: superAdmin.id }, { $set: { suspendedAt: new Date() } });
    expect((await get("/admin/me", superAdmin.access)).statusCode).toBe(401);
  });

  it("cannot be bypassed by a forged role claim", async () => {
    // A member's genuine token carries role "member"; the middleware ignores
    // the claim entirely, so there is nothing to gain by tampering with it.
    const forged = member.access.split(".").slice(0, 2).join(".") + ".invalidsignature";
    expect((await get("/admin/me", forged)).statusCode).toBe(401);
  });
});

describe("the audit log", () => {
  const actor = () => ({ userId: superAdmin.id, role: "superAdmin" as const });

  it("records an entry that the super admin can read", async () => {
    await recordAudit({
      actor: actor(),
      action: "institution.activated",
      targetType: "institution",
      targetId: institutionId,
      institutionId,
    });

    const response = await get("/admin/audit", superAdmin.access);
    expect(response.json().data).toHaveLength(1);
    expect(response.json().data[0].action).toBe("institution.activated");
  });

  it("cannot be edited", async () => {
    await recordAudit({ actor: actor(), action: "member.suspended", targetType: "user" });
    const entry = await AuditLogModel.findOne({});

    await expect(
      AuditLogModel.updateOne({ _id: entry!._id }, { $set: { action: "nothing.happened" } }),
    ).rejects.toThrow(/append-only/);
    await expect(
      AuditLogModel.findOneAndUpdate({ _id: entry!._id }, { $set: { targetType: "x" } }),
    ).rejects.toThrow(/append-only/);

    entry!.set({ action: "nothing.happened" });
    await expect(entry!.save()).rejects.toThrow(/append-only/);
  });

  it("cannot be deleted", async () => {
    await recordAudit({ actor: actor(), action: "admin.removed", targetType: "user" });
    await expect(AuditLogModel.deleteMany({})).rejects.toThrow(/append-only/);
    await expect(AuditLogModel.deleteOne({})).rejects.toThrow(/append-only/);
    expect(await AuditLogModel.countDocuments({})).toBe(1);
  });

  it("never stores a secret in metadata, however deeply nested", async () => {
    await recordAudit({
      actor: actor(),
      action: "configuration.changed",
      targetType: "configuration",
      metadata: {
        key: "NEARBY_RADIUS_KM",
        password: "hunter2hunter2",
        nested: { refreshToken: "abc", otp: "123456", note: "kept" },
        phone: "0300 1234567",
      },
    });

    const raw = JSON.stringify(await AuditLogModel.findOne({}).lean());
    for (const secret of ["hunter2hunter2", "123456", "0300 1234567"]) {
      expect(raw).not.toContain(secret);
    }
    // Harmless context survives.
    expect(raw).toContain("NEARBY_RADIUS_KM");
    expect(raw).toContain("kept");
  });

  it("pages with a cursor rather than an offset", async () => {
    for (let i = 0; i < 5; i++) {
      await recordAudit({ actor: actor(), action: "campus.updated", targetType: "campus" });
    }

    const first = (await get("/admin/audit?limit=2", superAdmin.access)).json();
    expect(first.data).toHaveLength(2);
    expect(first.meta.nextCursor).toBeTruthy();

    const second = (
      await get(`/admin/audit?limit=2&before=${first.meta.nextCursor}`, superAdmin.access)
    ).json();
    expect(second.data).toHaveLength(2);
    // No overlap between pages.
    const ids = new Set([...first.data, ...second.data].map((e: { id: string }) => e.id));
    expect(ids.size).toBe(4);
  });

  it("rejects an unknown filter rather than passing it to the query", async () => {
    // A query string must never become arbitrary Mongo operators.
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/admin/audit?actorRole[$ne]=x",
      headers: { authorization: `Bearer ${superAdmin.access}` },
    });
    expect(response.statusCode).toBe(400);
  });
});

describe("scope helpers", () => {
  it("pins a university admin's filter to their own institution", () => {
    const filter = scopeFilter({ kind: "institution", institutionId });
    expect(filter.institutionId?.toString()).toBe(institutionId);
  });

  it("cannot be widened by a caller-supplied institution", () => {
    const fromRequest = { institutionId: new Types.ObjectId() };
    // Spread last, as every admin query must: the scope wins.
    const query = { ...fromRequest, ...scopeFilter({ kind: "institution", institutionId }) };
    expect(query.institutionId.toString()).toBe(institutionId);
  });

  it("returns an empty filter for the platform scope", () => {
    expect(scopeFilter({ kind: "platform" })).toEqual({});
  });

  it("refuses an out-of-scope resource with 404, not 403", () => {
    const other = new Types.ObjectId().toString();
    try {
      assertInScope({ kind: "institution", institutionId }, other);
      throw new Error("should have thrown");
    } catch (error) {
      // A 403 would confirm the resource exists in another institution.
      expect((error as { statusCode?: number }).statusCode).toBe(404);
    }
    expect(() => assertInScope({ kind: "platform" }, other)).not.toThrow();
    expect(() => assertInScope({ kind: "institution", institutionId }, institutionId)).not.toThrow();
  });
});
