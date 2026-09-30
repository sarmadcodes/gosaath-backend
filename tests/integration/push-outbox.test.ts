import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app/app.js";
import { connectToDatabase, disconnectFromDatabase } from "../../src/db/mongodb.js";
import {
  AreaModel,
  CampusModel,
  InstitutionModel,
  NotificationModel,
  PushOutboxModel,
  PushTokenModel,
  UserModel,
} from "../../src/db/models/index.js";
import {
  drainPushOutbox,
  notify,
  setPushProvider,
} from "../../src/modules/notifications/notification.service.js";
import type {
  PushMessage,
  PushProvider,
  PushResult,
} from "../../src/services/push/push.types.js";

/**
 * Push delivery, made durable.
 *
 * The notification row is the record; the push is a nudge about it through a
 * third party that can be slow, refuse, or be unreachable. Everything here is
 * about keeping those two facts apart — a provider having a bad afternoon must
 * cost a nudge, never a notification, and never the seat request that caused
 * it.
 */

let app: FastifyInstance;
let institutionId: string;
let campusId: string;
let areaId: string;

class ControllablePush implements PushProvider {
  readonly name = "console" as const;
  sent: PushMessage[] = [];
  failures = 0;
  invalid: string[] = [];

  async send(message: PushMessage): Promise<PushResult> {
    if (this.failures > 0) {
      this.failures -= 1;
      throw new Error("provider is down");
    }
    this.sent.push(message);
    return { sent: message.tokens.length, invalidTokens: this.invalid };
  }
}

let push: ControllablePush;

async function makeUser(email: string): Promise<string> {
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
  const user = await UserModel.findOne({ email });
  return user!._id.toString();
}

/** A device to deliver to. Without one there is nothing to send. */
async function giveDevice(userId: string): Promise<void> {
  await PushTokenModel.create({
    token: `ExponentPushToken[${userId}]`,
    userId,
    platform: "ios",
  });
}

/** The immediate attempt is deliberately not awaited by `notify`. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 60));
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
  setPushProvider(null);
  await app.close();
  await disconnectFromDatabase();
});

beforeEach(async () => {
  push = new ControllablePush();
  setPushProvider(push);
  await PushOutboxModel.deleteMany({});
});

describe("queueing", () => {
  it("records the notification and queues the push", async () => {
    const userId = await makeUser(`po-basic-${Date.now()}@szabist.edu.pk`);
    await giveDevice(userId);

    await notify({
      userId,
      kind: "seatRequest",
      title: "Someone asked for a seat",
      body: "A member would like a seat.",
    });
    await settle();

    expect(await NotificationModel.countDocuments({ userId })).toBe(1);

    const row = await PushOutboxModel.findOne({ userId });
    expect(row).not.toBeNull();
    expect(row!.status).toBe("sent");
    expect(push.sent).toHaveLength(1);
  });

  it("carries the deep link so a tapped push opens the right screen", async () => {
    const userId = await makeUser(`po-link-${Date.now()}@szabist.edu.pk`);
    await giveDevice(userId);

    await notify({
      userId,
      kind: "requestAccepted",
      title: "You have a seat",
      body: "Your request was accepted.",
      payload: { requestId: "abc123" },
    });
    await settle();

    expect(push.sent[0]!.data).toMatchObject({
      kind: "requestAccepted",
      href: "/(tabs)/rides?tab=requests",
      requestId: "abc123",
    });
  });

  it("never puts anything private in the payload", async () => {
    const userId = await makeUser(`po-private-${Date.now()}@szabist.edu.pk`);
    await giveDevice(userId);

    await notify({
      userId,
      kind: "seatRequest",
      title: "Someone asked for a seat",
      body: "A member would like a seat.",
      payload: { requestId: "abc123" },
    });
    await settle();

    // The data object travels through Expo's servers. Ids and a destination
    // only — the title and body are what the person reads, and they are
    // already written to be safe on a lock screen.
    expect(Object.keys(push.sent[0]!.data ?? {}).sort()).toEqual([
      "href",
      "kind",
      "requestId",
    ]);
  });
});

describe("when the provider fails", () => {
  it("keeps the notification, and the row, for another attempt", async () => {
    const userId = await makeUser(`po-fail-${Date.now()}@szabist.edu.pk`);
    await giveDevice(userId);
    push.failures = 1;

    // Does not throw. A failed push must never surface as a failed operation.
    await notify({
      userId,
      kind: "seatRequest",
      title: "Someone asked for a seat",
      body: "A member would like a seat.",
    });
    await settle();

    expect(await NotificationModel.countDocuments({ userId })).toBe(1);

    const row = await PushOutboxModel.findOne({ userId });
    expect(row!.status).toBe("pending");
    expect(row!.attempts).toBe(1);
    expect(row!.lastError).toContain("provider is down");
  });

  it("delivers on a later drain once the provider recovers", async () => {
    const userId = await makeUser(`po-recover-${Date.now()}@szabist.edu.pk`);
    await giveDevice(userId);
    push.failures = 1;

    await notify({
      userId,
      kind: "rideReminder",
      title: "Tomorrow",
      body: "Your ride is at 08:00.",
    });
    await settle();
    expect(push.sent).toHaveLength(0);

    // The backoff would normally hold this back; the point being tested is
    // that the work survived, so it is made due.
    await PushOutboxModel.updateOne({ userId }, { $set: { nextAttemptAt: new Date(0) } });
    await drainPushOutbox();

    expect(push.sent).toHaveLength(1);
    expect((await PushOutboxModel.findOne({ userId }))!.status).toBe("sent");
  });

  it("backs off further with each failure", async () => {
    const userId = await makeUser(`po-backoff-${Date.now()}@szabist.edu.pk`);
    await giveDevice(userId);
    push.failures = 5;

    await notify({
      userId,
      kind: "rideReminder",
      title: "Tomorrow",
      body: "Your ride is at 08:00.",
    });
    await settle();

    const first = await PushOutboxModel.findOne({ userId });
    const firstDelay = first!.nextAttemptAt.getTime() - Date.now();

    await PushOutboxModel.updateOne({ userId }, { $set: { nextAttemptAt: new Date(0) } });
    await drainPushOutbox();

    const second = await PushOutboxModel.findOne({ userId });
    const secondDelay = second!.nextAttemptAt.getTime() - Date.now();

    expect(secondDelay).toBeGreaterThan(firstDelay);
  });

  it("gives up loudly rather than retrying forever", async () => {
    const userId = await makeUser(`po-giveup-${Date.now()}@szabist.edu.pk`);
    await giveDevice(userId);
    push.failures = 99;

    await notify({
      userId,
      kind: "rideReminder",
      title: "Tomorrow",
      body: "Your ride is at 08:00.",
    });
    await settle();

    for (let pass = 0; pass < 6; pass += 1) {
      await PushOutboxModel.updateOne({ userId }, { $set: { nextAttemptAt: new Date(0) } });
      await drainPushOutbox();
    }

    const row = await PushOutboxModel.findOne({ userId });
    expect(row!.status).toBe("failed");
    // The person was still told, in the place that matters.
    expect(await NotificationModel.countDocuments({ userId })).toBe(1);
  });

  it("stops retrying a row it has given up on", async () => {
    const userId = await makeUser(`po-stop-${Date.now()}@szabist.edu.pk`);
    await giveDevice(userId);
    push.failures = 99;

    await notify({ userId, kind: "rideReminder", title: "T", body: "B" });
    await settle();

    for (let pass = 0; pass < 6; pass += 1) {
      await PushOutboxModel.updateOne({ userId }, { $set: { nextAttemptAt: new Date(0) } });
      await drainPushOutbox();
    }

    const attemptsWhenFailed = (await PushOutboxModel.findOne({ userId }))!.attempts;
    await drainPushOutbox();

    expect((await PushOutboxModel.findOne({ userId }))!.attempts).toBe(attemptsWhenFailed);
  });
});

describe("delivery bookkeeping", () => {
  it("does not queue work forever for somebody with no device", async () => {
    const userId = await makeUser(`po-nodevice-${Date.now()}@szabist.edu.pk`);

    await notify({ userId, kind: "rideReminder", title: "T", body: "B" });
    await settle();

    // Nothing to deliver to is not a failure to retry: it will not change by
    // trying again in thirty seconds, and the notification is already waiting
    // in the app.
    const row = await PushOutboxModel.findOne({ userId });
    expect(row!.status).toBe("sent");
    expect(push.sent).toHaveLength(0);
  });

  it("retires a token the provider says is dead", async () => {
    const userId = await makeUser(`po-dead-${Date.now()}@szabist.edu.pk`);
    await giveDevice(userId);
    push.invalid = [`ExponentPushToken[${userId}]`];

    await notify({ userId, kind: "rideReminder", title: "T", body: "B" });
    await settle();

    const token = await PushTokenModel.findOne({ userId });
    expect(token!.invalidAt).not.toBeNull();
  });

  it("sends a queued push exactly once when two drains race", async () => {
    const userId = await makeUser(`po-race-${Date.now()}@szabist.edu.pk`);
    await giveDevice(userId);
    push.failures = 1;

    await notify({ userId, kind: "rideReminder", title: "T", body: "B" });
    await settle();

    await PushOutboxModel.updateOne({ userId }, { $set: { nextAttemptAt: new Date(0) } });

    // Two workers, or a worker and the immediate attempt. The claim is a
    // guarded update, so one of them does nothing.
    await Promise.all([drainPushOutbox(), drainPushOutbox()]);

    expect(push.sent).toHaveLength(1);
  });
});
