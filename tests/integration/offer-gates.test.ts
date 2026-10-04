import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app/app.js";
import { connectToDatabase, disconnectFromDatabase } from "../../src/db/mongodb.js";
import {
  AreaModel,
  AttendanceModel,
  CampusModel,
  InstitutionModel,
  RideInstanceModel,
  UserModel,
} from "../../src/db/models/index.js";

/**
 * Who is allowed to offer seats, and when they are allowed to stop.
 *
 * Two rules that exist to protect other people rather than the person doing
 * the thing, which is why both are enforced here and not only in the app. The
 * app hides the Offer tab behind the same conditions; a hidden button is a
 * courtesy, and this is the check.
 */

let app: FastifyInstance;
let institutionId: string;
let campusId: string;
let areaId: string;

type Person = { access: string; id: string };

const api = (
  method: "GET" | "POST" | "PATCH" | "PUT",
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

async function makeUser(email: string, verified: boolean): Promise<Person> {
  await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: {
      name: `${email.split("@")[0]} Person`,
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
    {
      $set: {
        emailVerifiedAt: new Date(),
        ...(verified ? { badgeStatus: "approved" } : {}),
      },
    },
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

async function giveVehicle(person: Person): Promise<string> {
  const saved = await api("PUT", "/vehicles", person.access, {
    type: "car",
    model: "Toyota Corolla",
    plate: "BKT-512",
    colour: "White",
  });
  return saved.json().data.id as string;
}

const SCHEDULE = [
  { day: "Mon", arriveBy: "08:00", leaveCampusAt: "17:00" },
  { day: "Wed", arriveBy: "08:00", leaveCampusAt: "17:00" },
];

function offerBody(vehicleId: string) {
  return {
    intent: "offer",
    direction: "both",
    campusId,
    originAreaId: areaId,
    schedule: SCHEDULE,
    vehicleId,
    seatsOffered: 3,
    contribution: 300,
    womenOnly: false,
  };
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

describe("verification before offering", () => {
  it("refuses an unverified member who tries to offer seats", async () => {
    const person = await makeUser(`og-unverified-${Date.now()}@szabist.edu.pk`, false);
    const vehicleId = await giveVehicle(person);

    const response = await api("POST", "/commutes", person.access, offerBody(vehicleId));

    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(response.json().error.message).toContain("Verify your student card");
  });

  it("says something different while a card is still being reviewed", async () => {
    const person = await makeUser(`og-pending-${Date.now()}@szabist.edu.pk`, false);
    await UserModel.updateOne({ _id: person.id }, { $set: { badgeStatus: "pending" } });
    const vehicleId = await giveVehicle(person);

    const response = await api("POST", "/commutes", person.access, offerBody(vehicleId));

    // Somebody who has already submitted should not be told to submit again.
    expect(response.json().error.message).toContain("still being reviewed");
  });

  it("lets a verified member offer", async () => {
    const person = await makeUser(`og-verified-${Date.now()}@szabist.edu.pk`, true);
    const vehicleId = await giveVehicle(person);

    const response = await api("POST", "/commutes", person.access, offerBody(vehicleId));

    expect(response.statusCode).toBe(200);
    expect(response.json().data.intent).toBe("offer");
  });

  it("still lets an unverified member find a ride", async () => {
    const person = await makeUser(`og-finder-${Date.now()}@szabist.edu.pk`, false);

    const response = await api("POST", "/commutes", person.access, {
      intent: "find",
      direction: "both",
      campusId,
      originAreaId: areaId,
      schedule: SCHEDULE,
      womenOnly: false,
    });

    // Gating passengers too would stall every pilot behind the verification
    // queue on day one.
    expect(response.statusCode).toBe(200);
  });

  it("refuses an unverified member switching an existing commute to offering", async () => {
    const person = await makeUser(`og-switch-${Date.now()}@szabist.edu.pk`, false);
    const created = await api("POST", "/commutes", person.access, {
      intent: "find",
      direction: "both",
      campusId,
      originAreaId: areaId,
      schedule: SCHEDULE,
      womenOnly: false,
    });
    const vehicleId = await giveVehicle(person);

    const response = await api(
      "PATCH",
      `/commutes/${created.json().data.id}`,
      person.access,
      { intent: "offer", vehicleId, seatsOffered: 3 },
    );

    // The gate has to hold on the way in through update as well, or it is a
    // gate on one door of two.
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
  });
});

describe("switching while people are relying on you", () => {
  it("refuses to stop offering while somebody holds a confirmed seat", async () => {
    const stamp = Date.now();
    const driver = await makeUser(`og-driver-${stamp}@szabist.edu.pk`, true);
    const rider = await makeUser(`og-rider-${stamp}@szabist.edu.pk`, false);
    const vehicleId = await giveVehicle(driver);

    const created = await api("POST", "/commutes", driver.access, offerBody(vehicleId));
    const commuteId = created.json().data.id as string;

    // A confirmed passenger on a future ride of this commute.
    const ride = await RideInstanceModel.findOne({ commuteId });
    await AttendanceModel.create({
      rideInstanceId: ride!._id,
      userId: rider.id,
      role: "passenger",
      status: "confirmed",
    });

    const response = await api("PATCH", `/commutes/${commuteId}`, driver.access, {
      intent: "find",
    });

    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(response.json().error.message).toContain("confirmed seat");
  });

  it("allows the switch once nobody is relying on it", async () => {
    const stamp = Date.now();
    const driver = await makeUser(`og-driver2-${stamp}@szabist.edu.pk`, true);
    const vehicleId = await giveVehicle(driver);

    const created = await api("POST", "/commutes", driver.access, offerBody(vehicleId));

    const response = await api(
      "PATCH",
      `/commutes/${created.json().data.id}`,
      driver.access,
      { intent: "find" },
    );

    expect(response.statusCode).toBe(200);
    expect(response.json().data.intent).toBe("find");
  });

  it("refuses to start offering while holding a seat in somebody else's car", async () => {
    const stamp = Date.now();
    const driver = await makeUser(`og-other-${stamp}@szabist.edu.pk`, true);
    const person = await makeUser(`og-both-${stamp}@szabist.edu.pk`, true);

    const driverVehicle = await giveVehicle(driver);
    const theirs = await api("POST", "/commutes", driver.access, offerBody(driverVehicle));
    const theirRide = await RideInstanceModel.findOne({
      commuteId: theirs.json().data.id,
    });

    await AttendanceModel.create({
      rideInstanceId: theirRide!._id,
      userId: person.id,
      role: "passenger",
      status: "confirmed",
    });

    const mine = await api("POST", "/commutes", person.access, {
      intent: "find",
      direction: "both",
      campusId,
      originAreaId: areaId,
      schedule: SCHEDULE,
      womenOnly: false,
    });
    const myVehicle = await giveVehicle(person);

    const response = await api(
      "PATCH",
      `/commutes/${mine.json().data.id}`,
      person.access,
      { intent: "offer", vehicleId: myVehicle, seatsOffered: 2 },
    );

    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(response.json().error.message).toContain("somebody else's car");
  });
});

describe("telling people you cannot make it", () => {
  it("records the reason without sending it to passengers", async () => {
    const stamp = Date.now();
    const driver = await makeUser(`og-off-${stamp}@szabist.edu.pk`, true);
    const rider = await makeUser(`og-off-rider-${stamp}@szabist.edu.pk`, false);
    const vehicleId = await giveVehicle(driver);

    const created = await api("POST", "/commutes", driver.access, offerBody(vehicleId));
    const commuteId = created.json().data.id as string;
    const ride = await RideInstanceModel.findOne({ commuteId, day: "Mon" });

    await AttendanceModel.create({
      rideInstanceId: ride!._id,
      userId: rider.id,
      role: "passenger",
      status: "confirmed",
    });

    const response = await api(
      "POST",
      `/commutes/${commuteId}/unavailable`,
      driver.access,
      { days: ["Mon"], reason: "Car is at the workshop all week" },
    );
    expect(response.statusCode).toBe(200);

    const after = await RideInstanceModel.findById(ride!._id).lean();
    expect(after!.status).toBe("noDriver");
    expect(after!.unavailableReason).toBe("Car is at the workshop all week");

    // The passenger learns the ride is off. They do not learn why — that is
    // between the driver and whoever runs the service.
    const theirNotifications = await api("GET", "/notifications", rider.access);
    expect(theirNotifications.body).not.toContain("workshop");
    expect(theirNotifications.body).toContain("cannot");
  });

  it("works without a reason, because somebody in a hurry should not be blocked", async () => {
    const driver = await makeUser(`og-noreason-${Date.now()}@szabist.edu.pk`, true);
    const vehicleId = await giveVehicle(driver);
    const created = await api("POST", "/commutes", driver.access, offerBody(vehicleId));

    const response = await api(
      "POST",
      `/commutes/${created.json().data.id}/unavailable`,
      driver.access,
      { days: ["Mon"] },
    );

    expect(response.statusCode).toBe(200);
  });
});

describe("verification by email domain", () => {
  /**
   * Confirms the address the way the OTP route does.
   *
   * The challenge registration created is cleared first: issuing a second code
   * inside the resend cooldown is refused, which is correct behaviour and has
   * nothing to do with what these tests are about.
   */
  async function confirmEmail(email: string) {
    const { OtpChallengeModel } = await import("../../src/db/models/index.js");
    await OtpChallengeModel.deleteOne({ email, purpose: "verifyEmail" });

    const { issueOtp } = await import("../../src/modules/auth/otp.service.js");
    const auth = await import("../../src/modules/auth/auth.service.js");
    const { code } = await issueOtp({ email, purpose: "verifyEmail" });
    return auth.verifyEmailOtp(email, code, { ip: "127.0.0.1", userAgent: "test" });
  }

  /** The real path: register, then confirm the emailed code. */
  async function registerAndVerify(email: string) {
    await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: {
        name: "Domain Person",
        email,
        password: "a-long-enough-passphrase",
        phone: "0300 5551234",
        userType: "student",
        institutionId,
        campusId,
        areaId,
      },
    });

    return email;
  }

  it("approves the badge when the institution's own email is confirmed", async () => {
    const email = `og-domain-${Date.now()}@szabist.edu.pk`;
    await registerAndVerify(email);

    // Before confirming, nothing is claimed.
    expect((await UserModel.findOne({ email }))!.badgeStatus).toBe("none");

    await confirmEmail(email);

    const user = await UserModel.findOne({ email });
    expect(user!.badgeStatus).toBe("approved");
    // No administrator reviewed this, and recording one who did not would make
    // the audit trail a lie.
    expect(user!.badgeReviewedBy).toBeNull();
    expect(user!.badgeReviewedAt).not.toBeNull();
  });

  it("lets a freshly verified member offer seats straight away", async () => {
    const email = `og-domain-offer-${Date.now()}@szabist.edu.pk`;
    await registerAndVerify(email);

    const session = await confirmEmail(email);

    const refreshed = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      payload: { token: session.token },
    });
    const access = refreshed.json().data.accessToken as string;

    const vehicle = await api("PUT", "/vehicles", access, {
      type: "car",
      model: "Honda City",
      plate: "AXB-704",
      colour: "Silver",
    });

    const response = await api(
      "POST",
      "/commutes",
      access,
      offerBody(vehicle.json().data.id as string),
    );

    // The whole point: a pilot has drivers on its first morning rather than
    // waiting for somebody to work a queue.
    expect(response.statusCode).toBe(200);
  });

  it("does not overturn a rejection an administrator made", async () => {
    const email = `og-rejected-${Date.now()}@szabist.edu.pk`;
    await registerAndVerify(email);
    await UserModel.updateOne({ email }, { $set: { badgeStatus: "rejected" } });

    await confirmEmail(email).catch(() => null);

    // A rejection is a decision about a specific person. Confirming an email
    // address is not grounds to quietly reverse it.
    expect((await UserModel.findOne({ email }))!.badgeStatus).toBe("rejected");
  });
});
