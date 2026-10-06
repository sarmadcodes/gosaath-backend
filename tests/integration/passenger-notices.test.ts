import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app/app.js";
import { connectToDatabase, disconnectFromDatabase } from "../../src/db/mongodb.js";
import {
  AreaModel,
  AttendanceModel,
  CampusModel,
  InstitutionModel,
  NotificationModel,
  RideInstanceModel,
  UserModel,
} from "../../src/db/models/index.js";

/**
 * What a passenger is told when their ride changes under them.
 *
 * Every case here was silent before. A seat was cleared, a schedule was
 * rebuilt, a driver stopped coming — and the only way to find out was to open
 * the app and notice, or to stand at a kerb. These tests exist because that
 * class of bug is invisible in code review: the write is correct, the feature
 * works, and nobody is told.
 */

let app: FastifyInstance;
let institutionId: string;
let campusId: string;
let areaId: string;

type Person = { access: string; id: string; name: string };

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

async function makeUser(email: string, name: string): Promise<Person> {
  await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: {
      name,
      email,
      password: "a-long-enough-passphrase",
      phone: "0300 5551234",
      userType: "student",
      institutionId,
      campusId,
      areaId,
    },
  });
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
  return { access: refresh.json().data.accessToken as string, id: user!._id.toString(), name };
}

const SCHEDULE = [
  { day: "Mon", arriveBy: "08:00", leaveCampusAt: "17:00" },
  { day: "Wed", arriveBy: "08:00", leaveCampusAt: "17:00" },
];

/** A driver offering seats, and a passenger confirmed on every future ride. */
async function pairUp(stamp: number) {
  const driver = await makeUser(`pn-driver-${stamp}@szabist.edu.pk`, "Bilal Ahmed");
  const rider = await makeUser(`pn-rider-${stamp}@szabist.edu.pk`, "Sarmad Abbasi");

  const vehicle = await api("PUT", "/vehicles", driver.access, {
    type: "car",
    model: "Toyota Corolla",
    plate: "BKT-512",
    colour: "White",
  });

  const commute = await api("POST", "/commutes", driver.access, {
    intent: "offer",
    direction: "both",
    campusId,
    originAreaId: areaId,
    schedule: SCHEDULE,
    vehicleId: vehicle.json().data.id,
    seatsOffered: 3,
    contribution: 300,
    womenOnly: false,
  });
  const commuteId = commute.json().data.id as string;

  const rides = await RideInstanceModel.find({ commuteId }).lean();
  await AttendanceModel.insertMany(
    rides.map((ride) => ({
      rideInstanceId: ride._id,
      userId: rider.id,
      role: "passenger",
      status: "confirmed",
    })),
  );

  return { driver, rider, commuteId, rides };
}

/** Notification titles this person has, newest first. */
async function noticesFor(userId: string): Promise<string[]> {
  const rows = await NotificationModel.find({ userId }).sort({ createdAt: -1 }).lean();
  return rows.map((row) => row.title);
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

describe("when the driver cancels the whole commute", () => {
  it("tells every passenger their ride is gone", async () => {
    const { driver, rider, commuteId } = await pairUp(Date.now());

    await api("DELETE", `/commutes/${commuteId}`, driver.access);

    const notices = await noticesFor(rider.id);
    expect(notices).toContain("Your ride has been cancelled");
  });

  it("says it is over rather than implying a gap", async () => {
    const { driver, rider, commuteId } = await pairUp(Date.now() + 1);

    await api("DELETE", `/commutes/${commuteId}`, driver.access);

    const row = await NotificationModel.findOne({
      userId: rider.id,
      kind: "cancellation",
    }).lean();

    // "not running this commute" rather than "cannot make it", which would
    // suggest it resumes next week.
    expect(row!.body).toContain("no longer running");
  });
});

describe("when the driver changes the schedule", () => {
  it("tells passengers their times moved", async () => {
    const { driver, rider, commuteId } = await pairUp(Date.now() + 2);

    await api("PATCH", `/commutes/${commuteId}`, driver.access, {
      schedule: [
        { day: "Mon", arriveBy: "09:30", leaveCampusAt: "18:00" },
        { day: "Wed", arriveBy: "09:30", leaveCampusAt: "18:00" },
      ],
    });

    // Their seats were rebuilt against the new schedule. Doing that without a
    // word is how somebody waits at the old time.
    expect(await noticesFor(rider.id)).toContain("Your ride times have changed");
  });

  it("says nothing to anybody when only the driver is affected", async () => {
    const driver = await makeUser(`pn-solo-${Date.now()}@szabist.edu.pk`, "Bilal Ahmed");
    const vehicle = await api("PUT", "/vehicles", driver.access, {
      type: "car",
      model: "Honda City",
      plate: "AXB-704",
      colour: "Silver",
    });
    const commute = await api("POST", "/commutes", driver.access, {
      intent: "offer",
      direction: "both",
      campusId,
      originAreaId: areaId,
      schedule: SCHEDULE,
      vehicleId: vehicle.json().data.id,
      seatsOffered: 3,
      womenOnly: false,
    });

    await api("PATCH", `/commutes/${commute.json().data.id}`, driver.access, {
      schedule: [{ day: "Thu", arriveBy: "10:00", leaveCampusAt: "16:00" }],
    });

    // Nobody had a seat, so nobody is notified about a change to it.
    expect(await noticesFor(driver.id)).toHaveLength(0);
  });
});

describe("when somebody skips a day", () => {
  it("tells the driver that a passenger is not coming", async () => {
    const { driver, rider, commuteId } = await pairUp(Date.now() + 3);

    await api("POST", `/commutes/${commuteId}/skip`, rider.access, { day: "Mon" });

    const notices = await noticesFor(driver.id);
    expect(notices).toContain("A passenger is not coming");
  });

  it("says whose seat is free, and when", async () => {
    const { driver, rider, commuteId } = await pairUp(Date.now() + 4);

    await api("POST", `/commutes/${commuteId}/skip`, rider.access, { day: "Wed" });

    const row = await NotificationModel.findOne({
      userId: driver.id,
      kind: "cancellation",
    }).lean();

    // First name only, and the day — enough to re-plan, and enough to offer
    // the seat to somebody else.
    expect(row!.body).toContain("Sarmad");
    expect(row!.body).toContain("Wed");
  });

  it("treats a driver skipping as the ride not running", async () => {
    const { driver, rider, commuteId, rides } = await pairUp(Date.now() + 5);
    const monday = rides.find((ride) => ride.day === "Mon")!;

    await api("POST", `/commutes/${commuteId}/skip`, driver.access, { day: "Mon" });

    // Previously the instance stayed "scheduled" and passengers were told
    // nothing, so a ride with nobody driving it looked exactly like one that
    // was running.
    const after = await RideInstanceModel.findById(monday._id).lean();
    expect(after!.status).toBe("noDriver");

    expect(await noticesFor(rider.id)).toContain("Your driver cannot make it");
  });

  it("leaves the passenger's other days alone", async () => {
    const { driver, rider, commuteId, rides } = await pairUp(Date.now() + 6);

    await api("POST", `/commutes/${commuteId}/skip`, driver.access, { day: "Mon" });

    const wednesday = rides.find((ride) => ride.day === "Wed")!;
    const seat = await AttendanceModel.findOne({
      rideInstanceId: wednesday._id,
      userId: rider.id,
    }).lean();

    // Skipping one day is not withdrawing from the arrangement.
    expect(seat!.status).toBe("confirmed");
  });

  it("moves passengers to pending, not cancelled", async () => {
    const { driver, rider, commuteId, rides } = await pairUp(Date.now() + 7);
    const monday = rides.find((ride) => ride.day === "Mon")!;

    await api("POST", `/commutes/${commuteId}/skip`, driver.access, { day: "Mon" });

    const seat = await AttendanceModel.findOne({
      rideInstanceId: monday._id,
      userId: rider.id,
    }).lean();

    // They still want the ride; they need somebody to drive it. Cancelling
    // would throw away the thing a replacement is meant to fill.
    expect(seat!.status).toBe("pending");
  });
});
