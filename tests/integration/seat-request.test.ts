import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app/app.js";
import { connectToDatabase, disconnectFromDatabase } from "../../src/db/mongodb.js";
import {
  AreaModel,
  AttendanceModel,
  BlockModel,
  CampusModel,
  CommuteModel,
  InstitutionModel,
  RideInstanceModel,
  SeatRequestModel,
  SessionModel,
  UserModel,
  VehicleModel,
} from "../../src/db/models/index.js";

/**
 * Phase 6 gate.
 *
 * The case that matters most is the last one: several people accepting the
 * last seat at the same instant. Everything else here is the state machine
 * around it — who may ask, who may answer, and what each answer means.
 */

let app: FastifyInstance;
let institutionId: string;
let campusId: string;
let areaId: string;

type Person = { access: string; id: string; email: string };
let driver: Person;
let rider: Person;
let other: Person;

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
  return {
    access: refresh.json().data.accessToken as string,
    id: user!._id.toString(),
    email,
  };
}

const SCHEDULE = [
  { day: "Mon", arriveBy: "08:00", leaveCampusAt: "17:00" },
  { day: "Tue", arriveBy: "08:00", leaveCampusAt: "17:00" },
  { day: "Wed", arriveBy: "08:00", leaveCampusAt: "17:00" },
  { day: "Thu", arriveBy: "08:00", leaveCampusAt: "17:00" },
  { day: "Fri", arriveBy: "08:00", leaveCampusAt: "17:00" },
  { day: "Sat", arriveBy: "08:00", leaveCampusAt: "17:00" },
  { day: "Sun", arriveBy: "08:00", leaveCampusAt: "17:00" },
];

/** Gives someone an offering commute, and returns the next ride instance id. */
async function offerRide(person: Person, seats = 3): Promise<string> {
  const vehicle = await VehicleModel.create({
    ownerId: person.id,
    type: "car",
    model: "Toyota Corolla GLi",
    plate: `CAR-${Date.now() % 10000}`,
    colour: "White",
  });

  await api("POST", "/commutes", person.access, {
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

  return instance!._id.toString();
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

  driver = await makeUser("driver@szabist.edu.pk");
  rider = await makeUser("rider@szabist.edu.pk");
  other = await makeUser("other@szabist.edu.pk");
});

describe("requesting a seat", () => {
  it("creates a pending request without consuming a seat", async () => {
    const rideId = await offerRide(driver);
    await giveCommute(rider);

    const response = await api("POST", `/rides/${rideId}/request`, rider.access, {
      seats: 1,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.status).toBe("pending");

    // Nothing is consumed until the driver says yes. Holding a seat on a
    // request would let somebody block a ride by asking and never showing up.
    const instance = await RideInstanceModel.findById(rideId);
    expect(instance!.seatsTaken).toBe(0);
  });

  it("refuses a request for your own ride", async () => {
    const rideId = await offerRide(driver);
    const response = await api("POST", `/rides/${rideId}/request`, driver.access, {
      seats: 1,
    });
    expect(response.statusCode).toBe(422);
  });

  it("refuses a duplicate request", async () => {
    const rideId = await offerRide(driver);
    await giveCommute(rider);

    await api("POST", `/rides/${rideId}/request`, rider.access, { seats: 1 });
    const second = await api("POST", `/rides/${rideId}/request`, rider.access, {
      seats: 1,
    });

    // A double tap or a retry on a flaky connection must not show the driver
    // the same person twice.
    expect(second.statusCode).toBe(409);
    expect(await SeatRequestModel.countDocuments({ rideInstanceId: rideId })).toBe(1);
  });

  it("refuses re-asking after a decline", async () => {
    const rideId = await offerRide(driver);
    await giveCommute(rider);

    const created = await api("POST", `/rides/${rideId}/request`, rider.access, {
      seats: 1,
    });
    await api("POST", `/requests/${created.json().data.id}/respond`, driver.access, {
      action: "decline",
    });

    // Otherwise a driver who said no can be asked again immediately, and
    // again after that.
    const again = await api("POST", `/rides/${rideId}/request`, rider.access, {
      seats: 1,
    });
    expect(again.statusCode).toBe(409);
  });

  it("refuses more seats than are free", async () => {
    const rideId = await offerRide(driver, 2);
    await giveCommute(rider);

    const response = await api("POST", `/rides/${rideId}/request`, rider.access, {
      seats: 3,
    });
    expect(response.statusCode).toBe(409);
  });

  it("refuses a ride at another institution", async () => {
    const rideId = await offerRide(driver);
    await giveCommute(rider);

    const elsewhere = await InstitutionModel.create({
      name: `Elsewhere ${Date.now()}`,
      type: "university",
      city: "Karachi",
      brandColor: "#123456",
      active: true,
    });
    try {
      await UserModel.updateOne(
        { _id: driver.id },
        { $set: { institutionId: elsewhere._id } },
      );

      const response = await api("POST", `/rides/${rideId}/request`, rider.access, {
        seats: 1,
      });
      // 404, not 403: existence itself is not something to confirm across a
      // community boundary.
      expect(response.statusCode).toBe(404);
    } finally {
      await elsewhere.deleteOne();
    }
  });

  it("refuses a ride at another campus", async () => {
    const rideId = await offerRide(driver);
    await giveCommute(rider);

    const otherCampus = await CampusModel.create({
      institutionId,
      name: `Other Campus ${Date.now()}`,
    });
    try {
      await UserModel.updateOne(
        { _id: driver.id },
        { $set: { campusId: otherCampus._id } },
      );

      const response = await api("POST", `/rides/${rideId}/request`, rider.access, {
        seats: 1,
      });
      expect(response.statusCode).toBe(404);
    } finally {
      await otherCampus.deleteOne();
    }
  });

  it("refuses when the rider has blocked the driver", async () => {
    const rideId = await offerRide(driver);
    await giveCommute(rider);
    await BlockModel.create({ blockerId: rider.id, blockedId: driver.id });

    const response = await api("POST", `/rides/${rideId}/request`, rider.access, {
      seats: 1,
    });
    expect(response.statusCode).toBe(404);
  });

  it("refuses when the DRIVER has blocked the rider", async () => {
    const rideId = await offerRide(driver);
    await giveCommute(rider);
    await BlockModel.create({ blockerId: driver.id, blockedId: rider.id });

    const response = await api("POST", `/rides/${rideId}/request`, rider.access, {
      seats: 1,
    });
    // Same 404 as the other direction. A distinct error would tell the
    // blocked person exactly what had happened.
    expect(response.statusCode).toBe(404);
  });

  it("refuses a cancelled ride", async () => {
    const rideId = await offerRide(driver);
    await giveCommute(rider);
    await RideInstanceModel.updateOne({ _id: rideId }, { $set: { status: "cancelled" } });

    const response = await api("POST", `/rides/${rideId}/request`, rider.access, {
      seats: 1,
    });
    expect(response.statusCode).toBe(422);
  });
});

describe("answering a request", () => {
  async function pendingRequest() {
    const rideId = await offerRide(driver);
    await giveCommute(rider);
    const created = await api("POST", `/rides/${rideId}/request`, rider.access, {
      seats: 1,
    });
    return { rideId, requestId: created.json().data.id as string };
  }

  it("accepting consumes a seat and seats the passenger", async () => {
    const { rideId, requestId } = await pendingRequest();

    const response = await api("POST", `/requests/${requestId}/respond`, driver.access, {
      action: "accept",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.status).toBe("accepted");

    const instance = await RideInstanceModel.findById(rideId);
    expect(instance!.seatsTaken).toBe(1);

    // Attendance is the record of who is on a day. Without it the group has
    // an accepted request and nobody actually travelling.
    const attendance = await AttendanceModel.findOne({
      rideInstanceId: rideId,
      userId: rider.id,
    });
    expect(attendance!.role).toBe("passenger");
    expect(attendance!.status).toBe("confirmed");
  });

  it("declining changes nothing about capacity", async () => {
    const { rideId, requestId } = await pendingRequest();

    const response = await api("POST", `/requests/${requestId}/respond`, driver.access, {
      action: "decline",
    });

    expect(response.json().data.status).toBe("declined");
    expect((await RideInstanceModel.findById(rideId))!.seatsTaken).toBe(0);
    expect(
      await AttendanceModel.countDocuments({ rideInstanceId: rideId, userId: rider.id }),
    ).toBe(0);
  });

  it("only the driver may answer", async () => {
    const { requestId } = await pendingRequest();

    // The requester answering their own request would be self-approval.
    const byRider = await api("POST", `/requests/${requestId}/respond`, rider.access, {
      action: "accept",
    });
    const byStranger = await api("POST", `/requests/${requestId}/respond`, other.access, {
      action: "accept",
    });

    expect(byRider.statusCode).toBe(404);
    expect(byStranger.statusCode).toBe(404);
  });

  it("cannot be answered twice", async () => {
    const { requestId } = await pendingRequest();

    await api("POST", `/requests/${requestId}/respond`, driver.access, {
      action: "accept",
    });
    const again = await api("POST", `/requests/${requestId}/respond`, driver.access, {
      action: "accept",
    });

    expect(again.statusCode).toBe(409);
  });

  it("cannot turn a declined request into an accepted one", async () => {
    const { rideId, requestId } = await pendingRequest();

    await api("POST", `/requests/${requestId}/respond`, driver.access, {
      action: "decline",
    });
    const revive = await api("POST", `/requests/${requestId}/respond`, driver.access, {
      action: "accept",
    });

    expect(revive.statusCode).toBe(409);
    // No seat may be consumed by a transition that is not allowed.
    expect((await RideInstanceModel.findById(rideId))!.seatsTaken).toBe(0);
  });
});

describe("the two lists", () => {
  it("keeps incoming and sent apart", async () => {
    const rideId = await offerRide(driver);
    await giveCommute(rider);
    await api("POST", `/rides/${rideId}/request`, rider.access, { seats: 1 });

    const driverIncoming = (await api("GET", "/requests/incoming", driver.access)).json().data;
    const driverSent = (await api("GET", "/requests/sent", driver.access)).json().data;
    const riderIncoming = (await api("GET", "/requests/incoming", rider.access)).json().data;
    const riderSent = (await api("GET", "/requests/sent", rider.access)).json().data;

    // One is a to-do list, the other a waiting list. They are never the same
    // rows seen from the same side.
    expect(driverIncoming).toHaveLength(1);
    expect(driverSent).toHaveLength(0);
    expect(riderIncoming).toHaveLength(0);
    expect(riderSent).toHaveLength(1);
  });

  it("shows the other party, never the caller", async () => {
    const rideId = await offerRide(driver);
    await giveCommute(rider);
    await api("POST", `/rides/${rideId}/request`, rider.access, { seats: 1 });

    const incoming = (await api("GET", "/requests/incoming", driver.access)).json().data[0];
    const sent = (await api("GET", "/requests/sent", rider.access)).json().data[0];

    expect(incoming.user.firstName).toBe("rider");
    expect(sent.user.firstName).toBe("driver");
  });

  it("exposes only a PublicUser", async () => {
    const rideId = await offerRide(driver);
    await giveCommute(rider);
    await api("POST", `/rides/${rideId}/request`, rider.access, { seats: 1 });

    const response = await api("GET", "/requests/incoming", driver.access);
    expect(response.body).not.toContain("passwordHash");
    expect(response.body).not.toContain("@szabist.edu.pk");
    expect(response.json().data[0].user.phone).toBeUndefined();
  });

  it("does not leak another person's requests", async () => {
    const rideId = await offerRide(driver);
    await giveCommute(rider);
    await api("POST", `/rides/${rideId}/request`, rider.access, { seats: 1 });

    expect((await api("GET", "/requests/incoming", other.access)).json().data).toEqual([]);
    expect((await api("GET", "/requests/sent", other.access)).json().data).toEqual([]);
  });
});

describe("overbooking under concurrency", () => {
  it("TEN concurrent accepts against TWO seats yield exactly two", async () => {
    // The gate for this phase.
    //
    // Read-then-write cannot survive this: every caller reads the same free
    // seat and every one writes. Capacity is claimed by a single guarded
    // update instead, so the check and the increment are one operation with
    // nothing in between.
    const rideId = await offerRide(driver, 2);

    const requesters: Person[] = [];
    for (let i = 0; i < 10; i++) {
      const person = await makeUser(`racer${i}@szabist.edu.pk`);
      await giveCommute(person);
      requesters.push(person);
    }

    const requestIds: string[] = [];
    for (const person of requesters) {
      const created = await api("POST", `/rides/${rideId}/request`, person.access, {
        seats: 1,
      });
      expect(created.statusCode).toBe(200);
      requestIds.push(created.json().data.id as string);
    }

    // All ten answered at the same moment.
    const responses = await Promise.all(
      requestIds.map((id) =>
        api("POST", `/requests/${id}/respond`, driver.access, { action: "accept" }),
      ),
    );

    const accepted = responses.filter((r) => r.statusCode === 200);
    const refused = responses.filter((r) => r.statusCode !== 200);

    expect(accepted).toHaveLength(2);
    expect(refused).toHaveLength(8);

    const instance = await RideInstanceModel.findById(rideId);
    expect(instance!.seatsTaken).toBe(2);
    expect(instance!.seatsTaken).toBeLessThanOrEqual(instance!.seatsOffered);

    // The database must agree with the responses: exactly two accepted rows,
    // and exactly two passengers actually seated.
    expect(
      await SeatRequestModel.countDocuments({
        rideInstanceId: rideId,
        status: "accepted",
      }),
    ).toBe(2);

    expect(
      await AttendanceModel.countDocuments({
        rideInstanceId: rideId,
        role: "passenger",
        status: "confirmed",
      }),
    ).toBe(2);

    // The eight that lost stay pending rather than being auto-declined: a
    // seat may free up, and refusing on the driver's behalf is not ours to do.
    expect(
      await SeatRequestModel.countDocuments({
        rideInstanceId: rideId,
        status: "pending",
      }),
    ).toBe(8);
  }, 120_000);

  it("a multi-seat request cannot straddle the limit", async () => {
    // Two seats free, one person asking for two and another for one. The
    // second must not squeeze in after the first has taken both.
    const rideId = await offerRide(driver, 2);

    await giveCommute(rider);
    await giveCommute(other);

    const big = await api("POST", `/rides/${rideId}/request`, rider.access, { seats: 2 });
    const small = await api("POST", `/rides/${rideId}/request`, other.access, { seats: 1 });

    const [bigResult, smallResult] = await Promise.all([
      api("POST", `/requests/${big.json().data.id}/respond`, driver.access, {
        action: "accept",
      }),
      api("POST", `/requests/${small.json().data.id}/respond`, driver.access, {
        action: "accept",
      }),
    ]);

    const instance = await RideInstanceModel.findById(rideId);
    expect(instance!.seatsTaken).toBeLessThanOrEqual(2);

    // Whichever order they landed in, the total is never over capacity.
    const accepted = [bigResult, smallResult].filter((r) => r.statusCode === 200);
    const seats = accepted.reduce(
      (sum, r) => sum + (r.json().data.seats as number),
      0,
    );
    expect(seats).toBeLessThanOrEqual(2);
  }, 60_000);
});
