import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app/app.js";
import { connectToDatabase, disconnectFromDatabase } from "../../src/db/mongodb.js";
import {
  AreaModel,
  AttendanceModel,
  AuditLogModel,
  BlockModel,
  CampusModel,
  CommuteModel,
  InstitutionModel,
  PreferencesModel,
  RideInstanceModel,
  SeatRequestModel,
  SessionModel,
  UserModel,
  VehicleModel,
} from "../../src/db/models/index.js";

/**
 * Women-only rides.
 *
 * Gender is self-declared and optional. A women-only ride is invisible to,
 * and cannot be joined by, anybody who has not declared themselves a woman —
 * and the flag only counts when its owner is a declared woman, so older data
 * reads as ordinary rides rather than as a promise nobody checked.
 */

let app: FastifyInstance;
let institutionId: string;
let campusId: string;
let areaId: string;

type Gender = "woman" | "man" | "undisclosed";
type Person = { access: string; id: string; email: string };

let woman: Person;
let otherWoman: Person;
let man: Person;
let unstated: Person;

const api = (
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

async function makeUser(email: string, gender?: Gender): Promise<Person> {
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
      ...(gender ? { gender } : {}),
    },
  });
  // Verified, because offering seats requires it; that gate has its own file.
  await UserModel.updateOne(
    { email },
    { $set: { emailVerifiedAt: new Date(), badgeStatus: "approved" } },
  );

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
    access: refresh.json().data.accessToken as string,
    id: user!._id.toString(),
    email,
  };
}

const SCHEDULE = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((day) => ({
  day,
  arriveBy: "08:00",
  leaveCampusAt: "17:00",
}));

async function vehicleFor(person: Person): Promise<string> {
  const vehicle = await VehicleModel.create({
    ownerId: person.id,
    type: "car",
    model: "Toyota Corolla GLi",
    plate: `CAR-${Math.floor(Math.random() * 9000) + 1000}`,
    colour: "White",
  });
  return vehicle._id.toString();
}

async function offer(person: Person, womenOnly: boolean) {
  return api("POST", "/commutes", person.access, {
    intent: "offer",
    campusId,
    originAreaId: areaId,
    schedule: SCHEDULE,
    direction: "both",
    womenOnly,
    vehicleId: await vehicleFor(person),
    seatsOffered: 3,
    contribution: 300,
  });
}

async function find(person: Person, womenOnly = false) {
  return api("POST", "/commutes", person.access, {
    intent: "find",
    campusId,
    originAreaId: areaId,
    schedule: SCHEDULE,
    direction: "both",
    womenOnly,
  });
}

async function nextRideOf(person: Person): Promise<string> {
  const instance = await RideInstanceModel.findOne({
    driverId: person.id,
    date: { $gte: new Date() },
  }).sort({ date: 1 });
  return instance!._id.toString();
}

async function searchIds(person: Person, query = ""): Promise<string[]> {
  const response = await api("GET", `/rides${query}`, person.access);
  expect(response.statusCode).toBe(200);
  return (response.json().data as Array<{ driver: { id: string } }>).map((r) => r.driver.id);
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
  await CommuteModel.deleteMany({});
  await RideInstanceModel.deleteMany({});
  await AttendanceModel.deleteMany({});
  await SeatRequestModel.deleteMany({});
  await VehicleModel.deleteMany({});
  await BlockModel.deleteMany({});
  await SessionModel.deleteMany({});
  await PreferencesModel.deleteMany({});

  woman = await makeUser("woman@szabist.edu.pk", "woman");
  otherWoman = await makeUser("otherwoman@szabist.edu.pk", "woman");
  man = await makeUser("man@szabist.edu.pk", "man");
  unstated = await makeUser("unstated@szabist.edu.pk");
});

describe("declaring a gender", () => {
  it("is optional, and absent reads as undisclosed", async () => {
    const response = await api("GET", "/me", unstated.access);
    expect(response.json().data.gender).toBe("undisclosed");
  });

  it("is kept from sign-up and can be changed by its owner", async () => {
    expect((await api("GET", "/me", woman.access)).json().data.gender).toBe("woman");

    const changed = await api("PATCH", "/me", unstated.access, { gender: "woman" });
    expect(changed.statusCode).toBe(200);
    expect(changed.json().data.gender).toBe("woman");
  });

  it("rejects a value outside the list", async () => {
    const response = await api("PATCH", "/me", man.access, { gender: "admin" });
    expect(response.statusCode).toBe(400);
  });

  it("is never shown to another member", async () => {
    await offer(woman, false);
    const response = await api("GET", "/rides", man.access);
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toHaveLength(1);
    expect(response.body).not.toContain("gender");
  });
});

describe("creating a women-only commute", () => {
  it("is allowed for a declared woman", async () => {
    const response = await offer(woman, true);
    expect(response.statusCode).toBe(200);
    expect(response.json().data.womenOnly).toBe(true);
  });

  it("is refused for a man and for somebody who has not said", async () => {
    expect((await offer(man, true)).statusCode).toBe(403);
    expect((await find(unstated, true)).statusCode).toBe(403);
    expect(await CommuteModel.countDocuments({})).toBe(0);
  });

  it("cannot be switched on later by somebody who is not a declared woman", async () => {
    const created = await offer(man, false);
    const id = created.json().data.id as string;

    const response = await api("PATCH", `/commutes/${id}`, man.access, { womenOnly: true });
    expect(response.statusCode).toBe(403);
    expect((await CommuteModel.findById(id).lean())?.womenOnly).toBe(false);
  });

  it("does not lock somebody out of editing a commute carrying an old flag", async () => {
    const created = await offer(man, false);
    const id = created.json().data.id as string;
    await CommuteModel.updateOne({ _id: id }, { $set: { womenOnly: true } });

    const response = await api("PATCH", `/commutes/${id}`, man.access, { contribution: 250 });
    expect(response.statusCode).toBe(200);
  });
});

describe("seeing women-only rides", () => {
  beforeEach(async () => {
    await offer(woman, true);
  });

  it("shows them to declared women, marked as women-only", async () => {
    const response = await api("GET", "/rides", otherWoman.access);
    const rides = response.json().data as Array<{ driver: { id: string }; womenOnly: boolean }>;
    expect(rides.map((r) => r.driver.id)).toEqual([woman.id]);
    expect(rides[0]!.womenOnly).toBe(true);
  });

  it("hides them from men and from people who have not said, in search", async () => {
    expect(await searchIds(man)).toEqual([]);
    expect(await searchIds(unstated)).toEqual([]);
  });

  it("hides them from nearby", async () => {
    await find(man);
    await find(otherWoman);

    const forMan = await api("GET", "/rides/nearby", man.access);
    const forWoman = await api("GET", "/rides/nearby", otherWoman.access);
    expect(forMan.json().data).toEqual([]);
    expect((forWoman.json().data as unknown[]).length).toBeGreaterThan(0);
  });

  it("will not open one by id", async () => {
    const rideId = await nextRideOf(woman);
    const response = await api("GET", `/rides/${rideId}`, man.access);
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toBeNull();
  });

  it("filters on the flag in effect", async () => {
    await offer(otherWoman, false);
    expect(await searchIds(otherWoman, "?womenOnly=true")).toEqual([woman.id]);
  });

  it("treats a flag whose owner is not a declared woman as an ordinary ride", async () => {
    const created = await offer(man, false);
    await CommuteModel.updateOne(
      { _id: created.json().data.id },
      { $set: { womenOnly: true } },
    );

    const response = await api("GET", "/rides", unstated.access);
    const rides = response.json().data as Array<{ driver: { id: string }; womenOnly: boolean }>;
    expect(rides.map((r) => r.driver.id)).toEqual([man.id]);
    expect(rides[0]!.womenOnly).toBe(false);
  });

  it("stops applying when the owner changes their declaration", async () => {
    await api("PATCH", "/me", woman.access, { gender: "undisclosed" });
    expect(await searchIds(man)).toEqual([woman.id]);
  });
});

describe("joining a women-only ride", () => {
  let rideId: string;

  beforeEach(async () => {
    await offer(woman, true);
    rideId = await nextRideOf(woman);
  });

  it("lets a declared woman ask for a seat", async () => {
    const response = await api("POST", `/rides/${rideId}/request`, otherWoman.access, { seats: 1 });
    expect(response.statusCode).toBe(200);
  });

  it("answers anybody else as though the ride does not exist", async () => {
    const asMan = await api("POST", `/rides/${rideId}/request`, man.access, { seats: 1 });
    const asUnstated = await api("POST", `/rides/${rideId}/request`, unstated.access, { seats: 1 });
    expect(asMan.statusCode).toBe(404);
    expect(asUnstated.statusCode).toBe(404);
    expect(await SeatRequestModel.countDocuments({})).toBe(0);
  });

  it("refuses to accept somebody whose declaration changed after asking", async () => {
    const asked = await api("POST", `/rides/${rideId}/request`, otherWoman.access, { seats: 1 });
    const requestId = asked.json().data.id as string;

    await api("PATCH", "/me", otherWoman.access, { gender: "man" });

    const response = await api("POST", `/requests/${requestId}/respond`, woman.access, {
      action: "accept",
    });
    expect(response.statusCode).toBe(409);
    expect((await SeatRequestModel.findById(requestId).lean())?.status).toBe("pending");
    expect((await RideInstanceModel.findById(rideId).lean())?.seatsTaken).toBe(0);
  });

  it("still accepts a declared woman", async () => {
    const asked = await api("POST", `/rides/${rideId}/request`, otherWoman.access, { seats: 1 });
    const response = await api("POST", `/requests/${asked.json().data.id}/respond`, woman.access, {
      action: "accept",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.status).toBe("accepted");
  });
});

describe("matching", () => {
  const matchedIds = async (person: Person) =>
    ((await api("GET", "/matches", person.access)).json().data as Array<{ user: { id: string } }>).map(
      (m) => m.user.id,
    );

  it("keeps a woman's women-only commute away from men, both ways", async () => {
    await find(woman, true);
    await offer(man, false);

    expect(await matchedIds(woman)).toEqual([]);
    expect(await matchedIds(man)).toEqual([]);
  });

  it("matches two women whether or not the other has set the flag", async () => {
    await find(woman, true);
    await offer(otherWoman, false);

    expect(await matchedIds(woman)).toEqual([otherWoman.id]);
    expect(await matchedIds(otherWoman)).toEqual([woman.id]);
  });

  it("does not narrow who a woman without the flag may meet", async () => {
    await find(woman, false);
    await offer(man, false);

    expect(await matchedIds(woman)).toEqual([man.id]);
  });
});

describe("the preference", () => {
  it("can be switched on only by a declared woman", async () => {
    expect((await api("PATCH", "/preferences", man.access, { womenOnly: true })).statusCode).toBe(403);
    const ok = await api("PATCH", "/preferences", woman.access, { womenOnly: true });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().data.womenOnly).toBe(true);
  });
});

describe("admin correction", () => {
  let admin: Person;

  beforeEach(async () => {
    admin = await makeUser("admin@szabist.edu.pk");
    // The role is read from the database on every admin request, so the
    // token minted above is enough once the row says admin.
    await UserModel.updateOne({ _id: admin.id }, { $set: { role: "universityAdmin" } });
  });

  it("shows the declaration on the member page but not in the list", async () => {
    const detail = await api("GET", `/admin/members/${woman.id}`, admin.access);
    expect(detail.json().data.gender).toBe("woman");

    const list = await api("GET", "/admin/members", admin.access);
    expect(list.body).not.toContain("gender");
  });

  it("corrects it, with a reason, and records that it happened without the value", async () => {
    const response = await api("POST", `/admin/members/${man.id}/gender`, admin.access, {
      gender: "undisclosed",
      reason: "Member asked for it to be removed",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.gender).toBe("undisclosed");

    // Append-only, so earlier runs' rows may exist; the target id is unique.
    const entry = await AuditLogModel.findOne({
      action: "member.genderCorrected",
      targetId: man.id,
    }).lean();
    expect(entry).not.toBeNull();
    expect(JSON.stringify(entry)).not.toContain("undisclosed");
  });

  it("is not open to members", async () => {
    const response = await api("POST", `/admin/members/${man.id}/gender`, woman.access, {
      gender: "woman",
      reason: "Trying it on",
    });
    expect(response.statusCode).toBe(403);
  });
});
