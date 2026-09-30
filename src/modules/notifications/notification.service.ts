import { Types } from "mongoose";
import { logger } from "../../utils/logger.js";
import { NotificationModel, PushTokenModel } from "../../db/models/index.js";
import { ConsolePushProvider, ExpoPushProvider } from "../../services/push/expo.provider.js";
import type { PushProvider } from "../../services/push/push.types.js";
import { publish } from "../realtime/hub.js";
import type { AppNotification, NotificationKind } from "../../contract/types.js";

/**
 * Notifications.
 *
 * Two halves that must not be confused: the in-app list, which is a durable
 * record in MongoDB, and push delivery, which is a best-effort nudge through a
 * third party. The list is the source of truth — a push that never arrives
 * loses a nudge, not the notification.
 */

let provider: PushProvider | null = null;

function pushProvider(): PushProvider {
  if (!provider) {
    // Expo everywhere except development, where logging is more useful than a
    // request to a service that has no device to deliver to.
    provider =
      process.env["NODE_ENV"] === "development" || process.env["NODE_ENV"] === "test"
        ? new ConsolePushProvider()
        : new ExpoPushProvider();
    logger.info({ provider: provider.name }, "push provider ready");
  }
  return provider;
}

/** Lets a test substitute a provider without touching the environment. */
export function setPushProvider(next: PushProvider | null): void {
  provider = next;
}

/** Where each kind of notification deep-links to, mirrored in the app. */
const DESTINATIONS: Partial<Record<NotificationKind, string>> = {
  seatRequest: "/(tabs)/rides?tab=requests",
  requestAccepted: "/(tabs)/rides?tab=requests",
  requestDeclined: "/(tabs)/rides?tab=requests",
  driverUnavailable: "/driver/replacement",
  replacementAvailable: "/driver/replacement",
  tomorrowCommute: "/(tabs)/commute",
  rideReminder: "/(tabs)",
  cancellation: "/(tabs)/commute",
  badgeUpdate: "/verification",
  institutionApproved: "/institutions",
};

export type NotifyInput = {
  userId: Types.ObjectId | string;
  kind: NotificationKind;
  title: string;
  body: string;
  /** Ids only. This travels through a third party's servers. */
  payload?: Record<string, string>;
};

/**
 * Records a notification and nudges the device.
 *
 * The row is written and awaited; the push is dispatched afterwards and
 * deliberately NOT awaited. A driver tapping Accept must not wait on Expo, and
 * a push provider having a bad afternoon must not turn an accepted seat into a
 * failed request.
 */
export async function notify(input: NotifyInput): Promise<AppNotification> {
  const created = await NotificationModel.create({
    userId: input.userId,
    kind: input.kind,
    title: input.title,
    body: input.body,
    unread: true,
    payload: input.payload ?? null,
  });

  // The live nudge, to any screen this person currently has open. Sent before
  // the push, and separately from it: a device with the app in the foreground
  // should update immediately rather than wait for a round trip through Expo,
  // and in practice often never gets a push at all because iOS suppresses it
  // while the app is frontmost.
  publish(
    { kind: "user", userId: String(input.userId) },
    { type: "notification.created", unread: await unreadCount(input.userId) },
  );

  // Fire and forget, on purpose.
  //
  // NOT durable: a process restart between the write and the send loses the
  // push, though never the notification itself. A real queue (BullMQ on Redis)
  // slots in here behind the same call and is the upgrade when push delivery
  // starts mattering more than the in-app list.
  void dispatchPush(input).catch((error: unknown) => {
    logger.warn({ err: error, kind: input.kind }, "push dispatch failed");
  });

  return toNotification(created.toObject());
}

/**
 * `notify` for callers whose own work has already committed.
 *
 * Once a seat request is saved or answered, that is the real outcome — the
 * notification is an alert about it. If writing the alert fails, reporting the
 * whole action as failed would be false, and the client's retry would then
 * hit "already asked" or "already answered". So it is logged and swallowed.
 */
export async function notifyQuietly(input: NotifyInput): Promise<void> {
  try {
    await notify(input);
  } catch (error) {
    logger.error({ err: error, kind: input.kind }, "notification write failed");
  }
}

async function dispatchPush(input: NotifyInput): Promise<void> {
  const tokens = await PushTokenModel.find({
    userId: input.userId,
    invalidAt: null,
  })
    .select("token")
    .lean();

  if (tokens.length === 0) return;

  const result = await pushProvider().send({
    tokens: tokens.map((row) => row.token),
    title: input.title,
    body: input.body,
    data: {
      kind: input.kind,
      ...(DESTINATIONS[input.kind] ? { href: DESTINATIONS[input.kind]! } : {}),
      ...(input.payload ?? {}),
    },
  });

  if (result.invalidTokens.length > 0) {
    // Retired rather than deleted, so a token that comes back to life is
    // visible rather than silently recreated.
    await PushTokenModel.updateMany(
      { token: { $in: result.invalidTokens } },
      { $set: { invalidAt: new Date() } },
    );
    logger.info(
      { retired: result.invalidTokens.length },
      "push tokens retired",
    );
  }
}

/**
 * "18 min ago", "Yesterday", "2 days ago".
 *
 * Computed here because the contract carries a phrase, not a timestamp — the
 * same choice as `ProximityEstimate.label`. The client renders what it is
 * given rather than each screen inventing its own formatting, and the phrase
 * stays consistent everywhere it appears.
 */
export function relativeTime(from: Date, now = new Date()): string {
  const seconds = Math.max(0, Math.floor((now.getTime() - from.getTime()) / 1000));

  if (seconds < 60) return "Just now";

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;

  const days = Math.floor(hours / 24);
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;

  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks} ${weeks === 1 ? "week" : "weeks"} ago`;

  const months = Math.floor(days / 30);
  return `${months} ${months === 1 ? "month" : "months"} ago`;
}

function toNotification(doc: {
  _id: { toString(): string };
  kind: string;
  title: string;
  body: string;
  unread: boolean;
  createdAt: Date;
}): AppNotification {
  return {
    id: doc._id.toString(),
    kind: doc.kind as NotificationKind,
    title: doc.title,
    body: doc.body,
    time: relativeTime(doc.createdAt),
    unread: doc.unread,
  };
}

export async function listNotifications(
  userId: string,
): Promise<AppNotification[]> {
  const rows = await NotificationModel.find({ userId })
    .sort({ createdAt: -1 })
    .limit(100)
    .lean();

  return rows.map(toNotification);
}

/**
 * Marks one as read.
 *
 * Idempotent, and scoped to the caller in the query itself. Marking an already
 * read notification is a no-op rather than an error the client has to handle —
 * it happens every time somebody taps twice.
 */
export async function markRead(userId: string, id: string): Promise<void> {
  await NotificationModel.updateOne(
    { _id: id, userId },
    { $set: { unread: false } },
  );

  // So a second device showing a badge of 3 drops to 2 without being touched.
  publish(
    { kind: "user", userId },
    { type: "notification.read", unread: await unreadCount(userId) },
  );
}

/**
 * Marks everything read at once.
 *
 * Scoped to unread rows rather than all of them, so the write touches only
 * what changes — and so the returned count is the number actually cleared.
 */
export async function markAllRead(userId: string): Promise<number> {
  const result = await NotificationModel.updateMany(
    { userId, unread: true },
    { $set: { unread: false } },
  );

  publish({ kind: "user", userId }, { type: "notification.read", unread: 0 });

  return result.modifiedCount;
}

/**
 * How many are unread.
 *
 * Counted rather than stored on the user, because a denormalised counter is a
 * counter that drifts: every path that creates, reads or deletes a
 * notification would have to maintain it, and the one that forgets leaves a
 * badge showing 1 forever. Supported by the `{ userId, unread }` index.
 */
export async function unreadCount(
  userId: Types.ObjectId | string,
): Promise<number> {
  return NotificationModel.countDocuments({ userId, unread: true });
}

/**
 * Stores a device's push token.
 *
 * Upserted on the TOKEN, not the user: a device is handed to more than one
 * person over its life, and logging in on a shared phone must reassign it
 * rather than leave the previous account being notified.
 */
export async function registerPushToken(
  userId: string,
  token: string,
  platform: "ios" | "android",
): Promise<void> {
  await PushTokenModel.findOneAndUpdate(
    { token },
    {
      $set: {
        userId,
        platform,
        lastSeenAt: new Date(),
        // A token reappearing means the device is alive again.
        invalidAt: null,
      },
      $setOnInsert: { token },
    },
    { upsert: true, setDefaultsOnInsert: true },
  );
}

/** Called on logout, so a shared device stops receiving the last user's alerts. */
export async function unregisterPushToken(
  userId: string,
  token: string,
): Promise<void> {
  await PushTokenModel.deleteOne({ token, userId });
}
