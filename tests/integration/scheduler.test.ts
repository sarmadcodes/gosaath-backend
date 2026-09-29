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
  NotificationModel,
  RideInstanceModel,
  SeatRequestModel,
  SessionModel,
  UserModel,
  VehicleModel,
} from "../../src/db/models/index.js";
import {
  autoConfirmDueRides,
  flagOrphanRides,
  runScheduler,
  sendDueReminders,
} from "../../src/modules/commutes/scheduler.service.js";
import { instantAt } from "../../src/utils/dates.js";

/**
 * The recurring engine (SYSTEM.md 4.3).
 *
 * The property that matters most is not that it works, but that running it
 * again does nothing: the scheduler runs every few minutes, restarts on every
 * deploy, and may overlap with itself. A duplicate 6am reminder teaches
 * people to ignore the next one.
 */

let app: FastifyInstance;
let institutionId: string;
let campusId: string;
let areaId: string;
let driver: { id: string; access: string };
let rider: { id: string; access: string };

const api = (
  method: "GET" | "POST",
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
  return { id: user!._id.toString(), access: refresh.json().data.accessToken as string };
}

/** An offering commute that runs every weekday at 08:00. */
async function offerEveryDay(seats = 3) {
  const vehicle = await VehicleModel.create({
    ownerId: driver.id,
    type: "car",
    model: "Toyota Corolla GLi",
    plate: "BKT-512",
    colour: "White",
  });

  await api("POST", "/commutes", driver.access, {
    intent: "offer",
    campusId,
    originAreaId: areaId,
    schedule: ["Mon", "Tue", "Wed", "Thu", "Fri"].map((day) => ({
      day,
      arriveBy: "08:00",
      leaveCampusAt: "17:00",
    })),
    direction: "both",
    womenOnly: false,
    vehicleId: vehicle._id.toString(),
    seatsOffered: seats,
    contribution: 300,
  });
}

/** The instant a given ride leaves, for building a "now" relative to it. */
function departureOf(instance: { date: Date; arriveBy?: string | null }) {
  return instantAt(instance.date, instance.arriveBy ?? null)!;
}

beforeAll(async () => {
  await connectToDatabase();
  app = await buildApp({ rateLimit: false });
  await app.ready();

  campusId = (await CampusModel.findOne({ name: "Clifton Campus" }))!._id.toString();
  areaId = (await AreaModel.findOne({ name: "Gulshan-e-Iqbal" }))!._id.toString();
  institutionId = (
    await InstitutionModel.findOne({ name: "SZABIST University" })
  )!._id.toString();
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
  await NotificationModel.deleteMany({});
  await VehicleModel.deleteMany({});
  await SessionModel.deleteMany({});

  driver = await makeUser("driver@szabist.edu.pk");
  rider = await makeUser("rider@szabist.edu.pk");
});

describe("automatic confirmation", () => {
  it("confirms a pending seat once the ride is within twelve hours", async () => {
    await offerEveryDay();
    const instance = (await RideInstanceModel.find({ driverId: driver.id })
      .sort({ date: 1 })
      .lean())[2]!;

    await AttendanceModel.create({
      rideInstanceId: instance._id,
      userId: rider.id,
      role: "passenger",
      status: "pending",
    });

    // Eleven hours before it leaves.
    const now = new Date(departureOf(instance).getTime() - 11 * 60 * 60 * 1000);
    expect(await autoConfirmDueRides(now)).toBe(1);

    const attendance = await AttendanceModel.findOne({
      rideInstanceId: instance._id,
      userId: rider.id,
    });
    expect(attendance!.status).toBe("confirmed");
  });

  it("leaves a ride that is still days away alone", async () => {
    await offerEveryDay();
    const instances = await RideInstanceModel.find({ driverId: driver.id })
      .sort({ date: 1 })
      .lean();
    const far = instances[instances.length - 1]!;

    await AttendanceModel.create({
      rideInstanceId: far._id,
      userId: rider.id,
      role: "passenger",
      status: "pending",
    });

    const now = new Date(departureOf(far).getTime() - 5 * 24 * 60 * 60 * 1000);
    expect(await autoConfirmDueRides(now)).toBe(0);

    // The rider's row specifically: the driver's own row is confirmed from
    // the moment the ride is generated.
    const attendance = await AttendanceModel.findOne({
      rideInstanceId: far._id,
      userId: rider.id,
    });
    expect(attendance!.status).toBe("pending");
  });

  it("does nothing the second time it runs", async () => {
    await offerEveryDay();
    const instance = (await RideInstanceModel.find({ driverId: driver.id })
      .sort({ date: 1 })
      .lean())[2]!;
    await AttendanceModel.create({
      rideInstanceId: instance._id,
      userId: rider.id,
      role: "passenger",
      status: "pending",
    });

    const now = new Date(departureOf(instance).getTime() - 11 * 60 * 60 * 1000);
    expect(await autoConfirmDueRides(now)).toBe(1);
    expect(await autoConfirmDueRides(now)).toBe(0);
  });
});

describe("orphan rides", () => {
  it("tells the passengers when a ride has no driver", async () => {
    await offerEveryDay();
    const instance = (await RideInstanceModel.find({ driverId: driver.id })
      .sort({ date: 1 })
      .lean())[1]!;

    await AttendanceModel.create({
      rideInstanceId: instance._id,
      userId: rider.id,
      role: "passenger",
      status: "pending",
    });
    await RideInstanceModel.updateOne(
      { _id: instance._id },
      { $set: { status: "noDriver" } },
    );
    await NotificationModel.deleteMany({});

    expect(await flagOrphanRides()).toBe(1);

    const told = await NotificationModel.find({ userId: rider.id }).lean();
    expect(told).toHaveLength(1);
    expect(told[0]!.kind).toBe("replacementAvailable");
  });

  it("does not tell them twice, however often it runs", async () => {
    await offerEveryDay();
    const instance = (await RideInstanceModel.find({ driverId: driver.id })
      .sort({ date: 1 })
      .lean())[1]!;
    await AttendanceModel.create({
      rideInstanceId: instance._id,
      userId: rider.id,
      role: "passenger",
      status: "pending",
    });
    await RideInstanceModel.updateOne(
      { _id: instance._id },
      { $set: { status: "noDriver" } },
    );
    await NotificationModel.deleteMany({});

    await flagOrphanRides();
    await flagOrphanRides();
    await flagOrphanRides();

    expect(await NotificationModel.countDocuments({ userId: rider.id })).toBe(1);
  });
});

describe("reminders", () => {
  it("reminds everyone travelling, twelve hours before", async () => {
    await offerEveryDay();
    const instance = (await RideInstanceModel.find({ driverId: driver.id })
      .sort({ date: 1 })
      .lean())[2]!;
    await AttendanceModel.create({
      rideInstanceId: instance._id,
      userId: rider.id,
      role: "passenger",
      status: "confirmed",
    });
    await NotificationModel.deleteMany({});

    const now = new Date(departureOf(instance).getTime() - 12 * 60 * 60 * 1000);
    const sent = await sendDueReminders(now);
    expect(sent.dayBefore).toBe(1);

    // The driver is reminded too: their forgetting is what strands the rest.
    expect(await NotificationModel.countDocuments({ userId: rider.id })).toBe(1);
    expect(await NotificationModel.countDocuments({ userId: driver.id })).toBe(1);
  });

  it("reminds again twenty minutes before leaving", async () => {
    await offerEveryDay();
    const instance = (await RideInstanceModel.find({ driverId: driver.id })
      .sort({ date: 1 })
      .lean())[2]!;
    await NotificationModel.deleteMany({});

    const now = new Date(departureOf(instance).getTime() - 20 * 60 * 1000);
    const sent = await sendDueReminders(now);
    expect(sent.departure).toBe(1);
  });

  it("never reminds twice about the same ride", async () => {
    await offerEveryDay();
    const instance = (await RideInstanceModel.find({ driverId: driver.id })
      .sort({ date: 1 })
      .lean())[2]!;
    await NotificationModel.deleteMany({});

    const now = new Date(departureOf(instance).getTime() - 12 * 60 * 60 * 1000);
    await sendDueReminders(now);
    await sendDueReminders(now);
    await sendDueReminders(new Date(now.getTime() + 60_000));

    expect(await NotificationModel.countDocuments({ userId: driver.id })).toBe(1);
  });

  it("does not remind about a ride that has already left", async () => {
    await offerEveryDay();
    const instance = (await RideInstanceModel.find({ driverId: driver.id })
      .sort({ date: 1 })
      .lean())[2]!;
    await NotificationModel.deleteMany({});

    // The scheduler was down all night and is catching up: a reminder for a
    // ride that left an hour ago is worse than no reminder.
    const now = new Date(departureOf(instance).getTime() + 60 * 60 * 1000);
    const sent = await sendDueReminders(now);
    expect(sent.dayBefore).toBe(0);
    expect(sent.departure).toBe(0);
  });
});

describe("a full pass", () => {
  it("is safe to run repeatedly", async () => {
    await offerEveryDay();
    const before = await RideInstanceModel.countDocuments({ driverId: driver.id });

    await runScheduler();
    await runScheduler();

    // The generator is idempotent on {commuteId, date}: no duplicate rides.
    expect(await RideInstanceModel.countDocuments({ driverId: driver.id })).toBe(before);
  });
});
