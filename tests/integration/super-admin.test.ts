import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app/app.js";
import { connectToDatabase, disconnectFromDatabase } from "../../src/db/mongodb.js";
import {
  AdminInvitationModel,
  AreaModel,
  AuditLogModel,
  CampusModel,
  ConfigurationModel,
  InstitutionModel,
  InstitutionRequestModel,
  SessionModel,
  UserModel,
} from "../../src/db/models/index.js";
import { hashPassword, generateRefreshToken, hashToken } from "../../src/utils/crypto.js";
import { createSession, signAccessToken } from "../../src/modules/auth/token.service.js";

/**
 * Phase 11 gate: the Super Admin surface.
 *
 * Privilege escalation from every direction, re-authentication on
 * destructive actions, an activation checklist that reads reality rather than
 * tick-boxes, and invitations that work exactly once for exactly one person.
 */

let app: FastifyInstance;
let areaId: string;
let instA: string;
let campusA: string;

const PASSWORD = "the-super-admins-passphrase";

type Person = { access: string; id: string };
let superAdmin: Person;
let uniAdmin: Person;
let member: Person;

const call = (
  method: "GET" | "POST" | "PATCH" | "DELETE",
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

async function makeUser(email: string, role: string, institutionId = instA, campusId = campusA): Promise<Person> {
  const user = await UserModel.create({
    name: `${email.split("@")[0]} Person`,
    email,
    passwordHash: await hashPassword(PASSWORD),
    phone: "0300 1234567",
    userType: "teacher",
    institutionId,
    campusId,
    areaId,
    role,
    emailVerifiedAt: new Date(),
  });
  const session = await createSession({ userId: user._id });
  const access = await signAccessToken({
    sub: user._id.toString(),
    sid: session.sessionId,
    role,
    institutionId,
  });
  return { access, id: user._id.toString() };
}

async function newInstitution(overrides: Record<string, unknown> = {}) {
  return InstitutionModel.create({
    name: `Pilot Uni ${Date.now()}${Math.floor(Math.random() * 1000)}`,
    type: "university",
    city: "Karachi",
    brandColor: "#123456",
    emailDomains: ["pilot.edu.pk"],
    active: false,
    ...overrides,
  });
}

/** Invites directly in the database, returning the plain token. */
async function makeInvitation(email: string, institutionId: string, role = "universityAdmin") {
  const token = generateRefreshToken();
  await AdminInvitationModel.create({
    email,
    institutionId,
    role,
    tokenHash: hashToken(token),
    invitedBy: superAdmin.id,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  return token;
}

beforeAll(async () => {
  await connectToDatabase();
  app = await buildApp({ rateLimit: false });
  await app.ready();
  areaId = (await AreaModel.findOne({ name: "Gulshan-e-Iqbal" }))!._id.toString();
  instA = (await InstitutionModel.findOne({ name: "SZABIST University" }))!._id.toString();
  campusA = (await CampusModel.findOne({ institutionId: instA, name: "Clifton Campus" }))!._id.toString();
}, 60_000);

afterAll(async () => {
  await InstitutionModel.deleteMany({ name: /^Pilot Uni |^Fresh Uni / });
  await CampusModel.deleteMany({ name: /^Pilot Campus/ });
  await app.close();
  await disconnectFromDatabase();
});

beforeEach(async () => {
  await UserModel.deleteMany({ email: /@(szabist\.edu\.pk|pilot\.edu\.pk)$/ });
  await SessionModel.deleteMany({});
  await AdminInvitationModel.deleteMany({});
  await InstitutionRequestModel.deleteMany({});
  await AuditLogModel.collection.deleteMany({});
  await InstitutionModel.deleteMany({ name: /^Pilot Uni |^Fresh Uni / });
  await CampusModel.deleteMany({ name: /^Pilot Campus/ });

  superAdmin = await makeUser("super@szabist.edu.pk", "superAdmin");
  uniAdmin = await makeUser("uni@szabist.edu.pk", "universityAdmin");
  member = await makeUser("member@szabist.edu.pk", "member");
});

describe("privilege escalation", () => {
  const superRoutes: Array<["GET" | "POST", string]> = [
    ["GET", "/admin/platform/overview"],
    ["GET", "/admin/institutions"],
    ["POST", "/admin/institutions"],
    ["GET", "/admin/institution-requests"],
    ["GET", "/admin/admins"],
    ["POST", "/admin/admins"],
  ];

  for (const [method, url] of superRoutes) {
    it(`keeps a university admin out of ${method} ${url}`, async () => {
      const response = await call(method, url, uniAdmin.access, method === "POST" ? {} : undefined);
      expect(response.statusCode).toBe(403);
    });

    it(`keeps a member out of ${method} ${url}`, async () => {
      const response = await call(method, url, member.access, method === "POST" ? {} : undefined);
      expect(response.statusCode).toBe(403);
    });
  }

  it("does not let a university admin invite themselves up to super admin", async () => {
    const response = await call("POST", "/admin/admins", uniAdmin.access, {
      email: "uni@szabist.edu.pk",
      institutionId: instA,
      role: "superAdmin",
    });
    expect(response.statusCode).toBe(403);
    expect((await UserModel.findById(uniAdmin.id))!.role).toBe("universityAdmin");
  });

  it("does not grant a role through registration", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: {
        name: "Sneaky",
        email: "sneaky@szabist.edu.pk",
        password: "a-long-enough-passphrase",
        phone: "0300 1234567",
        userType: "student",
        institutionId: instA,
        campusId: campusA,
        areaId,
        role: "superAdmin",
      },
    });
    expect(response.statusCode).toBe(400);
  });

  it("does not grant a role through the profile", async () => {
    const response = await call("PATCH", "/me", member.access, { role: "superAdmin" });
    expect(response.statusCode).toBe(400);
    expect((await UserModel.findById(member.id))!.role).toBe("member");
  });

  it("does not honour a role claim the database disagrees with", async () => {
    // A validly signed token saying superAdmin, for somebody who is a member.
    const session = await createSession({ userId: (await UserModel.findById(member.id))!._id });
    const lying = await signAccessToken({ sub: member.id, sid: session.sessionId, role: "superAdmin", institutionId: instA });
    expect((await call("GET", "/admin/institutions", lying)).statusCode).toBe(403);
  });
});

describe("institutions", () => {
  it("creates an institution inactive, always", async () => {
    const response = await call("POST", "/admin/institutions", superAdmin.access, {
      name: "Fresh Uni One",
      type: "university",
      city: "Karachi",
      emailDomains: ["fresh.edu.pk"],
      brandColor: "#0C4DA1",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.active).toBe(false);
    expect(await AuditLogModel.countDocuments({ action: "institution.created" })).toBe(1);
  });

  it("refuses to be created live", async () => {
    const response = await call("POST", "/admin/institutions", superAdmin.access, {
      name: "Fresh Uni Two",
      type: "university",
      city: "Karachi",
      emailDomains: ["fresh2.edu.pk"],
      brandColor: "#0C4DA1",
      active: true,
    });
    expect(response.statusCode).toBe(400);
  });

  it("is Karachi only", async () => {
    const response = await call("POST", "/admin/institutions", superAdmin.access, {
      name: "Fresh Uni Lahore",
      type: "university",
      city: "Lahore",
      emailDomains: ["lhr.edu.pk"],
      brandColor: "#0C4DA1",
    });
    expect(response.statusCode).toBe(422);
  });

  it("refuses organisations while the feature flag is off", async () => {
    const flag = await ConfigurationModel.findOne({ key: "FEATURE_ORGANISATIONS" }).lean();
    expect(flag?.value).toBe(false);
    const response = await call("POST", "/admin/institutions", superAdmin.access, {
      name: "Fresh Uni Corp",
      type: "organisation",
      city: "Karachi",
      emailDomains: ["corp.com.pk"],
      brandColor: "#0C4DA1",
    });
    expect(response.statusCode).toBe(422);
  });

  it("refuses a duplicate name regardless of case", async () => {
    const response = await call("POST", "/admin/institutions", superAdmin.access, {
      name: "szabist university",
      type: "university",
      city: "Karachi",
      emailDomains: ["x.edu.pk"],
      brandColor: "#0C4DA1",
    });
    expect(response.statusCode).toBe(409);
  });
});

describe("activation checklist", () => {
  it("refuses to activate until the required items are done", async () => {
    const pilot = await newInstitution();
    const response = await call("POST", `/admin/institutions/${pilot._id}/activate`, superAdmin.access);
    expect(response.statusCode).toBe(409);
    expect(response.json().error.details.missingItems).toBe(6);
    expect((await InstitutionModel.findById(pilot._id))!.active).toBe(false);
  });

  it("does not accept a tick for things the database can check", async () => {
    const pilot = await newInstitution();
    const response = await call("PATCH", `/admin/institutions/${pilot._id}/checklist`, superAdmin.access, {
      logosUploaded: true,
      adminAssigned: true,
    });
    expect(response.statusCode).toBe(400);
  });

  it("derives logos, campuses and admin from reality, then activates", async () => {
    const pilot = await newInstitution({
      logoMarkUrl: "https://files.test/mark.png",
      logoWideUrl: "https://files.test/wide.png",
    });
    const campus = await CampusModel.create({ institutionId: pilot._id, name: "Pilot Campus Main" });

    await call("PATCH", `/admin/institutions/${pilot._id}/checklist`, superAdmin.access, {
      contacted: true,
      campusesConfirmed: true,
      emailDomainsConfirmed: true,
      brandColorConfirmed: true,
    });

    // Everything ticked, but no admin yet: still not ready.
    const notYet = await call("POST", `/admin/institutions/${pilot._id}/activate`, superAdmin.access);
    expect(notYet.statusCode).toBe(409);
    expect(notYet.json().error.details.missingItems).toBe(1);

    // An invited admin registers INTO the still-inactive institution.
    const token = await makeInvitation("head@pilot.edu.pk", pilot._id.toString());
    const registered = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register-invited",
      payload: {
        token,
        name: "Head Admin",
        password: "a-long-enough-passphrase",
        phone: "0300 7654321",
        campusId: campus._id.toString(),
        areaId,
        userType: "teacher",
      },
    });
    expect(registered.statusCode).toBe(200);
    expect(registered.json().data.user.role).toBe("universityAdmin");

    const live = await call("POST", `/admin/institutions/${pilot._id}/activate`, superAdmin.access);
    expect(live.statusCode).toBe(200);
    expect(live.json().data.active).toBe(true);
    expect(await AuditLogModel.countDocuments({ action: "institution.activated" })).toBe(1);

    // The institution now appears in the public picker.
    const picker = await app.inject({ method: "GET", url: "/api/v1/institutions" });
    expect(picker.json().data.map((i: { id: string }) => i.id)).toContain(pilot._id.toString());

    await pilot.deleteOne();
  });

  it("treats demand as advisory, never as a gate", async () => {
    const pilot = await newInstitution();
    const detail = await call("GET", `/admin/institutions/${pilot._id}`, superAdmin.access);
    const interest = detail.json().data.checklist.find((i: { key: string }) => i.key === "interest");
    // Registration refuses inactive institutions, so real signups before
    // launch are impossible. Blocking on them would make activation impossible.
    expect(interest.required).toBe(false);
  });
});

describe("deactivation", () => {
  it("requires the admin's password", async () => {
    const pilot = await newInstitution({ active: true });

    const noPassword = await call("POST", `/admin/institutions/${pilot._id}/deactivate`, superAdmin.access, {
      reason: "Pausing the launch",
    });
    expect(noPassword.statusCode).toBe(400);

    const wrong = await call("POST", `/admin/institutions/${pilot._id}/deactivate`, superAdmin.access, {
      password: "not-the-password",
      reason: "Pausing the launch",
    });
    expect(wrong.statusCode).toBe(401);
    expect((await InstitutionModel.findById(pilot._id))!.active).toBe(true);

    const right = await call("POST", `/admin/institutions/${pilot._id}/deactivate`, superAdmin.access, {
      password: PASSWORD,
      reason: "Pausing the launch",
    });
    expect(right.statusCode).toBe(200);
    expect(right.json().data.active).toBe(false);
  });
});

describe("institution requests", () => {
  it("groups requests by name so demand is visible", async () => {
    for (const email of ["a@x.pk", "b@x.pk", "c@x.pk"]) {
      await InstitutionRequestModel.create({ name: "Habib University", type: "university", requestedByEmail: email });
    }
    await InstitutionRequestModel.create({ name: "habib university ", type: "university", requestedByEmail: "d@x.pk" });

    const response = await call("GET", "/admin/institution-requests", superAdmin.access);
    const habib = response.json().data.find((g: { name: string }) => /habib/i.test(g.name));
    expect(habib.requests).toBe(4);
    // Requesters did not ask to be contacted from this queue.
    expect(response.body).not.toContain("@x.pk");
  });

  it("approving never creates an institution", async () => {
    await InstitutionRequestModel.create({ name: "Never Auto Uni", type: "university", requestedByEmail: "a@x.pk" });
    const before = await InstitutionModel.countDocuments({});

    const response = await call("POST", "/admin/institution-requests/decision", superAdmin.access, {
      name: "Never Auto Uni",
      approve: true,
    });
    expect(response.json().data.status).toBe("approved");
    expect(await InstitutionModel.countDocuments({})).toBe(before);
  });
});

describe("administrators", () => {
  it("invites without ever returning the token", async () => {
    const response = await call("POST", "/admin/admins", superAdmin.access, {
      email: "newadmin@szabist.edu.pk",
      institutionId: instA,
      role: "universityAdmin",
    });
    expect(response.statusCode).toBe(200);
    // The token exists only in the invited inbox and as a digest.
    expect(Object.keys(response.json().data)).not.toContain("token");
    expect(response.body).not.toMatch(/[A-Za-z0-9_-]{40,}/);
    const stored = await AdminInvitationModel.findOne({ email: "newadmin@szabist.edu.pk" }).select("+tokenHash").lean();
    expect(stored!.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(await AuditLogModel.countDocuments({ action: "admin.invited" })).toBe(1);
  });

  it("refuses an address outside the institution's domains", async () => {
    const response = await call("POST", "/admin/admins", superAdmin.access, {
      email: "someone@gmail.com",
      institutionId: instA,
      role: "universityAdmin",
    });
    expect(response.statusCode).toBe(422);
  });

  it("an invitation works exactly once", async () => {
    const token = await makeInvitation("member@szabist.edu.pk", instA);

    const first = await call("POST", "/admin/invitations/accept", member.access, { token });
    expect(first.statusCode).toBe(200);
    expect((await UserModel.findById(member.id))!.role).toBe("universityAdmin");

    const second = await call("POST", "/admin/invitations/accept", member.access, { token });
    expect(second.statusCode).toBe(404);
  });

  it("an invitation only works for the address it was sent to", async () => {
    const token = await makeInvitation("somebody-else@szabist.edu.pk", instA);
    // The member holds the link but is not the person it was sent to.
    const response = await call("POST", "/admin/invitations/accept", member.access, { token });
    expect(response.statusCode).toBe(404);
    expect((await UserModel.findById(member.id))!.role).toBe("member");
  });

  it("an expired invitation is refused with the same message as a bogus one", async () => {
    const token = await makeInvitation("member@szabist.edu.pk", instA);
    await AdminInvitationModel.updateMany({}, { $set: { expiresAt: new Date(Date.now() - 1000) } });

    const expired = await call("POST", "/admin/invitations/accept", member.access, { token });
    const bogus = await call("POST", "/admin/invitations/accept", member.access, {
      token: generateRefreshToken(),
    });
    expect(expired.statusCode).toBe(404);
    expect(expired.json().error.message).toBe(bogus.json().error.message);
  });

  it("re-inviting revokes the earlier link", async () => {
    await call("POST", "/admin/admins", superAdmin.access, {
      email: "member@szabist.edu.pk",
      institutionId: instA,
      role: "universityAdmin",
    });
    await call("POST", "/admin/admins", superAdmin.access, {
      email: "member@szabist.edu.pk",
      institutionId: instA,
      role: "universityAdmin",
    });
    expect(await AdminInvitationModel.countDocuments({ email: "member@szabist.edu.pk", revokedAt: null })).toBe(1);
  });

  it("removing an admin requires the password and keeps their account", async () => {
    const wrong = await call("POST", `/admin/admins/${uniAdmin.id}/remove`, superAdmin.access, {
      password: "wrong-password-here",
    });
    expect(wrong.statusCode).toBe(401);

    const right = await call("POST", `/admin/admins/${uniAdmin.id}/remove`, superAdmin.access, {
      password: PASSWORD,
    });
    expect(right.statusCode).toBe(204);
    const after = await UserModel.findById(uniAdmin.id);
    // Losing admin rights must not cost somebody their commute.
    expect(after!.role).toBe("member");
    expect(after!.suspendedAt).toBeNull();
    // And their admin access ends immediately.
    expect((await call("GET", "/admin/me", uniAdmin.access)).statusCode).toBe(403);
  });

  it("will not let an admin remove themselves", async () => {
    const response = await call("POST", `/admin/admins/${superAdmin.id}/remove`, superAdmin.access, {
      password: PASSWORD,
    });
    expect(response.statusCode).toBe(422);
  });

  it("two super admins removing each other at once leave exactly one", async () => {
    // The real hazard. Counting "the others" then demoting is read-then-write:
    // run concurrently, each counts the other as remaining, both pass, and
    // the platform is left with nobody who can appoint anyone.
    await UserModel.updateOne({ _id: uniAdmin.id }, { $set: { role: "member" } });
    const second = await makeUser("super2@szabist.edu.pk", "superAdmin");

    const [a, b] = await Promise.all([
      call("POST", `/admin/admins/${second.id}/remove`, superAdmin.access, { password: PASSWORD }),
      call("POST", `/admin/admins/${superAdmin.id}/remove`, second.access, { password: PASSWORD }),
    ]);

    const remaining = await UserModel.countDocuments({ role: "superAdmin", suspendedAt: null });
    expect(remaining).toBe(1);
    // Exactly one removal succeeded; the other was refused, whether by the
    // last-admin guard or because its caller had just lost the role.
    expect([a.statusCode, b.statusCode].filter((code) => code === 204)).toHaveLength(1);
  }, 60_000);
});

describe("platform overview", () => {
  it("returns platform-wide counters to a super admin", async () => {
    const response = await call("GET", "/admin/platform/overview", superAdmin.access);
    expect(response.statusCode).toBe(200);
    const data = response.json().data;
    expect(data.liveInstitutions).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(data.quietInstitutions)).toBe(true);
  });
});
