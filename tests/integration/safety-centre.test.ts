import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
  SafetyAlertModel,
  TripShareModel,
  UserModel,
  VehicleModel,
} from "../../src/db/models/index.js";

/**
 * The safety centre.
 *
 * Two features that have to be judged by what they refuse to do.
 *
 * Trip sharing hands a link to somebody with no account. Most of these tests
 * are about what that link does NOT contain — a phone number, a surname, an
 * address, another passenger, a full plate, or anything resembling a position.
 * GoSaath holds no location for anybody, so the test that matters is that the
 * response cannot grow one by accident.
 *
 * The help button records an alert and tells administrators. It does not
 * dispatch anybody, and the tests assert the honest shape of that: a record, a
 * notification, and the real emergency numbers for the phone to dial.
 */

let app: FastifyInstance;
let institutionId: string;
let campusId: string;
let areaId: string;

type Person = { access: string; id: string; name: string };

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
  return { access: refresh.json().data.accessToken as string, id: user!._id.toString(), name };
}

/** A driver with a car, a commute and one scheduled ride. */
async function makeRide(driver: Person): Promise<string> {
  const vehicle = await VehicleModel.create({
    ownerId: driver.id,
    type: "car",
    model: "Toyota Corolla",
    plate: "BKT-512",
    colour: "White",
  });

  const commute = await CommuteModel.create({
    ownerId: driver.id,
    institutionId,
    campusId,
    originAreaId: areaId,
    intent: "offer",
    direction: "both",
    status: "active",
    vehicleId: vehicle._id,
    seatsOffered: 3,
    schedule: [{ day: "Mon", arriveBy: "08:00", leaveCampusAt: "17:00" }],
  });

  const ride = await RideInstanceModel.create({
    commuteId: commute._id,
    driverId: driver.id,
    date: new Date("2026-10-05T00:00:00.000Z"),
    day: "Mon",
    arriveBy: "08:00",
    leaveCampusAt: "17:00",
    status: "scheduled",
    seatsOffered: 3,
    seatsTaken: 1,
  });

  await AttendanceModel.create({
    rideInstanceId: ride._id,
    userId: driver.id,
    role: "driver",
    status: "confirmed",
  });

  return ride._id.toString();
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

describe("sharing a trip", () => {
  it("lets a confirmed passenger share the ride they are on", async () => {
    const stamp = Date.now();
    const driver = await makeUser(`ts-d-${stamp}@szabist.edu.pk`, "Bilal Ahmed");
    const rider = await makeUser(`ts-r-${stamp}@szabist.edu.pk`, "Sarmad Abbasi");
    const rideId = await makeRide(driver);

    await AttendanceModel.create({
      rideInstanceId: rideId,
      userId: rider.id,
      role: "passenger",
      status: "confirmed",
    });

    const response = await api("POST", `/rides/${rideId}/share`, rider.access);

    expect(response.statusCode).toBe(200);
    expect(response.json().data.url).toContain("/t/");
    expect(response.json().data.token).toHaveLength(43);
  });

  it("refuses somebody with no seat on the ride", async () => {
    const stamp = Date.now();
    const driver = await makeUser(`ts-d2-${stamp}@szabist.edu.pk`, "Bilal Ahmed");
    const stranger = await makeUser(`ts-s2-${stamp}@szabist.edu.pk`, "Nobody Here");
    const rideId = await makeRide(driver);

    const response = await api("POST", `/rides/${rideId}/share`, stranger.access);

    // 404 rather than 403: whether a ride exists is not something to confirm
    // to somebody with no seat on it.
    expect(response.statusCode).toBe(404);
  });

  it("lets the driver share their own ride", async () => {
    const driver = await makeUser(`ts-d3-${Date.now()}@szabist.edu.pk`, "Bilal Ahmed");
    const rideId = await makeRide(driver);

    expect((await api("POST", `/rides/${rideId}/share`, driver.access)).statusCode).toBe(200);
  });

  it("stores the token hashed, so a database dump is not a stack of live links", async () => {
    const driver = await makeUser(`ts-h-${Date.now()}@szabist.edu.pk`, "Bilal Ahmed");
    const rideId = await makeRide(driver);

    const { token } = (await api("POST", `/rides/${rideId}/share`, driver.access)).json().data;
    const row = await TripShareModel.findOne({ rideInstanceId: rideId }).select("+tokenHash");

    expect(row!.tokenHash).not.toContain(token);
    expect(row!.tokenHash).toHaveLength(64);
  });

  it("replaces an earlier link rather than leaving two working", async () => {
    const driver = await makeUser(`ts-rep-${Date.now()}@szabist.edu.pk`, "Bilal Ahmed");
    const rideId = await makeRide(driver);

    const first = (await api("POST", `/rides/${rideId}/share`, driver.access)).json().data;
    const second = (await api("POST", `/rides/${rideId}/share`, driver.access)).json().data;

    const old = await app.inject({ method: "GET", url: `/api/v1/t/${first.token}` });
    const current = await app.inject({ method: "GET", url: `/api/v1/t/${second.token}` });

    expect(old.statusCode).toBe(404);
    expect(current.statusCode).toBe(200);
  });

  it("never returns the token again after it was created", async () => {
    const driver = await makeUser(`ts-once-${Date.now()}@szabist.edu.pk`, "Bilal Ahmed");
    const rideId = await makeRide(driver);
    const { token } = (await api("POST", `/rides/${rideId}/share`, driver.access)).json().data;

    const status = await api("GET", `/rides/${rideId}/share`, driver.access);

    expect(status.json().data.active).toBe(true);
    // Read access to the account must not hand somebody the link itself.
    expect(status.body).not.toContain(token);
  });

  it("stops working once revoked", async () => {
    const driver = await makeUser(`ts-rev-${Date.now()}@szabist.edu.pk`, "Bilal Ahmed");
    const rideId = await makeRide(driver);
    const { token } = (await api("POST", `/rides/${rideId}/share`, driver.access)).json().data;

    await api("DELETE", `/rides/${rideId}/share`, driver.access);

    expect(
      (await app.inject({ method: "GET", url: `/api/v1/t/${token}` })).statusCode,
    ).toBe(404);
  });

  it("counts views, so the sharer knows whether anybody opened it", async () => {
    const driver = await makeUser(`ts-view-${Date.now()}@szabist.edu.pk`, "Bilal Ahmed");
    const rideId = await makeRide(driver);
    const { token } = (await api("POST", `/rides/${rideId}/share`, driver.access)).json().data;

    await app.inject({ method: "GET", url: `/api/v1/t/${token}` });
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect((await api("GET", `/rides/${rideId}/share`, driver.access)).json().data.viewCount)
      .toBeGreaterThan(0);
  });
});

describe("what a shared link reveals", () => {
  async function sharedTrip() {
    const stamp = Date.now();
    const driver = await makeUser(`tv-d-${stamp}@szabist.edu.pk`, "Bilal Ahmed");
    const rider = await makeUser(`tv-r-${stamp}@szabist.edu.pk`, "Sarmad Abbasi");
    const other = await makeUser(`tv-o-${stamp}@szabist.edu.pk`, "Hidden Passenger");
    const rideId = await makeRide(driver);

    for (const person of [rider, other]) {
      await AttendanceModel.create({
        rideInstanceId: rideId,
        userId: person.id,
        role: "passenger",
        status: "confirmed",
      });
    }

    const { token } = (await api("POST", `/rides/${rideId}/share`, rider.access)).json().data;
    const page = await app.inject({ method: "GET", url: `/api/v1/t/${token}` });
    return { page, body: page.body, data: page.json().data, driver, rider, other };
  }

  it("shows the journey: day, times, campus and area", async () => {
    const { data } = await sharedTrip();

    expect(data).toMatchObject({
      passenger: "Sarmad",
      day: "Mon",
      arriveBy: "08:00",
      campus: "Clifton Campus",
      fromArea: "Gulshan-e-Iqbal",
      status: "scheduled",
    });
  });

  it("names the driver by first name only, and masks the plate", async () => {
    const { data } = await sharedTrip();

    expect(data.driver.name).toBe("Bilal");
    expect(data.driver.vehicle).toMatchObject({
      model: "Toyota Corolla",
      colour: "White",
      // A full plate is how a stranger finds a car. The passenger can read it
      // out if they want to; a link cannot.
      plate: "BKT-••••",
    });
  });

  it("contains no phone number, email or surname", async () => {
    const { body } = await sharedTrip();

    expect(body).not.toContain("0300");
    expect(body).not.toContain("szabist.edu.pk");
    expect(body).not.toContain("Ahmed");
    expect(body).not.toContain("Abbasi");
  });

  it("never names the other passengers", async () => {
    const { body } = await sharedTrip();

    // A group of students' names is not the sharer's to give away, and the
    // recipient does not need them to notice somebody is late.
    expect(body).not.toContain("Hidden");
  });

  it("contains nothing resembling a position", async () => {
    const { body, data } = await sharedTrip();

    // Whole words only: "plate" contains "lat", and a masked plate is
    // something this response is supposed to carry.
    for (const forbidden of ["latitude", "longitude", "coordinate", "centroid", "geo"]) {
      expect(body.toLowerCase()).not.toContain(forbidden);
    }
    // Area granularity and no finer, which is all the product stores.
    expect(Object.keys(data).sort()).toEqual([
      "arriveBy",
      "campus",
      "day",
      "driver",
      "expiresAt",
      "fromArea",
      "leaveCampusAt",
      "passenger",
      "status",
    ]);
  });

  it("is not cacheable and not indexable", async () => {
    const { page } = await sharedTrip();

    // Revocable content behind a CDN would keep answering after revocation.
    expect(page.headers["cache-control"]).toContain("no-store");
    expect(page.headers["x-robots-tag"]).toContain("noindex");
  });

  it("answers the same way for an unknown token as a revoked one", async () => {
    const unknown = await app.inject({
      method: "GET",
      url: "/api/v1/t/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });

    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error.message).toBe("This link is no longer valid.");
  });
});

describe("the help button", () => {
  it("records the alert and returns the real emergency numbers", async () => {
    const person = await makeUser(`sos-${Date.now()}@szabist.edu.pk`, "Sarmad Abbasi");

    const response = await api("POST", "/safety/alerts", person.access, { kind: "sos" });

    expect(response.statusCode).toBe(200);
    const data = response.json().data;
    // The phone places the call. The app's job is to put the number one tap
    // away, which means it has to actually be here.
    expect(data.contacts.map((c: { number: string }) => c.number)).toContain("15");
    expect(await SafetyAlertModel.countDocuments({ userId: person.id, kind: "sos" })).toBe(1);
  });

  it("tells the institution's administrators", async () => {
    const stamp = Date.now();
    const admin = await makeUser(`sos-admin-${stamp}@szabist.edu.pk`, "Sana Rehman");
    await UserModel.updateOne({ _id: admin.id }, { $set: { role: "universityAdmin" } });
    const person = await makeUser(`sos-p-${stamp}@szabist.edu.pk`, "Sarmad Abbasi");

    const response = await api("POST", "/safety/alerts", person.access, { kind: "sos" });

    // Reported honestly, so the screen can say how many people were told
    // rather than implying a dispatch.
    expect(response.json().data.notified).toBeGreaterThan(0);

    const notifications = await app.inject({
      method: "GET",
      url: "/api/v1/notifications",
      headers: { authorization: `Bearer ${admin.access}` },
    });
    expect(notifications.json().data.some((n: { kind: string }) => n.kind === "safetyAlert")).toBe(true);
  });

  it("works with no ride attached, because somebody frightened cannot pick one", async () => {
    const person = await makeUser(`sos-nr-${Date.now()}@szabist.edu.pk`, "Sarmad Abbasi");

    const response = await api("POST", "/safety/alerts", person.access, {
      kind: "feelingUnsafe",
      note: "The driver took a different route.",
    });

    expect(response.statusCode).toBe(200);
  });

  it("ignores a ride that is not theirs rather than refusing the alert", async () => {
    const stamp = Date.now();
    const driver = await makeUser(`sos-d-${stamp}@szabist.edu.pk`, "Bilal Ahmed");
    const rideId = await makeRide(driver);
    const stranger = await makeUser(`sos-x-${stamp}@szabist.edu.pk`, "Sarmad Abbasi");

    const response = await api("POST", "/safety/alerts", stranger.access, {
      kind: "sos",
      rideInstanceId: rideId,
    });

    // The alert is what matters. A wrong ride id is dropped, not treated as a
    // reason to refuse somebody asking for help.
    expect(response.statusCode).toBe(200);
    const alert = await SafetyAlertModel.findOne({ userId: stranger.id });
    expect(alert!.rideInstanceId).toBeNull();
  });

  it("does not let a member read another member's alerts", async () => {
    const stamp = Date.now();
    const one = await makeUser(`sos-a-${stamp}@szabist.edu.pk`, "Person One");
    const two = await makeUser(`sos-b-${stamp}@szabist.edu.pk`, "Person Two");

    await api("POST", "/safety/alerts", one.access, { kind: "sos" });
    const theirs = await api("GET", "/safety/alerts", two.access);

    expect(theirs.json().data).toHaveLength(0);
  });

  it("never returns an administrator's resolution note to the member", async () => {
    const person = await makeUser(`sos-res-${Date.now()}@szabist.edu.pk`, "Sarmad Abbasi");
    await api("POST", "/safety/alerts", person.access, { kind: "sos" });
    await SafetyAlertModel.updateOne(
      { userId: person.id },
      { $set: { resolution: "Spoke to the driver's department head." } },
    );

    const mine = await api("GET", "/safety/alerts", person.access);

    // An administrator's note to other administrators, which may name a third
    // party.
    expect(mine.body).not.toContain("department head");
  });
});
