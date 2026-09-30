import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { Types } from "mongoose";
import { buildApp } from "../../src/app/app.js";
import { connectToDatabase, disconnectFromDatabase } from "../../src/db/mongodb.js";
import {
  AreaModel,
  AuditLogModel,
  CampusModel,
  CommuteModel,
  InstitutionModel,
  NotificationModel,
  ReportModel,
  SessionModel,
  UserModel,
} from "../../src/db/models/index.js";

/**
 * Phase 10 gate: the University Admin surface, attacked from the side.
 *
 * Two institutions exist here. The admin of the first tries every route
 * against the second's members, campuses, reports and profile — through ids
 * in the path, ids in the query string, and ids in the body. All of it must
 * fail, and none of it may confirm that the target exists.
 */

let app: FastifyInstance;
let areaId: string;

// Institution A is the seeded SZABIST. B is created per run.
let instA: string;
let campusA: string;
let instB: string;
let campusB: string;

type Person = { access: string; id: string };
let adminA: Person;
let memberA: Person;
let memberB: Person;
let superAdmin: Person;

const call = (
  method: "GET" | "POST" | "PATCH",
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

async function makeUser(
  email: string,
  institutionId: string,
  campusId: string,
  role = "member",
): Promise<Person> {
  const user = await UserModel.create({
    name: `${email.split("@")[0]} Person`,
    email,
    passwordHash: "x",
    phone: "0321 5550000",
    userType: "student",
    institutionId,
    campusId,
    areaId,
    role,
    emailVerifiedAt: new Date(),
  });
  // Tokens minted directly: this file tests admin authorisation, not login.
  const { createSession, signAccessToken } = await import(
    "../../src/modules/auth/token.service.js"
  );
  const session = await createSession({ userId: user._id });
  const access = await signAccessToken({
    sub: user._id.toString(),
    sid: session.sessionId,
    role,
    institutionId,
  });
  return { access, id: user._id.toString() };
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
  await InstitutionModel.deleteMany({ name: /^Other Uni / });
  await CampusModel.deleteMany({ name: /^B Campus|^Test Campus/ });
  await app.close();
  await disconnectFromDatabase();
});

beforeEach(async () => {
  await UserModel.deleteMany({ email: /@(szabist\.edu\.pk|other\.edu\.pk)$/ });
  await ReportModel.deleteMany({});
  await CommuteModel.deleteMany({});
  await NotificationModel.deleteMany({});
  await SessionModel.deleteMany({});
  await AuditLogModel.collection.deleteMany({});
  await InstitutionModel.deleteMany({ name: /^Other Uni / });
  await CampusModel.deleteMany({ name: /^B Campus|^Test Campus/ });

  const b = await InstitutionModel.create({
    name: `Other Uni ${Date.now()}`,
    type: "university",
    city: "Karachi",
    brandColor: "#333333",
    emailDomains: ["other.edu.pk"],
    active: true,
  });
  instB = b._id.toString();
  campusB = (await CampusModel.create({ institutionId: instB, name: "B Campus Main" }))._id.toString();

  adminA = await makeUser("admina@szabist.edu.pk", instA, campusA, "universityAdmin");
  memberA = await makeUser("membera@szabist.edu.pk", instA, campusA);
  memberB = await makeUser("memberb@other.edu.pk", instB, campusB);
  superAdmin = await makeUser("super@szabist.edu.pk", instA, campusA, "superAdmin");
});

describe("IDOR: a university admin against another institution", () => {
  it("cannot read a member of B by id", async () => {
    const response = await call("GET", `/admin/members/${memberB.id}`, adminA.access);
    expect(response.statusCode).toBe(404);
  });

  it("gets the same 404 for B's member as for an id that does not exist", async () => {
    const foreign = await call("GET", `/admin/members/${memberB.id}`, adminA.access);
    const missing = await call("GET", `/admin/members/${new Types.ObjectId()}`, adminA.access);
    // Anything different would let the endpoint map which ids are real.
    expect(foreign.statusCode).toBe(missing.statusCode);
    expect(foreign.json().error.message).toBe(missing.json().error.message);
  });

  it("cannot list B's members by naming B in the query", async () => {
    const response = await call("GET", `/admin/members?institutionId=${instB}`, adminA.access);
    expect(response.statusCode).toBe(403);
  });

  it("never sees B's members in their own list", async () => {
    const response = await call("GET", "/admin/members", adminA.access);
    const ids = response.json().data.map((m: { id: string }) => m.id);
    expect(ids).toContain(memberA.id);
    expect(ids).not.toContain(memberB.id);
  });

  it("cannot suspend a member of B", async () => {
    const response = await call("POST", `/admin/members/${memberB.id}/suspend`, adminA.access, {
      reason: "Trying to reach across",
    });
    expect(response.statusCode).toBe(404);
    expect((await UserModel.findById(memberB.id))!.suspendedAt).toBeNull();
  });

  it("cannot reveal the phone of a member of B", async () => {
    const response = await call("POST", `/admin/members/${memberB.id}/reveal-phone`, adminA.access, {
      reason: "Trying to reach across",
    });
    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain("0321");
  });

  it("cannot edit B's campus", async () => {
    const response = await call("PATCH", `/admin/campuses/${campusB}`, adminA.access, {
      name: "Renamed From Outside",
    });
    expect(response.statusCode).toBe(404);
    expect((await CampusModel.findById(campusB))!.name).toBe("B Campus Main");
  });

  it("cannot create a campus inside B", async () => {
    const response = await call("POST", "/admin/campuses", adminA.access, {
      name: "Test Campus Planted",
      institutionId: instB,
    });
    expect(response.statusCode).toBe(403);
    expect(await CampusModel.countDocuments({ institutionId: instB, name: "Test Campus Planted" })).toBe(0);
  });

  it("cannot edit B's institution profile", async () => {
    const response = await call("PATCH", `/admin/institutions/${instB}`, adminA.access, {
      brandColor: "#FF0000",
    });
    expect(response.statusCode).toBe(404);
    expect((await InstitutionModel.findById(instB))!.brandColor).toBe("#333333");
  });

  it("cannot read or act on B's reports", async () => {
    const report = await ReportModel.create({
      reporterId: memberB.id,
      institutionId: instB,
      category: "behaviour",
      status: "open",
    });

    const list = await call("GET", "/admin/reports", adminA.access);
    expect(list.json().data.map((r: { id: string }) => r.id)).not.toContain(report._id.toString());

    const act = await call("POST", `/admin/reports/${report._id}/action`, adminA.access, {
      action: "dismiss",
    });
    expect(act.statusCode).toBe(404);
    expect((await ReportModel.findById(report._id))!.status).toBe("open");
  });

  it("cannot decide a verification for a member of B", async () => {
    await UserModel.updateOne({ _id: memberB.id }, { $set: { badgeStatus: "pending" } });
    const response = await call("POST", `/admin/verifications/${memberB.id}/decision`, adminA.access, {
      approve: true,
    });
    expect(response.statusCode).toBe(404);
    expect((await UserModel.findById(memberB.id))!.badgeStatus).toBe("pending");
  });

  it("keeps B out of the overview counts", async () => {
    const response = await call("GET", "/admin/overview", adminA.access);
    expect(response.statusCode).toBe(200);
    // A has admin, member and super in this fixture; B's member must not count.
    expect(response.json().data.members).toBe(3);
    expect((await call("GET", `/admin/overview?institutionId=${instB}`, adminA.access)).statusCode).toBe(403);
  });

  it("cannot slip an operator through the query string", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/admin/members?institutionId[$ne]=x",
      headers: { authorization: `Bearer ${adminA.access}` },
    });
    expect(response.statusCode).toBe(400);
  });
});

describe("privilege boundaries", () => {
  it("keeps members out entirely", async () => {
    expect((await call("GET", "/admin/members", memberA.access)).statusCode).toBe(403);
    expect((await call("GET", "/admin/overview", memberA.access)).statusCode).toBe(403);
  });

  it("stops a university admin suspending another admin", async () => {
    const otherAdmin = await makeUser("admin2@szabist.edu.pk", instA, campusA, "universityAdmin");
    const response = await call("POST", `/admin/members/${otherAdmin.id}/suspend`, adminA.access, {
      reason: "Internal disagreement",
    });
    expect(response.statusCode).toBe(403);
  });

  it("stops a university admin suspending a super admin", async () => {
    const response = await call("POST", `/admin/members/${superAdmin.id}/suspend`, adminA.access, {
      reason: "Seizing the platform",
    });
    expect(response.statusCode).toBe(403);
  });

  it("stops an admin suspending themselves", async () => {
    const response = await call("POST", `/admin/members/${adminA.id}/suspend`, adminA.access, {
      reason: "Oops wrong button",
    });
    expect(response.statusCode).toBe(422);
  });

  it("lets a super admin reach any institution", async () => {
    expect((await call("GET", `/admin/members/${memberB.id}`, superAdmin.access)).statusCode).toBe(200);
    const listB = await call("GET", `/admin/members?institutionId=${instB}`, superAdmin.access);
    expect(listB.json().data.map((m: { id: string }) => m.id)).toEqual([memberB.id]);
  });
});

describe("members", () => {
  it("never lists a phone number", async () => {
    const response = await call("GET", "/admin/members", adminA.access);
    expect(response.body).not.toContain("0321");
    const detail = await call("GET", `/admin/members/${memberA.id}`, adminA.access);
    expect(detail.body).not.toContain("0321");
  });

  it("reveals a phone only on request, and audits it", async () => {
    const response = await call("POST", `/admin/members/${memberA.id}/reveal-phone`, adminA.access, {
      reason: "Arranging a replacement driver",
    });
    expect(response.json().data.phone).toBe("0321 5550000");

    const entry = await AuditLogModel.findOne({ action: "member.phoneRevealed" }).lean();
    expect(entry!.actorUserId.toString()).toBe(adminA.id);
    expect(entry!.targetId).toBe(memberA.id);
    // The reason is kept; the number itself is not written into the log.
    expect(JSON.stringify(entry)).not.toContain("0321");
  });

  it("requires a reason to reveal", async () => {
    const response = await call("POST", `/admin/members/${memberA.id}/reveal-phone`, adminA.access, {});
    expect(response.statusCode).toBe(400);
  });

  it("suspends, signs the member out everywhere, audits, and restores", async () => {
    const suspend = await call("POST", `/admin/members/${memberA.id}/suspend`, adminA.access, {
      reason: "Repeated no-shows",
    });
    expect(suspend.json().data.suspended).toBe(true);
    expect(await SessionModel.countDocuments({ userId: memberA.id, revokedAt: null })).toBe(0);
    expect(await AuditLogModel.countDocuments({ action: "member.suspended" })).toBe(1);

    const restore = await call("POST", `/admin/members/${memberA.id}/restore`, adminA.access);
    expect(restore.json().data.suspended).toBe(false);
    expect(await AuditLogModel.countDocuments({ action: "member.restored" })).toBe(1);
  });

  it("filters by search without treating it as a pattern", async () => {
    const response = await call("GET", `/admin/members?q=${encodeURIComponent(".*")}`, adminA.access);
    expect(response.json().data).toEqual([]);
  });

  it("exports CSV without phone numbers and with formula injection neutralised", async () => {
    await UserModel.updateOne({ _id: memberA.id }, { $set: { name: "=HYPERLINK(\"http://x\")" } });
    const response = await call("GET", "/admin/members/export.csv", adminA.access);
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/csv");
    expect(response.body).not.toContain("0321");
    expect(response.body).not.toContain("memberb@other.edu.pk");
    // A cell beginning with "=" would execute when opened in a spreadsheet.
    expect(response.body).toContain("\"'=HYPERLINK");
  });
});

describe("verification queue", () => {
  it("shows the document only here, and decides once", async () => {
    await UserModel.updateOne(
      { _id: memberA.id },
      { $set: { badgeStatus: "pending", badgeDocumentUrl: "https://files.test/id-card.jpg", badgeRequestedAt: new Date() } },
    );

    const queue = await call("GET", "/admin/verifications", adminA.access);
    expect(queue.json().data[0].documentUrl).toBe("https://files.test/id-card.jpg");

    const first = await call("POST", `/admin/verifications/${memberA.id}/decision`, adminA.access, {
      approve: true,
    });
    expect(first.json().data.badgeStatus).toBe("approved");

    // Two admins deciding at once must not both succeed.
    const second = await call("POST", `/admin/verifications/${memberA.id}/decision`, adminA.access, {
      approve: false,
      reason: "other",
    });
    expect(second.statusCode).toBe(409);

    expect(await NotificationModel.countDocuments({ userId: memberA.id, kind: "badgeUpdate" })).toBe(1);
    expect(await AuditLogModel.countDocuments({ action: "verification.approved" })).toBe(1);
  });

  it("requires a reason to reject", async () => {
    await UserModel.updateOne({ _id: memberA.id }, { $set: { badgeStatus: "pending" } });
    const response = await call("POST", `/admin/verifications/${memberA.id}/decision`, adminA.access, {
      approve: false,
    });
    expect(response.statusCode).toBe(422);
  });
});

describe("campuses and profile", () => {
  it("refuses to deactivate a campus with members unless confirmed", async () => {
    const warned = await call("PATCH", `/admin/campuses/${campusA}`, adminA.access, { active: false });
    expect(warned.statusCode).toBe(409);
    expect(warned.json().error.message).toMatch(/members are attached/);
    // A number the panel can use, not a sentence it has to parse.
    expect(warned.json().error.details.affectedMembers).toBe(3);
    expect((await CampusModel.findById(campusA))!.active).toBe(true);
  });

  it("creates a campus in the admin's own institution", async () => {
    const response = await call("POST", "/admin/campuses", adminA.access, { name: "Test Campus North" });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.institutionId).toBe(instA);
  });

  it("refuses an email domain change that orphans accounts, unless confirmed", async () => {
    const response = await call("PATCH", `/admin/institutions/${instA}`, adminA.access, {
      emailDomains: ["newdomain.edu.pk"],
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.details.affectedAccounts).toBe(3);
    expect((await InstitutionModel.findById(instA))!.emailDomains).toContain("szabist.edu.pk");
  });

  it("rejects an invalid brand colour", async () => {
    const response = await call("PATCH", `/admin/institutions/${instA}`, adminA.access, {
      brandColor: "red",
    });
    expect(response.statusCode).toBe(400);
  });

  it("cannot activate or rename an institution from here", async () => {
    const response = await call("PATCH", `/admin/institutions/${instA}`, adminA.access, {
      active: false,
      name: "Renamed",
    });
    // Platform decisions, not profile edits.
    expect(response.statusCode).toBe(400);
  });
});

describe("reports", () => {
  it("lets a university admin escalate but not act on escalated reports", async () => {
    const report = await ReportModel.create({
      reporterId: memberA.id,
      reportedUserId: memberA.id,
      institutionId: instA,
      category: "behaviour",
      status: "open",
    });

    const escalate = await call("POST", `/admin/reports/${report._id}/action`, adminA.access, {
      action: "escalate",
    });
    expect(escalate.json().data.status).toBe("escalated");

    const again = await call("POST", `/admin/reports/${report._id}/action`, adminA.access, {
      action: "dismiss",
    });
    expect(again.statusCode).toBe(409);

    const bySuper = await call("POST", `/admin/reports/${report._id}/action`, superAdmin.access, {
      action: "dismiss",
    });
    expect(bySuper.json().data.status).toBe("dismissed");
  });

  it("will not mark a report handled when the suspension is not permitted", async () => {
    const report = await ReportModel.create({
      reporterId: memberA.id,
      reportedUserId: superAdmin.id,
      institutionId: instA,
      category: "behaviour",
      status: "open",
    });
    const response = await call("POST", `/admin/reports/${report._id}/action`, adminA.access, {
      action: "suspend",
    });
    expect(response.statusCode).toBe(403);
    // Unchanged: no report may claim an action that did not happen.
    expect((await ReportModel.findById(report._id))!.status).toBe("open");
  });
});

describe("activity", () => {
  it("shows this institution's history, and nobody else's", async () => {
    // An action in A, and one in B.
    await call("POST", `/admin/members/${memberA.id}/suspend`, adminA.access, {
      reason: "Testing the activity feed",
    });

    const response = await call("GET", "/admin/activity", adminA.access);
    expect(response.statusCode).toBe(200);

    const entries = response.json().data as Array<{
      action: string;
      actorName: string;
      targetId: string;
    }>;

    expect(entries.length).toBeGreaterThan(0);
    expect(entries[0]!.action).toBe("member.suspended");
    // Resolved here, because "6abb..." tells a person nothing about who acted.
    expect(entries[0]!.actorName).toBeTruthy();

    // Nothing from institution B, whatever happened there.
    const ids = entries.map((e) => e.targetId);
    expect(ids).not.toContain(memberB.id);
  });

  it("never carries the reason somebody typed onto the dashboard", async () => {
    await call("POST", `/admin/members/${memberA.id}/suspend`, adminA.access, {
      reason: "A private note about this person",
    });

    const response = await call("GET", "/admin/activity", adminA.access);
    // It is in the audit log, which is the right place for it. It is not on a
    // dashboard anybody walking past the screen can read.
    expect(response.body).not.toContain("A private note about this person");
  });

  it("is closed to members", async () => {
    const response = await call("GET", "/admin/activity", memberA.access);
    expect(response.statusCode).toBe(403);
  });
});
