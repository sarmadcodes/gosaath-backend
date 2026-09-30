import { Types } from "mongoose";
import { logger } from "../../utils/logger.js";
import {
  NotificationModel,
  PushOutboxModel,
  PushTokenModel,
} from "../../db/models/index.js";
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

  // Queued, then attempted immediately.
  //
  // The row is what makes delivery durable: a restart between here and the
  // send, or a provider outage, leaves work the drain picks up rather than a
  // push that silently never happened. The immediate attempt is what keeps it
  // fast — a queue that only delivers on the next worker tick would turn a
  // seat request into a notification that arrives a minute later.
  const queued = await PushOutboxModel.create({
    userId: input.userId,
    kind: input.kind,
    title: input.title,
    body: input.body,
    data: pushData(input),
  });

  void deliver(queued._id).catch((error: unknown) => {
    // Already recorded against the row; this is only so it appears in the log
    // beside the request that caused it.
    logger.warn({ err: error, kind: input.kind }, "immediate push attempt failed");
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

/** What travels to the device: ids and a destination, never anything private. */
function pushData(input: NotifyInput): Record<string, string> {
  return {
    kind: input.kind,
    ...(DESTINATIONS[input.kind] ? { href: DESTINATIONS[input.kind]! } : {}),
    ...(input.payload ?? {}),
  };
}

/**
 * How long to wait before trying a failed push again.
 *
 * Exponential, and capped: a notification that has not been delivered in an
 * hour is about a ride that has probably already happened, so there is no
 * value in trying every minute until then.
 */
const RETRY_DELAYS_MS = [30_000, 2 * 60_000, 10 * 60_000, 30 * 60_000];

/** Given up on after this many attempts, and left visible as failed. */
const MAX_ATTEMPTS = 5;

/**
 * A row claimed but never finished — the process died mid-send. Released after
 * this, so a crash costs a delay rather than a notification.
 */
const CLAIM_TIMEOUT_MS = 2 * 60_000;

/**
 * Attempts one queued push.
 *
 * Claimed with a guarded update whose filter is the state it is leaving, so
 * two workers — or a worker and the immediate attempt — cannot both send the
 * same row. Whoever loses the race simply does nothing.
 */
async function deliver(id: Types.ObjectId): Promise<void> {
  const claimed = await PushOutboxModel.findOneAndUpdate(
    {
      _id: id,
      status: { $in: ["pending", "sending"] },
      $or: [
        { claimedAt: null },
        { claimedAt: { $lt: new Date(Date.now() - CLAIM_TIMEOUT_MS) } },
      ],
    },
    { $set: { status: "sending", claimedAt: new Date() }, $inc: { attempts: 1 } },
    { new: true },
  );

  if (!claimed) return;

  const tokens = await PushTokenModel.find({
    userId: claimed.userId,
    invalidAt: null,
  })
    .select("token")
    .lean();

  if (tokens.length === 0) {
    // Nothing to deliver to. Not a failure to retry: the person has simply not
    // opened the app on a device yet, and that will not change by trying
    // again in thirty seconds. The in-app notification is already waiting.
    await PushOutboxModel.updateOne(
      { _id: claimed._id },
      { $set: { status: "sent", sentAt: new Date(), claimedAt: null } },
    );
    return;
  }

  try {
    const result = await pushProvider().send({
      tokens: tokens.map((row) => row.token),
      title: claimed.title,
      body: claimed.body,
      data: (claimed.data as Record<string, string>) ?? { kind: claimed.kind },
    });

    if (result.invalidTokens.length > 0) {
      // Retired rather than deleted, so a token that comes back to life is
      // visible rather than silently recreated.
      await PushTokenModel.updateMany(
        { token: { $in: result.invalidTokens } },
        { $set: { invalidAt: new Date() } },
      );
      logger.info({ retired: result.invalidTokens.length }, "push tokens retired");
    }

    await PushOutboxModel.updateOne(
      { _id: claimed._id },
      { $set: { status: "sent", sentAt: new Date(), claimedAt: null } },
    );
  } catch (error) {
    const attempts = claimed.attempts;
    const givenUp = attempts >= MAX_ATTEMPTS;

    await PushOutboxModel.updateOne(
      { _id: claimed._id },
      {
        $set: {
          status: givenUp ? "failed" : "pending",
          claimedAt: null,
          nextAttemptAt: new Date(
            Date.now() + (RETRY_DELAYS_MS[attempts - 1] ?? RETRY_DELAYS_MS.at(-1)!),
          ),
          lastError: String(error).slice(0, 300),
        },
      },
    );

    if (givenUp) {
      // Loud, because this is the point at which somebody was not told
      // something. The notification is still in their list.
      logger.error(
        { outboxId: claimed._id.toString(), kind: claimed.kind, attempts },
        "push delivery given up on",
      );
    }
  }
}

/**
 * Sends everything that is due.
 *
 * Run from the scheduler tick. Bounded per pass so one backlog cannot occupy
 * the process: whatever is left is still due on the next tick.
 */
export async function drainPushOutbox(limit = 100): Promise<{
  attempted: number;
}> {
  const due = await PushOutboxModel.find({
    status: { $in: ["pending", "sending"] },
    nextAttemptAt: { $lte: new Date() },
  })
    .sort({ nextAttemptAt: 1 })
    .limit(limit)
    .select("_id")
    .lean();

  for (const row of due) {
    await deliver(row._id as Types.ObjectId);
  }

  return { attempted: due.length };
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
