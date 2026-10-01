import {
  AttendanceModel,
  RideInstanceModel,
  UserModel,
} from "../../db/models/index.js";
import { instantAt } from "../../utils/dates.js";
import { withLock } from "../../utils/lock.js";
import { logger } from "../../utils/logger.js";
import { drainPushOutbox, notifyQuietly } from "../notifications/notification.service.js";
import { generateAllInstances } from "./instance.service.js";

/**
 * The recurring engine (SYSTEM.md 4.3).
 *
 * Everything a commute needs to keep running without anyone opening the app:
 * tomorrow's rides exist, a seat is confirmed before the night is out, a ride
 * nobody can drive is flagged and its passengers told, and people are
 * reminded before they need to leave.
 *
 * **Safe to run repeatedly.** Every step claims its work with a guarded
 * update whose filter includes the marker it is about to set, so a second
 * run — a restart, an overlapping tick, two processes — matches nothing and
 * does nothing. Nobody is reminded twice about the same ride. This matters
 * more than it sounds: a duplicate reminder at 6am teaches people to ignore
 * the next one.
 *
 * Notifications never fail the step that produced them. A ride being
 * confirmed is a fact about the ride; telling someone is a side effect, and a
 * notification store that is briefly down must not leave a confirmed ride
 * looking unconfirmed on the next pass.
 */

/** How far ahead a ride is confirmed automatically. SYSTEM.md 4.3.3. */
const AUTO_CONFIRM_HOURS = 12;
/** How far ahead a ride with no driver is worth flagging. SYSTEM.md 4.3.4. */
const ORPHAN_HORIZON_DAYS = 7;
/** The two reminder waves. SYSTEM.md 4.3.6. */
const REMINDER_HOURS_BEFORE = 12;
const REMINDER_MINUTES_BEFORE = 20;
/**
 * How late a reminder may still be sent.
 *
 * Without this, a scheduler that was down overnight comes back and sends
 * every missed reminder at once — including for rides that have already
 * happened. A reminder for a ride that left an hour ago is worse than none.
 */
const REMINDER_GRACE_MINUTES = 45;

export type SchedulerResult = {
  generated: { commutes: number; created: number };
  confirmed: number;
  orphansFlagged: number;
  remindersSent: { dayBefore: number; departure: number };
};

/** When this ride actually leaves, or null if it has no time set. */
function departureOf(instance: {
  date: Date;
  arriveBy?: string | null;
  leaveCampusAt?: string | null;
}): Date | null {
  // The morning run is the one people need waking up for. A return-only
  // commute is reminded against its campus departure instead.
  return instantAt(instance.date, instance.arriveBy ?? instance.leaveCampusAt);
}

function firstNameOf(name: string | undefined): string {
  return name?.trim().split(/\s+/)[0] ?? "Your driver";
}

/**
 * Confirms attendance on rides leaving within the next 12 hours.
 *
 * A passenger who asked for a seat and was accepted should not have to
 * confirm again the night before. The driver's own attendance is confirmed
 * with it, so the week view stops showing their own ride as provisional.
 */
export async function autoConfirmDueRides(now = new Date()): Promise<number> {
  const horizon = new Date(now.getTime() + AUTO_CONFIRM_HOURS * 60 * 60 * 1000);

  const due = await RideInstanceModel.find({
    status: "scheduled",
    date: { $gte: new Date(now.getTime() - 24 * 60 * 60 * 1000), $lte: horizon },
    autoConfirmedAt: null,
  })
    .select("_id date arriveBy leaveCampusAt")
    .lean();

  let confirmed = 0;

  for (const instance of due) {
    const departure = departureOf(instance);
    // Not yet inside the window, or already gone.
    if (!departure || departure <= now || departure > horizon) continue;

    // The marker's absence is the filter, so only one caller can claim it.
    const claimed = await RideInstanceModel.findOneAndUpdate(
      { _id: instance._id, autoConfirmedAt: null },
      { $set: { autoConfirmedAt: now } },
    ).lean();
    if (!claimed) continue;

    await AttendanceModel.updateMany(
      { rideInstanceId: instance._id, status: "pending" },
      { $set: { status: "confirmed" } },
    );
    confirmed += 1;
  }

  return confirmed;
}

/**
 * Finds rides inside the next week that nobody can drive, and says so.
 *
 * `noDriver` is set the moment a driver declares themselves unavailable, and
 * their passengers are told then. This catches the rest: a ride whose driver
 * cancelled their commute, or one flagged while the passenger had not yet
 * joined. Silence here is the failure mode that strands somebody.
 */
export async function flagOrphanRides(now = new Date()): Promise<number> {
  const horizon = new Date(now.getTime() + ORPHAN_HORIZON_DAYS * 24 * 60 * 60 * 1000);

  const orphans = await RideInstanceModel.find({
    status: "noDriver",
    date: { $gte: now, $lte: horizon },
    orphanNotifiedAt: null,
  })
    .select("_id date day")
    .lean();

  let flagged = 0;

  for (const orphan of orphans) {
    const claimed = await RideInstanceModel.findOneAndUpdate(
      { _id: orphan._id, orphanNotifiedAt: null },
      { $set: { orphanNotifiedAt: now } },
    ).lean();
    if (!claimed) continue;

    const riders = await AttendanceModel.find({
      rideInstanceId: orphan._id,
      role: "passenger",
    })
      .select("userId")
      .lean();

    await Promise.all(
      [...new Set(riders.map((r) => r.userId.toString()))].map((userId) =>
        notifyQuietly({
          userId,
          kind: "replacementAvailable",
          title: "Your ride needs a driver",
          body: `Nobody is driving your ${orphan.day} commute yet. Tap to look for cover.`,
        }),
      ),
    );
    flagged += 1;
  }

  return flagged;
}

/**
 * The two reminder waves: the night before, and just before leaving.
 *
 * Both go to everybody travelling — driver included, since the driver is the
 * person whose forgetting strands the others.
 */
async function sendReminderWave(
  now: Date,
  options: {
    offsetMs: number;
    marker: "remindedDayBeforeAt" | "remindedAtDepartureAt";
    title: string;
    body: (driverName: string, time: string) => string;
  },
): Promise<number> {
  const target = new Date(now.getTime() + options.offsetMs);
  const graceMs = REMINDER_GRACE_MINUTES * 60 * 1000;

  const candidates = await RideInstanceModel.find({
    status: "scheduled",
    // A generous date window; the exact instant is checked below, because
    // `date` is midnight and the departure time lives on the row.
    date: {
      $gte: new Date(now.getTime() - 24 * 60 * 60 * 1000),
      $lte: new Date(target.getTime() + 24 * 60 * 60 * 1000),
    },
    [options.marker]: null,
  })
    .select("_id date day arriveBy leaveCampusAt driverId")
    .lean();

  let sent = 0;

  for (const instance of candidates) {
    const departure = departureOf(instance);
    if (!departure) continue;

    const dueAt = departure.getTime() - options.offsetMs;
    // Due now, or overdue but not by so much that the ride has gone.
    if (dueAt > now.getTime() || now.getTime() - dueAt > graceMs) continue;
    if (departure <= now) continue;

    const claimed = await RideInstanceModel.findOneAndUpdate(
      { _id: instance._id, [options.marker]: null },
      { $set: { [options.marker]: now } },
    ).lean();
    if (!claimed) continue;

    const travelling = await AttendanceModel.find({
      rideInstanceId: instance._id,
      status: { $in: ["confirmed", "pending"] },
    })
      .select("userId")
      .lean();

    const recipients = new Set(travelling.map((row) => row.userId.toString()));
    recipients.add(instance.driverId.toString());
    if (recipients.size === 0) continue;

    const driver = await UserModel.findById(instance.driverId).select("name").lean();
    const time = instance.arriveBy ?? instance.leaveCampusAt ?? "";

    await Promise.all(
      [...recipients].map((userId) =>
        notifyQuietly({
          userId,
          kind: userId === instance.driverId.toString() ? "tomorrowCommute" : "rideReminder",
          title: options.title,
          body: options.body(firstNameOf(driver?.name), time),
        }),
      ),
    );
    sent += 1;
  }

  return sent;
}

export async function sendDueReminders(
  now = new Date(),
): Promise<{ dayBefore: number; departure: number }> {
  const dayBefore = await sendReminderWave(now, {
    offsetMs: REMINDER_HOURS_BEFORE * 60 * 60 * 1000,
    marker: "remindedDayBeforeAt",
    title: "Commute tomorrow",
    body: (_driver, time) =>
      time ? `You are travelling tomorrow, arriving by ${time}.` : "You are travelling tomorrow.",
  });

  const departure = await sendReminderWave(now, {
    offsetMs: REMINDER_MINUTES_BEFORE * 60 * 1000,
    marker: "remindedAtDepartureAt",
    title: "Leaving soon",
    body: (driver, time) =>
      time
        ? `${driver} is leaving in about ${REMINDER_MINUTES_BEFORE} minutes, arriving by ${time}.`
        : `${driver} is leaving in about ${REMINDER_MINUTES_BEFORE} minutes.`,
  });

  return { dayBefore, departure };
}

/**
 * One pass of the whole engine.
 *
 * Ordered deliberately: generate first so a ride created this minute can be
 * confirmed and reminded in the same pass, and flag orphans before reminding,
 * so nobody is reminded about a ride that has no driver.
 */
export async function runScheduler(now = new Date()): Promise<SchedulerResult> {
  const generated = await generateAllInstances();
  const orphansFlagged = await flagOrphanRides(now);
  const confirmed = await autoConfirmDueRides(now);
  const remindersSent = await sendDueReminders(now);

  // Last, so anything this pass queued gets its first retry here rather than
  // waiting a full tick. This is what makes push delivery survive a restart or
  // a provider outage: the rows are already written, and this is what drains
  // them.
  const pushes = await drainPushOutbox();

  logger.info(
    {
      generated: generated.created,
      confirmed,
      orphansFlagged,
      reminders: remindersSent,
      pushesAttempted: pushes.attempted,
    },
    "scheduler pass complete",
  );

  return { generated, confirmed, orphansFlagged, remindersSent };
}

/**
 * One pass, but only if nobody else is mid-pass.
 *
 * What every deployment entry point should call. `runScheduler` stays
 * unguarded so tests can drive it directly, but nothing in production should:
 * two app instances each hold their own timer, a cron entry may run
 * `npm run scheduler` alongside them, and during a deploy the old process
 * overlaps the new one. Each of those is a second pass.
 *
 * Every write underneath is idempotent, so an overlap is wasted work rather
 * than damage — which is exactly why an advisory lock is enough and a queue
 * would be over-engineering.
 */
export async function runSchedulerLocked(
  now = new Date(),
): Promise<SchedulerResult | null> {
  // Comfortably longer than a pass takes, comfortably shorter than an outage
  // would go unnoticed. A holder that dies mid-pass blocks the next one for at
  // most this long.
  const result = await withLock("scheduler", 4 * 60_000, () => runScheduler(now));

  if (!result.ran) {
    logger.debug("scheduler pass skipped; another process holds the lock");
    return null;
  }
  return result.value;
}
