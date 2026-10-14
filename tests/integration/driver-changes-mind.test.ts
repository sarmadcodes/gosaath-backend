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

/**
 * A driver changing their mind — in both directions.
 *
 * Everything here exists because the app could get into a state and not out
 * of it. A driver could stand a day down and never put it back; they could
 * accept a seat and never release it; and having stood a day down they were
 * shown "no driver", as though somebody else had let them down.
 *
 * The fixtures put a real passenger on every ride, because the whole point is
 * what the other person is told.
 */

let app: FastifyInstance;
let institutionId: string;
let campusId: string;
let areaId: string;

type Person = { access: string; id: string };
let driver: Person;
let rider: Person;

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
  return { access: refresh.json().data.accessToken as string, id: user!._id.toString() };
}

/** Every weekday, so whichever day the suite runs on has an instance. */
const SCHEDULE = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((day) => ({
  day,
  arriveBy: "08:00",
  leaveCampusAt: "17:00",
}));

async function offerRide(person: Person, seats = 3) {
  const vehicle = await VehicleModel.create({
    ownerId: person.id,
    type: "car",
    model: "Toyota Corolla GLi",
    plate: `CAR-${Date.now() % 10000}`,
    colour: "White",
  });

  const created = await api("POST", "/commutes", person.access, {
    intent: "offer",
    campusId,
    originAreaId: areaId,
    schedule: SCHEDULE,
    direction: "both",
    womenOnly: false,
    vehicleId: vehicle._id.toString(),
    seatsOffered: seats,
    contribution: 300,
  });

  const instance = await RideInstanceModel.findOne({
    driverId: person.id,
    date: { $gte: new Date() },
  }).sort({ date: 1 });

  return {
    commuteId: created.json().data.id as string,
    rideId: instance!._id.toString(),
    day: instance!.day as string,
  };
}

async function giveCommute(person: Person) {
  await api("POST", "/commutes", person.access, {
    intent: "find",
    campusId,
    originAreaId: areaId,
    schedule: SCHEDULE,
    direction: "both",
    womenOnly: false,
  });
}

/** Puts the rider on the driver's ride, through the real request flow. */
async function seatRider(rideId: string): Promise<string> {
  const requested = await api("POST", `/rides/${rideId}/request`, rider.access, {
    seats: 1,
  });
  const requestId = requested.json().data.id as string;
  await api("POST", `/requests/${requestId}/respond`, driver.access, {
    action: "accept",
  });
  return requestId;
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
  await SessionModel.deleteMany({});
  await NotificationModel.deleteMany({});

  driver = await makeUser("driver@szabist.edu.pk");
  rider = await makeUser("rider@szabist.edu.pk");
  await giveCommute(rider);
});

describe("standing a day down", () => {
  it("tells the owner they are not driving, not that nobody is", async () => {
    const { commuteId, day } = await offerRide(driver);

    await api("POST", `/commutes/${commuteId}/unavailable`, driver.access, {
      days: [day],
    });

    const week = await api("GET", `/commutes/${commuteId}/week`, driver.access);
    const entry = week.json().data.find((d: { day: string }) => d.day === day);

    // The distinction this whole status exists for. "No driver" is true of
    // the ride and absurd as a message to the person who is the driver.
    expect(entry.status).toBe("notDriving");
  });

  it("still tells the passengers the ride has no driver", async () => {
    const { commuteId, rideId, day } = await offerRide(driver);
    await seatRider(rideId);

    await api("POST", `/commutes/${commuteId}/unavailable`, driver.access, {
      days: [day],
    });

    const week = await api("GET", `/commutes/${commuteId}/week`, rider.access);
    const entry = week.json().data.find((d: { day: string }) => d.day === day);

    expect(entry.status).toBe("noDriver");
  });
});

describe("putting the day back on", () => {
  it("restores the ride and the passenger's seat", async () => {
    const { commuteId, rideId, day } = await offerRide(driver);
    await seatRider(rideId);

    await api("POST", `/commutes/${commuteId}/unavailable`, driver.access, {
      days: [day],
    });
    expect((await RideInstanceModel.findById(rideId))!.status).toBe("noDriver");

    await api("POST", `/commutes/${commuteId}/available`, driver.access, {
      days: [day],
    });

    const instance = await RideInstanceModel.findById(rideId);
    expect(instance!.status).toBe("scheduled");
    // The reason belonged to a declaration that has been withdrawn, so
    // leaving it behind would attach it to a ride that is running.
    expect(instance!.unavailableReason ?? null).toBeNull();

    const attendance = await AttendanceModel.findOne({
      rideInstanceId: rideId,
      userId: rider.id,
    });
    expect(attendance!.status).toBe("confirmed");
  });

  it("tells the passengers their driver is back", async () => {
    const { commuteId, rideId, day } = await offerRide(driver);
    await seatRider(rideId);

    await api("POST", `/commutes/${commuteId}/unavailable`, driver.access, {
      days: [day],
    });
    await api("POST", `/commutes/${commuteId}/available`, driver.access, {
      days: [day],
    });

    const told = await NotificationModel.findOne({
      userId: rider.id,
      kind: "driverAvailable",
    });

    // Worth as much as the message that they had dropped out: a passenger
    // who went looking for cover needs to know they can stop.
    expect(told).not.toBeNull();
  });

  it("leaves a day the driver never stood down alone", async () => {
    const { commuteId, rideId, day } = await offerRide(driver);

    await api("POST", `/commutes/${commuteId}/available`, driver.access, {
      days: [day],
    });

    // Nothing to undo, so nothing happens — rather than a scheduled ride
    // being "restored" into some other state.
    expect((await RideInstanceModel.findById(rideId))!.status).toBe("scheduled");
  });

  it("refuses somebody else's commute", async () => {
    const { commuteId, day } = await offerRide(driver);

    const response = await api("POST", `/commutes/${commuteId}/available`, rider.access, {
      days: [day],
    });

    expect(response.statusCode).toBeGreaterThanOrEqual(400);
  });
});

describe("taking back an accepted seat", () => {
  it("returns the seat and removes the passenger", async () => {
    const { rideId } = await offerRide(driver, 3);
    const requestId = await seatRider(rideId);

    expect((await RideInstanceModel.findById(rideId))!.seatsTaken).toBe(1);

    const response = await api("POST", `/requests/${requestId}/respond`, driver.access, {
      action: "cancel",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.status).toBe("cancelled");
    expect((await RideInstanceModel.findById(rideId))!.seatsTaken).toBe(0);

    // Removed, not marked: a lingering row keeps them in the group list and
    // on the driver's manifest for a ride they are not on.
    const attendance = await AttendanceModel.findOne({
      rideInstanceId: rideId,
      userId: rider.id,
    });
    expect(attendance).toBeNull();
  });

  it("tells the passenger", async () => {
    const { rideId } = await offerRide(driver);
    const requestId = await seatRider(rideId);

    await api("POST", `/requests/${requestId}/respond`, driver.access, {
      action: "cancel",
    });

    const told = await NotificationModel.findOne({
      userId: rider.id,
      kind: "requestCancelled",
    });
    expect(told).not.toBeNull();
  });

  it("refuses to cancel a request that was never accepted", async () => {
    const { rideId } = await offerRide(driver);
    const requested = await api("POST", `/rides/${rideId}/request`, rider.access, {
      seats: 1,
    });

    const response = await api(
      "POST",
      `/requests/${requested.json().data.id}/respond`,
      driver.access,
      { action: "cancel" },
    );

    expect(response.statusCode).toBe(409);
  });

  it("cannot be done twice", async () => {
    const { rideId } = await offerRide(driver);
    const requestId = await seatRider(rideId);

    await api("POST", `/requests/${requestId}/respond`, driver.access, {
      action: "cancel",
    });
    const second = await api("POST", `/requests/${requestId}/respond`, driver.access, {
      action: "cancel",
    });

    expect(second.statusCode).toBe(409);
    // The guard is what stops the seat count drifting below the rows that
    // justify it, which would make a full ride look bookable.
    expect((await RideInstanceModel.findById(rideId))!.seatsTaken).toBe(0);
  });

  it("is not available to the passenger", async () => {
    const { rideId } = await offerRide(driver);
    const requestId = await seatRider(rideId);

    const response = await api("POST", `/requests/${requestId}/respond`, rider.access, {
      action: "cancel",
    });

    expect(response.statusCode).toBe(404);
  });
});

describe("what a request shows", () => {
  it("withholds the number until the seat is accepted", async () => {
    const { rideId } = await offerRide(driver);
    await api("POST", `/rides/${rideId}/request`, rider.access, { seats: 1 });

    const pending = await api("GET", "/requests/incoming", driver.access);
    const row = pending.json().data[0];

    // The promise the privacy policy makes, in one assertion.
    expect(row.status).toBe("pending");
    expect(row.contactPhone).toBeUndefined();
    // But enough to decide on: who, where from, and which days overlap.
    expect(row.user.firstName).toBeTruthy();
    expect(row.originArea).toBeTruthy();
    expect(row.matchingDays.length).toBeGreaterThan(0);
  });

  it("releases the number once accepted", async () => {
    const { rideId } = await offerRide(driver);
    await seatRider(rideId);

    const answered = await api("GET", "/requests/incoming", driver.access);
    const row = answered.json().data.find(
      (r: { status: string }) => r.status === "accepted",
    );

    expect(row.contactPhone).toBe("0300 1234567");
  });

  it("takes the number away again when the seat is cancelled", async () => {
    const { rideId } = await offerRide(driver);
    const requestId = await seatRider(rideId);

    const response = await api("POST", `/requests/${requestId}/respond`, driver.access, {
      action: "cancel",
    });

    // The gate is the status, so it closes on the way back out too.
    expect(response.json().data.contactPhone).toBeUndefined();
  });
});

describe("browsing rides", () => {
  it("does not offer the driver their own seats", async () => {
    await offerRide(driver);

    const mine = await api("GET", "/rides", driver.access);
    const ids = mine.json().data.map((r: { driver: { firstName: string } }) => r.driver);

    // A driver was being shown the seats they are themselves offering, which
    // reads as somebody having offered them a lift in their own car.
    expect(ids).toHaveLength(0);
  });

  it("still offers them to everybody else", async () => {
    await offerRide(driver);

    const theirs = await api("GET", "/rides", rider.access);
    expect(theirs.json().data.length).toBeGreaterThan(0);
  });
});
