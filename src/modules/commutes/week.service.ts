import { Types } from "mongoose";
import { logger } from "../../utils/logger.js";
import { NotFoundError, UnprocessableError } from "../../utils/errors.js";
import {
  AttendanceModel,
  CommuteModel,
  RideInstanceModel,
  UserModel,
} from "../../db/models/index.js";
import { isoDate, startOfDay, weekOf } from "../../utils/dates.js";
import { toPublicUser } from "../users/user.mapper.js";
import type {
  CommuteDay,
  CommuteMember,
  Weekday,
} from "../../contract/types.js";

/**
 * The week, and the day-level exceptions.
 *
 * Everything here operates on RideInstance rows. Nothing writes to the
 * Commute: skipping Tuesday must not affect Monday, and must not change the
 * template that produces every other week.
 */

/**
 * Loads a commute the caller is entitled to see.
 *
 * The client passes a commuteId, so ownership is checked on every call. 404
 * rather than 403 for somebody else's: a 403 confirms the id is real.
 */
async function ownedCommute(userId: string, commuteId: string) {
  const commute = await CommuteModel.findOne({
    _id: commuteId,
    ownerId: userId,
  });
  if (!commute) throw new NotFoundError("Commute not found.");
  return commute;
}

/**
 * Loads a commute the caller owns OR travels on.
 *
 * Passengers need to see the group and the week of a ride they are on, but
 * must not be able to change it — so the two lookups are separate rather than
 * one permissive helper used everywhere.
 */
async function visibleCommute(userId: string, commuteId: string) {
  const commute = await CommuteModel.findById(commuteId);
  if (!commute) throw new NotFoundError("Commute not found.");

  if (commute.ownerId.equals(new Types.ObjectId(userId))) return commute;

  const instances = await RideInstanceModel.find({ commuteId: commute._id }).select("_id");
  const travels = await AttendanceModel.countDocuments({
    rideInstanceId: { $in: instances.map((i) => i._id) },
    userId,
    status: { $in: ["confirmed", "pending"] },
  });

  if (travels === 0) throw new NotFoundError("Commute not found.");
  return commute;
}

/**
 * The current week as the client renders it.
 *
 * Built from instances, not from the template, so a skipped Tuesday and a
 * driver-less Thursday show as themselves rather than as ordinary days.
 */
export async function weekFor(
  userId: string,
  commuteId: string,
): Promise<CommuteDay[]> {
  const commute = await visibleCommute(userId, commuteId);
  const days = weekOf();

  const instances = await RideInstanceModel.find({
    commuteId: commute._id,
    date: { $gte: days[0], $lte: days[6] },
  }).lean();

  const byDate = new Map(
    instances.map((instance) => [isoDate(instance.date), instance]),
  );

  const attendance = await AttendanceModel.find({
    rideInstanceId: { $in: instances.map((i) => i._id) },
    userId,
  }).lean();

  const statusByInstance = new Map(
    attendance.map((row) => [row.rideInstanceId.toString(), row.status]),
  );

  const scheduled = new Set(commute.schedule.map((entry) => entry.day));
  const result: CommuteDay[] = [];

  for (const date of days) {
    const instance = byDate.get(isoDate(date));
    if (!instance) continue;

    // The instance's own status wins where it is exceptional — a cancelled or
    // driverless day is that for everyone. Otherwise this person's attendance
    // decides, so one passenger skipping does not change what others see.
    const status =
      instance.status === "cancelled"
        ? "cancelled"
        : instance.status === "noDriver"
          ? "noDriver"
          : (statusByInstance.get(instance._id.toString()) ?? "confirmed");

    result.push({
      day: instance.day as Weekday,
      date: isoDate(date),
      status: status as CommuteDay["status"],
    });
  }

  // A day with no instance is simply not part of the pattern, so the absence
  // of an entry is the answer rather than a placeholder.
  void scheduled;
  return result;
}

/**
 * Who travels on this commute.
 *
 * Returns `PublicUser` plus a contact number — the group is a relationship,
 * and people in one need to be able to reach each other. The number is not on
 * `PublicUser` itself, which is the shape everyone is exposed as everywhere.
 */
export async function membersFor(
  userId: string,
  commuteId: string,
): Promise<CommuteMember[]> {
  const commute = await visibleCommute(userId, commuteId);

  const upcoming = await RideInstanceModel.find({
    commuteId: commute._id,
    date: { $gte: startOfDay(new Date()) },
    status: { $ne: "cancelled" },
  })
    .sort({ date: 1 })
    .select("_id")
    .limit(14);

  const nextInstanceId = upcoming[0]?._id;

  const attendance = await AttendanceModel.find({
    rideInstanceId: { $in: upcoming.map((i) => i._id) },
    status: { $in: ["confirmed", "pending"] },
  }).lean();

  const roleByUser = new Map<string, "driver" | "passenger">();
  const travellingNext = new Set<string>();

  for (const row of attendance) {
    const id = row.userId.toString();
    // Driver wins if both appear: somebody can be a passenger on one day and
    // the driver on another, and the group should name them as the driver.
    if (row.role === "driver" || !roleByUser.has(id)) {
      roleByUser.set(id, row.role as "driver" | "passenger");
    }
    if (nextInstanceId && row.rideInstanceId.equals(nextInstanceId)) {
      travellingNext.add(id);
    }
  }

  if (roleByUser.size === 0) return [];

  const users = await UserModel.find({
    _id: { $in: [...roleByUser.keys()] },
  }).lean();

  return users.map((user) => ({
    user: toPublicUser(user),
    role: roleByUser.get(user._id.toString()) ?? "passenger",
    travellingNext: travellingNext.has(user._id.toString()),
    contactPhone: user.phone,
  }));
}

/**
 * Skips one day.
 *
 * Writes an attendance row for that instance and nothing else. The template is
 * untouched, so next week's Tuesday is unaffected — which is the entire reason
 * these are separate collections.
 */
export async function skipDay(
  userId: string,
  commuteId: string,
  day: Weekday,
): Promise<CommuteDay[]> {
  const commute = await visibleCommute(userId, commuteId);

  // The NEXT instance of that weekday, not "this week's".
  //
  // On a Friday, "skip Monday" means the Monday ahead — this week's is
  // already behind us. Scoping to the calendar week makes the request fail
  // for the second half of every week, which is exactly when somebody is
  // most likely to be planning the days to come.
  const instance = await RideInstanceModel.findOne({
    commuteId: commute._id,
    day,
    date: { $gte: startOfDay(new Date()) },
  }).sort({ date: 1 });

  if (!instance) {
    // Not a day they travel at all, or beyond the generated window.
    throw new UnprocessableError("There is no upcoming ride on that day.");
  }

  await AttendanceModel.findOneAndUpdate(
    { rideInstanceId: instance._id, userId },
    { $set: { status: "skipped", role: commute.ownerId.equals(new Types.ObjectId(userId)) ? "driver" : "passenger" } },
    { upsert: true, setDefaultsOnInsert: true },
  );

  logger.info({ userId, commuteId, day }, "day skipped");
  return weekFor(userId, commuteId);
}

/**
 * Marks days the owner cannot drive.
 *
 * Those instances become `noDriver`, which is what surfaces the "find cover"
 * flow. Passengers keep their recurring seat on every other day, and the
 * template still says Mon–Fri.
 */
export async function setUnavailable(
  userId: string,
  commuteId: string,
  days: Weekday[],
): Promise<CommuteDay[]> {
  // Only the owner. A passenger declaring the driver unavailable would strand
  // everybody else on the ride.
  const commute = await ownedCommute(userId, commuteId);

  // The next occurrence of each named weekday, for the same reason as
  // skipDay. One per day rather than every future Monday: a driver saying
  // "not Monday" means the Monday coming, not Mondays forever — that would
  // be a template change, and this deliberately never touches the template.
  const soonest = await RideInstanceModel.aggregate<{ _id: string; instanceId: unknown }>([
    {
      $match: {
        commuteId: commute._id,
        day: { $in: days },
        date: { $gte: startOfDay(new Date()) },
      },
    },
    { $sort: { date: 1 } },
    { $group: { _id: "$day", instanceId: { $first: "$_id" } } },
  ]);

  const affected = soonest.map((row) => ({ _id: row.instanceId }));

  if (affected.length > 0) {
    await RideInstanceModel.updateMany(
      { _id: { $in: affected.map((i) => i._id) } },
      { $set: { status: "noDriver" } },
    );
    // Passengers are moved to pending, not cancelled: they still want the
    // ride, they just need somebody to drive it.
    await AttendanceModel.updateMany(
      {
        rideInstanceId: { $in: affected.map((i) => i._id) },
        role: "passenger",
      },
      { $set: { status: "pending" } },
    );
  }

  logger.info(
    { userId, commuteId, days, instances: affected.length },
    "driver unavailable",
  );
  return weekFor(userId, commuteId);
}
