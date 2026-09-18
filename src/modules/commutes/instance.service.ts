import { Types } from "mongoose";
import { logger } from "../../utils/logger.js";
import {
  AttendanceModel,
  CommuteModel,
  ConfigurationModel,
  RideInstanceModel,
} from "../../db/models/index.js";
import { startOfDay, upcomingDays, weekdayOf } from "../../utils/dates.js";

/**
 * Expands a recurring template into concrete days.
 *
 * The whole reason RideInstance exists: a day can be skipped, cancelled or
 * left without a driver, and none of that may touch the template. Hanging
 * riders off the Commute instead makes "not this Thursday" impossible to say
 * without silently changing every other week too.
 *
 * Generation is idempotent by construction. Two workers racing — a cron and a
 * lazy read, or two PM2 processes — produce one row, because the write is an
 * upsert keyed on `{commuteId, date}` and that index is unique. There is no
 * "check whether it exists, then insert": that has a window between the two
 * where both workers see nothing.
 */

const DEFAULT_WINDOW_DAYS = 14;

async function windowDays(): Promise<number> {
  const setting = await ConfigurationModel.findOne({
    key: "RIDE_INSTANCE_WINDOW_DAYS",
  }).lean();
  const value = setting?.value;
  return typeof value === "number" && value > 0 ? value : DEFAULT_WINDOW_DAYS;
}

export type GenerationResult = {
  commuteId: string;
  created: number;
  matched: number;
};

/**
 * Builds the rolling window for one commute.
 *
 * Existing rows are updated rather than replaced: an instance may already
 * carry a cancellation, a driver's unavailability, or people's attendance, and
 * regenerating must not quietly undo any of that. Only the fields that come
 * from the template are written.
 */
export async function generateInstancesFor(
  commuteId: Types.ObjectId | string,
): Promise<GenerationResult> {
  const commute = await CommuteModel.findById(commuteId);

  if (!commute || commute.status !== "active") {
    return { commuteId: String(commuteId), created: 0, matched: 0 };
  }

  const days = upcomingDays(await windowDays());
  const byWeekday = new Map(commute.schedule.map((entry) => [entry.day, entry]));

  // Typed from the model rather than inferred: Mongoose's bulkWrite generics
  // reject a plainly-correct literal here, and widening to `any` would give up
  // checking on the one call that matters in this file.
  type BulkOps = Parameters<typeof RideInstanceModel.bulkWrite>[0];
  const operations: BulkOps = [];

  for (const date of days) {
    const entry = byWeekday.get(weekdayOf(date));
    // No entry means they do not travel that day. Not an absence to record —
    // simply not part of the pattern.
    if (!entry) continue;

    operations.push({
      updateOne: {
        filter: { commuteId: commute._id, date },
        update: {
          // Times and capacity follow the template, so editing it flows
          // through to days that have not happened yet.
          $set: {
            driverId: commute.ownerId,
            day: entry.day,
            arriveBy: entry.arriveBy ?? null,
            leaveCampusAt: entry.leaveCampusAt ?? null,
            seatsOffered: commute.seatsOffered ?? 0,
          },
          // Status and seatsTaken only on insert. Overwriting them would undo
          // a cancellation or wipe the count of people already accepted.
          $setOnInsert: {
            commuteId: commute._id,
            date,
            status: "scheduled",
            seatsTaken: 0,
          },
        },
        upsert: true,
      },
    });
  }

  if (operations.length === 0) {
    return { commuteId: commute._id.toString(), created: 0, matched: 0 };
  }

  // `ordered: false` so one conflicting row does not abort the rest. Under a
  // race the loser gets a duplicate-key error on that single day, which is the
  // unique index doing its job — the row exists either way.
  const result = await RideInstanceModel.bulkWrite(operations, {
    ordered: false,
  }).catch((error: unknown) => {
    const code = (error as { code?: number })?.code;
    if (code === 11000) {
      logger.debug({ commuteId: commute._id.toString() }, "generation raced; row exists");
      return null;
    }
    throw error;
  });

  // The driver is a member of their own ride. Without this row the group has
  // no driver in it and `membersFor` returns passengers travelling with
  // nobody — the attendance table is the only record of who is on a day.
  await attachDriver(commute._id, commute.ownerId);

  return {
    commuteId: commute._id.toString(),
    created: result?.upsertedCount ?? 0,
    matched: result?.matchedCount ?? 0,
  };
}

/**
 * Ensures the driver has attendance on every scheduled instance.
 *
 * Upserted, and only ever inserting the status: if the driver has already
 * skipped a day, regenerating must not quietly put them back on it.
 */
async function attachDriver(
  commuteId: Types.ObjectId,
  driverId: Types.ObjectId,
): Promise<void> {
  const instances = await RideInstanceModel.find({
    commuteId,
    date: { $gte: startOfDay(new Date()) },
    status: "scheduled",
  }).select("_id");

  if (instances.length === 0) return;

  type BulkOps = Parameters<typeof AttendanceModel.bulkWrite>[0];
  const operations: BulkOps = instances.map((instance) => ({
    updateOne: {
      filter: { rideInstanceId: instance._id, userId: driverId },
      update: {
        $set: { role: "driver" },
        $setOnInsert: {
          rideInstanceId: instance._id,
          userId: driverId,
          status: "confirmed",
        },
      },
      upsert: true,
    },
  }));

  await AttendanceModel.bulkWrite(operations, { ordered: false }).catch(
    (error: unknown) => {
      // The unique index doing its job under a race. The row exists either way.
      if ((error as { code?: number })?.code !== 11000) throw error;
    },
  );
}

/**
 * Rebuilds the window for every active commute.
 *
 * The scheduled job. Safe to run concurrently with itself and with the lazy
 * generation that happens when a commute is created or edited.
 */
export async function generateAllInstances(): Promise<{
  commutes: number;
  created: number;
}> {
  const commutes = await CommuteModel.find({ status: "active" }).select("_id");

  let created = 0;
  for (const commute of commutes) {
    const result = await generateInstancesFor(commute._id);
    created += result.created;
  }

  logger.info({ commutes: commutes.length, created }, "ride instances generated");
  return { commutes: commutes.length, created };
}

/**
 * Cancels instances from today onward.
 *
 * Deliberately not "all instances". Past days are the record of who actually
 * travelled and must survive a template change; today's is a ride people may
 * already be on their way to.
 */
export async function cancelFutureInstances(
  commuteId: Types.ObjectId | string,
  reason: "templateChanged" | "commuteCancelled",
): Promise<number> {
  const from = startOfDay(new Date());

  const instances = await RideInstanceModel.find({
    commuteId,
    date: { $gt: from },
  }).select("_id");

  if (instances.length === 0) return 0;

  const ids = instances.map((instance) => instance._id);

  // Attendance goes too. Leaving it would show passengers a confirmed seat on
  // a ride that no longer exists.
  await AttendanceModel.deleteMany({ rideInstanceId: { $in: ids } });
  await RideInstanceModel.deleteMany({ _id: { $in: ids } });

  logger.info(
    { commuteId: String(commuteId), removed: ids.length, reason },
    "future ride instances cleared",
  );
  return ids.length;
}
