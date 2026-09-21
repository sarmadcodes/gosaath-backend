import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
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
  PushTokenModel,
  RideInstanceModel,
  SeatRequestModel,
  SessionModel,
  UserModel,
  VehicleModel,
} from "../../src/db/models/index.js";
import {
  relativeTime,
  setPushProvider,
} from "../../src/modules/notifications/notification.service.js";
import type {
  PushMessage,
  PushProvider,
  PushResult,
} from "../../src/services/push/push.types.js";

/**
 * Phase 7 gate.
 *
 * The list is the durable record; push is a best-effort nudge. The tests that
 * matter are the ones proving the second cannot damage the first.
 */

let app: FastifyInstance;
let institutionId: string;
let campusId: string;
let areaId: string;

type Person = { access: string; id: string };
let driver: Person;
let rider: Person;
let other: Person;

class RecordingPush implements PushProvider {
  readonly name = "console" as const;
  sent: PushMessage[] = [];
  invalid: string[] = [];
  failNext = false;

  async send(message: PushMessage): Promise<PushResult> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("provider is down");
    }
    this.sent.push(message);
    return { sent: message.tokens.length, invalidTokens: this.invalid };
  }
}

let push: RecordingPush;

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
  return {
    access: refresh.json().data.accessToken as string,
    id: user!._id.toString(),
  };
}

const SCHEDULE = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((day) => ({
  day,
  arriveBy: "08:00",
  leaveCampusAt: "17:00",
}));

async function offerRide(person: Person, seats = 3): Promise<string> {
  const vehicle = await VehicleModel.create({
    ownerId: person.id,
    type: "car",
    model: "Corolla",
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

/** The push dispatch is intentionally not awaited, so give it a tick. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

beforeAll(async () => {
  await connectToDatabase();
  app = await buildApp({ rateLimit: false });
  await app.ready();

  institutionId = (await InstitutionModel.findOne({ name: "SZABIST University" }))!._id.toString();
  campusId = (await CampusModel.findOne({ name: "Clifton Campus" }))!._id.toString();
  areaId = (await AreaModel.findOne({ name: "Gulshan-e-Iqbal" }))!._id.toString();
}, 60_000);

afterAll(async () => {
  setPushProvider(null);
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
  await PushTokenModel.deleteMany({});
  await VehicleModel.deleteMany({});
  await SessionModel.deleteMany({});

  push = new RecordingPush();
  setPushProvider(push);

  driver = await makeUser("driver@szabist.edu.pk");
  rider = await makeUser("rider@szabist.edu.pk");
  other = await makeUser("other@szabist.edu.pk");
});

afterEach(() => {
  setPushProvider(null);
});

describe("relativeTime", () => {
  const base = new Date("2026-09-21T12:00:00Z");
  const ago = (ms: number) => relativeTime(new Date(base.getTime() - ms), base);

  it("reads as a person would say it", () => {
    // The contract carries a phrase, not a timestamp, so the server owns the
    // wording and every screen shows the same thing.
    expect(ago(30 * 1000)).toBe("Just now");
    expect(ago(18 * 60 * 1000)).toBe("18 min ago");
    expect(ago(60 * 60 * 1000)).toBe("1 hour ago");
    expect(ago(5 * 60 * 60 * 1000)).toBe("5 hours ago");
    expect(ago(26 * 60 * 60 * 1000)).toBe("Yesterday");
    expect(ago(3 * 24 * 60 * 60 * 1000)).toBe("3 days ago");
    expect(ago(10 * 24 * 60 * 60 * 1000)).toBe("1 week ago");
  });

  it("never reads as being in the future", () => {
    // Clock skew between a client and the server should not produce
    // "-3 min ago".
    expect(relativeTime(new Date(base.getTime() + 60_000), base)).toBe("Just now");
  });
});

describe("the notification list", () => {
  it("is empty for a new account", async () => {
    const response = await api("GET", "/notifications", rider.access);
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual([]);
  });

  it("shows only the caller's own", async () => {
    const rideId = await offerRide(driver);
    await giveCommute(rider);
    await api("POST", `/rides/${rideId}/request`, rider.access, { seats: 1 });

    const driverList = (await api("GET", "/notifications", driver.access)).json().data;
    const otherList = (await api("GET", "/notifications", other.access)).json().data;

    expect(driverList).toHaveLength(1);
    expect(driverList[0].kind).toBe("seatRequest");
    expect(otherList).toEqual([]);
  });

  it("marks one read, idempotently", async () => {
    const rideId = await offerRide(driver);
    await giveCommute(rider);
    await api("POST", `/rides/${rideId}/request`, rider.access, { seats: 1 });

    const id = (await api("GET", "/notifications", driver.access)).json().data[0].id;

    expect((await api("POST", `/notifications/${id}/read`, driver.access)).statusCode).toBe(204);
    // Tapping twice is ordinary, not an error.
    expect((await api("POST", `/notifications/${id}/read`, driver.access)).statusCode).toBe(204);

    const after = (await api("GET", "/notifications", driver.access)).json().data[0];
    expect(after.unread).toBe(false);
  });

  it("cannot mark somebody else's as read", async () => {
    const rideId = await offerRide(driver);
    await giveCommute(rider);
    await api("POST", `/rides/${rideId}/request`, rider.access, { seats: 1 });

    const id = (await api("GET", "/notifications", driver.access)).json().data[0].id;

    // 204 either way — the query is scoped, so it simply matches nothing. A
    // distinct error would confirm the id is real and belongs to somebody.
    await api("POST", `/notifications/${id}/read`, other.access);

    const stillUnread = await NotificationModel.findById(id);
    expect(stillUnread!.unread).toBe(true);
  });

  it("carries a phrase rather than a timestamp", async () => {
    const rideId = await offerRide(driver);
    await giveCommute(rider);
    await api("POST", `/rides/${rideId}/request`, rider.access, { seats: 1 });

    const item = (await api("GET", "/notifications", driver.access)).json().data[0];
    expect(item.time).toBe("Just now");
    expect(item).not.toHaveProperty("createdAt");
  });
});

describe("the seat request flow notifies the right person", () => {
  it("tells the DRIVER when a seat is requested", async () => {
    const rideId = await offerRide(driver);
    await giveCommute(rider);
    await api("POST", `/rides/${rideId}/request`, rider.access, { seats: 1 });

    const forDriver = await NotificationModel.find({ userId: driver.id }).lean();
    const forRider = await NotificationModel.find({ userId: rider.id }).lean();

    // The person who has to act is the person told.
    expect(forDriver).toHaveLength(1);
    expect(forDriver[0]!.kind).toBe("seatRequest");
    expect(forRider).toHaveLength(0);
  });

  it("tells the RIDER when accepted", async () => {
    const rideId = await offerRide(driver);
    await giveCommute(rider);
    const created = await api("POST", `/rides/${rideId}/request`, rider.access, {
      seats: 1,
    });
    await api("POST", `/requests/${created.json().data.id}/respond`, driver.access, {
      action: "accept",
    });

    const forRider = await NotificationModel.find({ userId: rider.id }).lean();
    expect(forRider).toHaveLength(1);
    expect(forRider[0]!.kind).toBe("requestAccepted");
  });

  it("tells the RIDER when declined, without a reason", async () => {
    const rideId = await offerRide(driver);
    await giveCommute(rider);
    const created = await api("POST", `/rides/${rideId}/request`, rider.access, {
      seats: 1,
    });
    await api("POST", `/requests/${created.json().data.id}/respond`, driver.access, {
      action: "decline",
    });

    const forRider = await NotificationModel.find({ userId: rider.id }).lean();
    expect(forRider[0]!.kind).toBe("requestDeclined");
    // The driver does not owe a reason, and inventing one would be worse than
    // the silence.
    expect(forRider[0]!.body.toLowerCase()).not.toContain("because");
  });

  it("uses first names only", async () => {
    const rideId = await offerRide(driver);
    await giveCommute(rider);
    await api("POST", `/rides/${rideId}/request`, rider.access, { seats: 1 });

    const notification = await NotificationModel.findOne({ userId: driver.id });
    expect(notification!.body).toContain("rider");
    // "rider Person" is the full name; only the first part may appear.
    expect(notification!.body).not.toContain("Person");
  });
});

describe("push delivery", () => {
  it("registers a device token", async () => {
    const response = await api("POST", "/notifications/token", rider.access, {
      token: "ExponentPushToken[abcdefghijklmnop]",
      platform: "ios",
    });

    expect(response.statusCode).toBe(204);
    expect(await PushTokenModel.countDocuments({ userId: rider.id })).toBe(1);
  });

  it("rejects something that is not a push token", async () => {
    // This value is later sent to a third party on somebody's behalf, so it
    // is validated rather than stored as any string.
    const response = await api("POST", "/notifications/token", rider.access, {
      token: "not-a-real-token",
      platform: "ios",
    });
    expect(response.statusCode).toBe(400);
  });

  it("reassigns a shared device rather than stacking tokens", async () => {
    const token = "ExponentPushToken[shared-device-0001]";
    await api("POST", "/notifications/token", rider.access, { token, platform: "android" });
    await api("POST", "/notifications/token", other.access, { token, platform: "android" });

    const rows = await PushTokenModel.find({ token }).lean();
    // One device, one row. Otherwise the previous account keeps being
    // notified on a phone that is no longer theirs.
    expect(rows).toHaveLength(1);
    expect(rows[0]!.userId.toString()).toBe(other.id);
  });

  it("unregisters only the caller's own token", async () => {
    const token = "ExponentPushToken[mine-0002]";
    await api("POST", "/notifications/token", rider.access, { token, platform: "ios" });

    await api("DELETE", "/notifications/token", other.access, { token });
    expect(await PushTokenModel.countDocuments({ token })).toBe(1);

    await api("DELETE", "/notifications/token", rider.access, { token });
    expect(await PushTokenModel.countDocuments({ token })).toBe(0);
  });

  it("sends to a registered device when something happens", async () => {
    await api("POST", "/notifications/token", driver.access, {
      token: "ExponentPushToken[driver-device]",
      platform: "ios",
    });

    const rideId = await offerRide(driver);
    await giveCommute(rider);
    await api("POST", `/rides/${rideId}/request`, rider.access, { seats: 1 });
    await settle();

    expect(push.sent).toHaveLength(1);
    expect(push.sent[0]!.tokens).toEqual(["ExponentPushToken[driver-device]"]);
    // A deep link and a kind. Ids only — this travels through Expo's servers.
    expect(push.sent[0]!.data["kind"]).toBe("seatRequest");
    expect(push.sent[0]!.data["href"]).toContain("/rides");
  });

  it("retires a token the provider reports as dead", async () => {
    const token = "ExponentPushToken[uninstalled]";
    await api("POST", "/notifications/token", driver.access, { token, platform: "android" });
    push.invalid = [token];

    const rideId = await offerRide(driver);
    await giveCommute(rider);
    await api("POST", `/rides/${rideId}/request`, rider.access, { seats: 1 });
    await settle();

    const row = await PushTokenModel.findOne({ token });
    // Retired rather than deleted, so a token that comes back to life is
    // visible rather than silently recreated.
    expect(row!.invalidAt).not.toBeNull();
  });

  it("a failing push provider does not fail the action", async () => {
    await api("POST", "/notifications/token", driver.access, {
      token: "ExponentPushToken[driver-device]",
      platform: "ios",
    });
    push.failNext = true;

    const rideId = await offerRide(driver);
    await giveCommute(rider);
    const response = await api("POST", `/rides/${rideId}/request`, rider.access, {
      seats: 1,
    });
    await settle();

    // The seat request still succeeded, and the in-app notification still
    // exists. A third party having a bad afternoon must not break the product.
    expect(response.statusCode).toBe(200);
    expect(await NotificationModel.countDocuments({ userId: driver.id })).toBe(1);
  });

  it("does not wait on the provider", async () => {
    await api("POST", "/notifications/token", driver.access, {
      token: "ExponentPushToken[slow-device]",
      platform: "ios",
    });

    // Typed through a holder: TS narrows a plain `let` assigned only inside
    // the callback down to `never` at the call site below.
    const gate: { release: (() => void) | null } = { release: null };
    setPushProvider({
      name: "console",
      async send() {
        // Hangs until the assertion below has already run.
        await new Promise<void>((resolve) => {
          gate.release = resolve;
        });
        return { sent: 0, invalidTokens: [] };
      },
    });

    const rideId = await offerRide(driver);
    await giveCommute(rider);

    const started = Date.now();
    const response = await api("POST", `/rides/${rideId}/request`, rider.access, {
      seats: 1,
    });
    const elapsed = Date.now() - started;

    expect(response.statusCode).toBe(200);
    // The request returned while the provider is still hanging. Awaiting the
    // push would hold this open indefinitely.
    expect(elapsed).toBeLessThan(10_000);

    gate.release?.();
    setPushProvider(push);
  });
});
