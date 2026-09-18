import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app/app.js";
import { connectToDatabase, disconnectFromDatabase } from "../../src/db/mongodb.js";
import {
  AreaModel,
  AttendanceModel,
  CampusModel,
  CommuteModel,
  InstitutionModel,
  RideInstanceModel,
  SessionModel,
  UserModel,
  VehicleModel,
} from "../../src/db/models/index.js";
import {
  generateAllInstances,
  generateInstancesFor,
} from "../../src/modules/commutes/instance.service.js";
import { isoDate, weekdayOf } from "../../src/utils/dates.js";

/**
 * Phase 4 gate.
 *
 * Two things matter more than the rest: generation must be idempotent under
 * concurrency, and a day-level exception must never reach the template.
 */

let app: FastifyInstance;
let institutionId: string;
let campusId: string;
let areaId: string;
let alice = { access: "", id: "" };
let bob = { access: "", id: "" };

const api = (
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
  const refresh = await app.inject({
    method: "POST",
    url: "/api/v1/auth/refresh",
    payload: { token: login.json().data.token },
  });

  const user = await UserModel.findOne({ email });
  return { access: refresh.json().data.accessToken as string, id: user!._id.toString() };
}

/** Mon/Wed/Fri, on campus by 8, leaving 17:30 — with a different Wednesday. */
const SCHEDULE = [
  { day: "Mon", arriveBy: "08:00", leaveCampusAt: "17:30" },
  { day: "Wed", arriveBy: "10:00", leaveCampusAt: "15:00" },
  { day: "Fri", arriveBy: "08:00" },
];

const baseCommute = () => ({
  intent: "find" as const,
  campusId,
  originAreaId: areaId,
  schedule: SCHEDULE,
  direction: "both" as const,
  womenOnly: false,
});

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
  await VehicleModel.deleteMany({});
  await SessionModel.deleteMany({});

  alice = await makeUser("alice@szabist.edu.pk");
  bob = await makeUser("bob@szabist.edu.pk");
});

describe("commute template", () => {
  it("returns null before one exists", async () => {
    const response = await api("GET", "/commutes/mine", alice.access);
    expect(response.statusCode).toBe(200);
    // Not [] and not a 404: the client's setup card depends on this being
    // null, and on null being different from a failed request.
    expect(response.json().data).toBeNull();
  });

  it("creates one and keeps per-day times apart", async () => {
    const response = await api("POST", "/commutes", alice.access, baseCommute());

    expect(response.statusCode).toBe(200);
    const commute = response.json().data;
    expect(commute.schedule).toHaveLength(3);

    const wednesday = commute.schedule.find((e: { day: string }) => e.day === "Wed");
    // Timetables are not uniform. A single time applied to every day is the
    // shortcut this model exists to avoid.
    expect(wednesday.arriveBy).toBe("10:00");
    expect(wednesday.leaveCampusAt).toBe("15:00");

    const friday = commute.schedule.find((e: { day: string }) => e.day === "Fri");
    // Travelling in but not back is normal, not missing data.
    expect(friday.arriveBy).toBe("08:00");
    expect(friday.leaveCampusAt).toBeUndefined();
  });

  it("takes institution from the account, not the body", async () => {
    const other = await InstitutionModel.create({
      name: `Other ${Date.now()}`,
      type: "university",
      city: "Karachi",
      brandColor: "#abcdef",
      active: true,
    });
    try {
      const response = await api("POST", "/commutes", alice.access, {
        ...baseCommute(),
        institutionId: other._id.toString(),
      });

      expect(response.statusCode).toBe(200);
      // Institution is a matching constraint. Accepting it from the body would
      // walk somebody into another institution's community.
      expect(response.json().data.institutionId).toBe(institutionId);
    } finally {
      await other.deleteOne();
    }
  });

  it("refuses a campus from another institution", async () => {
    const foreign = await CampusModel.create({
      institutionId: (await AreaModel.findOne({}))!._id,
      name: `Foreign ${Date.now()}`,
    });
    try {
      const response = await api("POST", "/commutes", alice.access, {
        ...baseCommute(),
        campusId: foreign._id.toString(),
      });
      expect(response.statusCode).toBe(422);
    } finally {
      await foreign.deleteOne();
    }
  });

  it("refuses a duplicate weekday", async () => {
    const response = await api("POST", "/commutes", alice.access, {
      ...baseCommute(),
      schedule: [
        { day: "Mon", arriveBy: "08:00" },
        { day: "Mon", arriveBy: "09:00" },
      ],
    });
    expect(response.statusCode).toBe(400);
  });

  it("refuses a day with no times at all", async () => {
    const response = await api("POST", "/commutes", alice.access, {
      ...baseCommute(),
      schedule: [{ day: "Mon" }],
    });
    expect(response.statusCode).toBe(400);
  });

  it("refuses offering seats without a vehicle", async () => {
    const response = await api("POST", "/commutes", alice.access, {
      ...baseCommute(),
      intent: "offer",
      seatsOffered: 3,
    });
    expect(response.statusCode).toBe(422);
  });

  it("refuses somebody else's vehicle", async () => {
    const theirs = await VehicleModel.create({
      ownerId: bob.id,
      type: "car",
      model: "Civic",
      plate: "BOB-111",
      colour: "Black",
    });

    const response = await api("POST", "/commutes", alice.access, {
      ...baseCommute(),
      intent: "offer",
      vehicleId: theirs._id.toString(),
      seatsOffered: 2,
    });
    expect(response.statusCode).toBe(422);
  });

  it("refuses a second commute", async () => {
    await api("POST", "/commutes", alice.access, baseCommute());
    const second = await api("POST", "/commutes", alice.access, baseCommute());
    expect(second.statusCode).toBe(409);
  });

  it("cannot edit somebody else's commute", async () => {
    const created = await api("POST", "/commutes", alice.access, baseCommute());
    const id = created.json().data.id as string;

    const attempt = await api("PATCH", `/commutes/${id}`, bob.access, {
      womenOnly: true,
    });
    expect(attempt.statusCode).toBe(404);
  });
});

describe("instance generation", () => {
  async function createFor(token: string) {
    const response = await api("POST", "/commutes", token, baseCommute());
    return response.json().data.id as string;
  }

  it("expands only the days in the template", async () => {
    const id = await createFor(alice.access);
    const instances = await RideInstanceModel.find({ commuteId: id }).lean();

    expect(instances.length).toBeGreaterThan(0);
    const days = new Set(instances.map((i) => i.day));
    expect([...days].sort()).toEqual(["Fri", "Mon", "Wed"]);
  });

  it("anchors every instance to local midnight in Karachi", async () => {
    const id = await createFor(alice.access);
    const instances = await RideInstanceModel.find({ commuteId: id }).lean();

    for (const instance of instances) {
      // Midnight in Karachi is 19:00 UTC the day before. Anchoring makes a
      // date one value rather than a range, which is what lets
      // {commuteId, date} work as a unique key.
      expect(instance.date.getUTCHours()).toBe(19);
      expect(instance.date.getUTCMinutes()).toBe(0);
      expect(weekdayOf(instance.date)).toBe(instance.day);
    }
  });

  it("carries each day's own times onto its instance", async () => {
    const id = await createFor(alice.access);
    const wednesday = await RideInstanceModel.findOne({ commuteId: id, day: "Wed" });
    const monday = await RideInstanceModel.findOne({ commuteId: id, day: "Mon" });

    expect(wednesday!.arriveBy).toBe("10:00");
    expect(monday!.arriveBy).toBe("08:00");
  });

  it("IS IDEMPOTENT: running generation twice creates nothing new", async () => {
    const id = await createFor(alice.access);
    const before = await RideInstanceModel.countDocuments({ commuteId: id });

    const second = await generateInstancesFor(id);

    expect(second.created).toBe(0);
    expect(await RideInstanceModel.countDocuments({ commuteId: id })).toBe(before);
  });

  it("IS IDEMPOTENT under concurrency: ten racing workers produce one row per day", async () => {
    const id = await createFor(alice.access);
    await RideInstanceModel.deleteMany({ commuteId: id });

    // The real hazard: a cron and a lazy read, or several PM2 workers, all
    // generating at once. A check-then-insert has a window where every one of
    // them sees nothing and every one of them inserts.
    await Promise.all(
      Array.from({ length: 10 }, () => generateInstancesFor(id)),
    );

    const instances = await RideInstanceModel.find({ commuteId: id }).lean();
    const dates = instances.map((i) => isoDate(i.date));

    expect(new Set(dates).size).toBe(dates.length);
    expect(instances.length).toBeGreaterThan(0);
  });

  it("does not undo a cancellation when regenerating", async () => {
    const id = await createFor(alice.access);
    const instance = await RideInstanceModel.findOne({ commuteId: id });
    instance!.status = "cancelled";
    await instance!.save();

    await generateInstancesFor(id);

    const after = await RideInstanceModel.findById(instance!._id);
    // Status is $setOnInsert only. Overwriting it would quietly revive a day
    // somebody had already called off.
    expect(after!.status).toBe("cancelled");
  });

  it("does not reset seats already taken", async () => {
    const id = await createFor(alice.access);
    await RideInstanceModel.updateOne({ commuteId: id }, { $set: { seatsTaken: 2 } });

    await generateInstancesFor(id);

    const instance = await RideInstanceModel.findOne({ commuteId: id, seatsTaken: 2 });
    expect(instance).toBeTruthy();
  });

  it("gives the driver attendance on their own ride", async () => {
    const id = await createFor(alice.access);
    const instance = await RideInstanceModel.findOne({ commuteId: id });

    const attendance = await AttendanceModel.findOne({
      rideInstanceId: instance!._id,
      userId: alice.id,
    });
    // Without this the group has no driver in it, and members() returns
    // passengers travelling with nobody.
    expect(attendance!.role).toBe("driver");
  });

  it("skips cancelled commutes in the bulk job", async () => {
    const id = await createFor(alice.access);
    await RideInstanceModel.deleteMany({});
    await CommuteModel.updateOne({ _id: id }, { $set: { status: "cancelled" } });

    await generateAllInstances();
    expect(await RideInstanceModel.countDocuments({ commuteId: id })).toBe(0);
  });
});

describe("day-level exceptions", () => {
  async function createFor(token: string) {
    const response = await api("POST", "/commutes", token, baseCommute());
    return response.json().data.id as string;
  }

  it("skipping a day does not touch the template", async () => {
    const id = await createFor(alice.access);
    const before = await CommuteModel.findById(id);
    const scheduleBefore = JSON.stringify(before!.schedule);

    // Pick a day that is still ahead of us this week.
    const upcoming = await RideInstanceModel.findOne({
      commuteId: id,
      date: { $gte: new Date() },
    }).sort({ date: 1 });

    const response = await api("POST", `/commutes/${id}/skip`, alice.access, {
      day: upcoming!.day,
    });
    expect(response.statusCode).toBe(200);

    const after = await CommuteModel.findById(id);
    // The entire reason these are separate collections: one day off must not
    // silently rewrite every other week.
    expect(JSON.stringify(after!.schedule)).toBe(scheduleBefore);
  });

  it("skipping one day leaves the others alone", async () => {
    const id = await createFor(alice.access);
    const upcoming = await RideInstanceModel.find({
      commuteId: id,
      date: { $gte: new Date() },
    }).sort({ date: 1 });

    await api("POST", `/commutes/${id}/skip`, alice.access, {
      day: upcoming[0]!.day,
    });

    const skipped = await AttendanceModel.findOne({
      rideInstanceId: upcoming[0]!._id,
      userId: alice.id,
    });
    const untouched = await AttendanceModel.findOne({
      rideInstanceId: upcoming[1]!._id,
      userId: alice.id,
    });

    expect(skipped!.status).toBe("skipped");
    expect(untouched!.status).toBe("confirmed");
  });

  it("driver unavailable marks the day noDriver, not cancelled", async () => {
    const id = await createFor(alice.access);
    const upcoming = await RideInstanceModel.findOne({
      commuteId: id,
      date: { $gte: new Date() },
    }).sort({ date: 1 });

    const response = await api("POST", `/commutes/${id}/unavailable`, alice.access, {
      days: [upcoming!.day],
    });
    expect(response.statusCode).toBe(200);

    const after = await RideInstanceModel.findById(upcoming!._id);
    // "noDriver" is what surfaces the find-cover flow. "cancelled" would tell
    // passengers the ride is off when somebody else could still drive it.
    expect(after!.status).toBe("noDriver");

    const template = await CommuteModel.findById(id);
    expect(template!.status).toBe("active");
    expect(template!.schedule).toHaveLength(3);
  });

  it("a passenger cannot declare the driver unavailable", async () => {
    const id = await createFor(alice.access);
    const response = await api("POST", `/commutes/${id}/unavailable`, bob.access, {
      days: ["Mon"],
    });
    // Would strand everybody else on the ride.
    expect(response.statusCode).toBe(404);
  });

  it("cannot skip a day that is not in the pattern", async () => {
    const id = await createFor(alice.access);
    const response = await api("POST", `/commutes/${id}/skip`, alice.access, {
      day: "Sun",
    });
    expect(response.statusCode).toBe(422);
  });

  it("the week reflects instances, not the template", async () => {
    const id = await createFor(alice.access);
    const response = await api("GET", `/commutes/${id}/week`, alice.access);

    expect(response.statusCode).toBe(200);
    const days = response.json().data as Array<{ day: string; date: string }>;
    expect(days.length).toBeGreaterThan(0);
    for (const day of days) {
      expect(["Mon", "Wed", "Fri"]).toContain(day.day);
      expect(day.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("cannot read somebody else's week", async () => {
    const id = await createFor(alice.access);
    const response = await api("GET", `/commutes/${id}/week`, bob.access);
    expect(response.statusCode).toBe(404);
  });
});

describe("editing and cancelling", () => {
  it("rebuilds future instances when the schedule changes", async () => {
    const created = await api("POST", "/commutes", alice.access, baseCommute());
    const id = created.json().data.id as string;

    await api("PATCH", `/commutes/${id}`, alice.access, {
      schedule: [{ day: "Tue", arriveBy: "09:00" }],
    });

    // Only days strictly after today. Today's instance is deliberately left
    // alone — it is a ride people may already be on their way to, and pulling
    // it out from under them to satisfy an edit made this morning would be
    // worse than one stale row.
    const future = await RideInstanceModel.find({
      commuteId: id,
      date: { $gt: new Date() },
    }).lean();
    const days = new Set(future.map((i) => i.day));
    expect([...days]).toEqual(["Tue"]);
  });

  it("cancelling clears future rides and their attendance", async () => {
    const created = await api("POST", "/commutes", alice.access, baseCommute());
    const id = created.json().data.id as string;

    const response = await api("DELETE", `/commutes/${id}`, alice.access);
    expect(response.statusCode).toBe(204);

    expect(await api("GET", "/commutes/mine", alice.access).then((r) => r.json().data)).toBeNull();

    const live = await RideInstanceModel.countDocuments({
      commuteId: id,
      date: { $gte: new Date() },
      status: { $ne: "cancelled" },
    });
    expect(live).toBe(0);
  });
});
