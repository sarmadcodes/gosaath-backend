import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { Types } from "mongoose";
import { buildApp } from "../../src/app/app.js";
import { connectToDatabase, disconnectFromDatabase } from "../../src/db/mongodb.js";
import {
  AreaModel,
  BlockModel,
  CampusModel,
  InstitutionModel,
  NotificationModel,
  ReportModel,
  SeatRequestModel,
  SessionModel,
  SupportRequestModel,
  UserModel,
} from "../../src/db/models/index.js";

/** Phase 8: reports, blocks and support. */

let app: FastifyInstance;
let institutionId: string;
let campusId: string;
let areaId: string;
type Person = { access: string; id: string };
let alice: Person;
let bob: Person;

const api = (
  method: "GET" | "POST" | "DELETE",
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

async function makeUser(email: string): Promise<Person> {
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
  await BlockModel.deleteMany({});
  await ReportModel.deleteMany({});
  await SeatRequestModel.deleteMany({});
  await SupportRequestModel.deleteMany({});
  await NotificationModel.deleteMany({});
  await SessionModel.deleteMany({});
  alice = await makeUser("alice@szabist.edu.pk");
  bob = await makeUser("bob@szabist.edu.pk");
});

describe("reports", () => {
  it("files a report and returns nothing to poll", async () => {
    const response = await api("POST", "/safety/reports", alice.access, {
      reportedUserId: bob.id,
      category: "behaviour",
      detail: "Was rude about the route.",
    });
    expect(response.statusCode).toBe(204);
    expect(response.body).toBe("");

    const report = await ReportModel.findOne({ reporterId: alice.id }).lean();
    expect(report!.status).toBe("open");
    // Scoped for moderation by the reporter's institution.
    expect(report!.institutionId.toString()).toBe(institutionId);
  });

  it("refuses a report about yourself", async () => {
    const response = await api("POST", "/safety/reports", alice.access, {
      reportedUserId: alice.id,
      category: "other",
    });
    expect(response.statusCode).toBe(422);
  });

  it("refuses an unknown category", async () => {
    const response = await api("POST", "/safety/reports", alice.access, {
      category: "made-up",
    });
    expect(response.statusCode).toBe(400);
  });

  it("gives the same 404 for a person elsewhere as for one who does not exist", async () => {
    const elsewhere = await InstitutionModel.create({
      name: `Elsewhere ${Date.now()}`,
      type: "university",
      city: "Karachi",
      brandColor: "#123456",
      active: true,
    });
    try {
      await UserModel.updateOne({ _id: bob.id }, { $set: { institutionId: elsewhere._id } });
      const foreign = await api("POST", "/safety/reports", alice.access, {
        reportedUserId: bob.id,
        category: "behaviour",
      });
      const missing = await api("POST", "/safety/reports", alice.access, {
        reportedUserId: new Types.ObjectId().toString(),
        category: "behaviour",
      });
      expect(foreign.statusCode).toBe(404);
      expect(missing.statusCode).toBe(404);
      expect(foreign.json().error.message).toBe(missing.json().error.message);
    } finally {
      await elsewhere.deleteOne();
    }
  });

  it("cannot set its own status", async () => {
    const response = await api("POST", "/safety/reports", alice.access, {
      category: "other",
      status: "dismissed",
    });
    expect(response.statusCode).toBe(400);
  });
});

describe("blocks", () => {
  it("blocks silently, notifying nobody", async () => {
    const response = await api("POST", "/safety/blocks", alice.access, { userId: bob.id });
    expect(response.statusCode).toBe(204);
    expect(await NotificationModel.countDocuments({})).toBe(0);
  });

  it("is idempotent", async () => {
    await api("POST", "/safety/blocks", alice.access, { userId: bob.id });
    await api("POST", "/safety/blocks", alice.access, { userId: bob.id });
    expect(await BlockModel.countDocuments({ blockerId: alice.id })).toBe(1);
  });

  it("refuses blocking yourself", async () => {
    const response = await api("POST", "/safety/blocks", alice.access, { userId: alice.id });
    expect(response.statusCode).toBe(422);
  });

  it("lists only who the caller blocked, never who blocked them", async () => {
    await api("POST", "/safety/blocks", alice.access, { userId: bob.id });
    const mine = (await api("GET", "/safety/blocks", alice.access)).json().data;
    const bobs = (await api("GET", "/safety/blocks", bob.access)).json().data;
    expect(mine).toHaveLength(1);
    expect(mine[0].firstName).toBe("bob");
    // Showing Bob that Alice blocked him would defeat the silence.
    expect(bobs).toEqual([]);
  });

  it("exposes only PublicUser in the blocked list", async () => {
    await api("POST", "/safety/blocks", alice.access, { userId: bob.id });
    const response = await api("GET", "/safety/blocks", alice.access);
    expect(response.body).not.toContain("@szabist.edu.pk");
    expect(response.body).not.toContain("0300");
  });

  it("withdraws pending requests between the two, both ways", async () => {
    await SeatRequestModel.create([
      { rideInstanceId: new Types.ObjectId(), requesterId: bob.id, driverId: alice.id, status: "pending" },
      { rideInstanceId: new Types.ObjectId(), requesterId: alice.id, driverId: bob.id, status: "pending" },
    ]);

    await api("POST", "/safety/blocks", alice.access, { userId: bob.id });

    expect(await SeatRequestModel.countDocuments({ status: "pending" })).toBe(0);
    expect((await api("GET", "/requests/incoming", alice.access)).json().data).toEqual([]);
    expect((await api("GET", "/requests/sent", alice.access)).json().data).toEqual([]);
  });

  it("leaves accepted seats alone", async () => {
    await SeatRequestModel.create({
      rideInstanceId: new Types.ObjectId(),
      requesterId: bob.id,
      driverId: alice.id,
      status: "accepted",
    });
    await api("POST", "/safety/blocks", alice.access, { userId: bob.id });
    expect(await SeatRequestModel.countDocuments({ status: "accepted" })).toBe(1);
  });

  it("unblocks, idempotently", async () => {
    await api("POST", "/safety/blocks", alice.access, { userId: bob.id });
    expect((await api("DELETE", `/safety/blocks/${bob.id}`, alice.access)).statusCode).toBe(204);
    expect((await api("DELETE", `/safety/blocks/${bob.id}`, alice.access)).statusCode).toBe(204);
    expect(await BlockModel.countDocuments({})).toBe(0);
  });

  it("cannot lift a block somebody else placed", async () => {
    await api("POST", "/safety/blocks", alice.access, { userId: bob.id });
    await api("DELETE", `/safety/blocks/${bob.id}`, bob.access);
    await api("DELETE", `/safety/blocks/${alice.id}`, bob.access);
    expect(await BlockModel.countDocuments({ blockerId: alice.id })).toBe(1);
  });
});

describe("support", () => {
  it("returns a readable reference", async () => {
    const response = await api("POST", "/support", alice.access, {
      category: "bug",
      message: "The week strip did not update after skipping.",
      email: "alice@szabist.edu.pk",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.reference).toMatch(/^GS-\d{6}$/);
  });

  it("replies to the account address, not one in the body", async () => {
    await api("POST", "/support", alice.access, {
      category: "account",
      message: "Please send the reply somewhere else.",
      email: "victim@example.com",
    });
    const row = await SupportRequestModel.findOne({ userId: alice.id }).lean();
    // Otherwise our support address could be made to mail anyone.
    expect(row!.email).toBe("alice@szabist.edu.pk");
  });

  it("refuses a message too short to act on", async () => {
    const response = await api("POST", "/support", alice.access, {
      category: "bug",
      message: "broken",
    });
    expect(response.statusCode).toBe(400);
  });
});
