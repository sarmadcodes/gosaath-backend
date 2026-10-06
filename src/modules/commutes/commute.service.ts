import { Types } from "mongoose";
import { logger } from "../../utils/logger.js";
import {
  BusinessRuleError,
  NotFoundError,
  UnprocessableError,
} from "../../utils/errors.js";
import {
  AreaModel,
  AttendanceModel,
  CampusModel,
  CommuteModel,
  RideInstanceModel,
  UserModel,
  VehicleModel,
} from "../../db/models/index.js";
import { generateInstancesFor, cancelFutureInstances } from "./instance.service.js";
import { startOfDay } from "../../utils/dates.js";
import {
  announceCommuteCancelled,
  announceScheduleChanged,
  passengersOn,
} from "./notify.service.js";
import type { Commute, DaySchedule } from "../../contract/types.js";
import type { CommuteInput } from "../../contract/api.js";

/**
 * What the service accepts.
 *
 * `institutionId` is deliberately absent. The contract carries it because the
 * client has it to hand, but it is a matching constraint taken from the
 * account — accepting it here would make "put me in another institution" a
 * typed, supported call rather than something the compiler refuses.
 */
export type CommuteDraft = Omit<CommuteInput, "institutionId">;

/**
 * The recurring template.
 *
 * A Commute has no dates. It is the pattern — "Mon/Wed/Fri, on campus by 8:00,
 * leaving 17:30, from Gulshan to Clifton Campus" — and concrete days are
 * expanded from it into RideInstance rows. Anything that happens on one day
 * changes an instance, never this.
 */

function toCommute(doc: {
  _id: { toString(): string };
  ownerId: { toString(): string };
  intent: string;
  institutionId: { toString(): string };
  campusId: { toString(): string };
  originAreaId: { toString(): string };
  schedule: Array<{ day: string; arriveBy?: string | null; leaveCampusAt?: string | null }>;
  direction: string;
  vehicleId?: { toString(): string } | null;
  seatsOffered?: number | null;
  contribution?: number | null;
  womenOnly: boolean;
  status: string;
}): Commute {
  return {
    id: doc._id.toString(),
    ownerId: doc.ownerId.toString(),
    intent: doc.intent as Commute["intent"],
    institutionId: doc.institutionId.toString(),
    campusId: doc.campusId.toString(),
    originAreaId: doc.originAreaId.toString(),
    schedule: doc.schedule.map((entry) => ({
      day: entry.day as DaySchedule["day"],
      ...(entry.arriveBy ? { arriveBy: entry.arriveBy } : {}),
      ...(entry.leaveCampusAt ? { leaveCampusAt: entry.leaveCampusAt } : {}),
    })),
    direction: doc.direction as Commute["direction"],
    ...(doc.vehicleId ? { vehicleId: doc.vehicleId.toString() } : {}),
    ...(doc.seatsOffered != null ? { seatsOffered: doc.seatsOffered } : {}),
    ...(doc.contribution != null ? { contribution: doc.contribution } : {}),
    womenOnly: doc.womenOnly,
    status: doc.status as Commute["status"],
  };
}

/**
 * Returns null when there is none.
 *
 * The client distinguishes three states — loading, error, and "no commute yet"
 * — and drives the setup card from this being `null`. Returning `[]` or
 * throwing would collapse two of them.
 */
export async function myCommute(userId: string): Promise<Commute | null> {
  const commute = await CommuteModel.findOne({
    ownerId: userId,
    status: { $ne: "cancelled" },
  }).lean();
  return commute ? toCommute(commute) : null;
}

/**
 * Validates the parts of a commute the client must not decide for itself.
 *
 * Institution and campus come from the account, not the request: they are
 * matching constraints, and letting a body set them would put somebody into
 * another institution's community without an email from that institution.
 */
async function resolveContext(userId: string, input: CommuteDraft) {
  const user = await UserModel.findById(userId);
  if (!user) throw new NotFoundError("Account not found.");

  const campus = await CampusModel.findOne({
    _id: input.campusId,
    institutionId: user.institutionId,
    active: true,
  });
  if (!campus) {
    throw new UnprocessableError("That campus is not available.");
  }

  const area = await AreaModel.findOne({ _id: input.originAreaId, active: true });
  if (!area) throw new UnprocessableError("That area is not available.");

  let vehicleId: Types.ObjectId | null = null;
  const offering = input.intent === "offer" || input.intent === "both";

  if (offering) {
    // Verification first, before the vehicle check, because it is the longer
    // thing to fix: adding a car takes a minute, getting a student card
    // approved takes an administrator. Telling somebody about the car and
    // then about the badge would be two trips.
    //
    // Enforced here rather than in the app. The app hides the Offer tab
    // behind the same rule, but a hidden button is not a check — this is the
    // one that actually holds.
    if (user.badgeStatus !== "approved") {
      throw new BusinessRuleError(
        user.badgeStatus === "pending"
          ? "Your verification is still being reviewed. You can offer seats once it is approved."
          : "Verify your student card before offering seats. It takes a minute from your profile.",
      );
    }

    if (!input.vehicleId) {
      throw new UnprocessableError("Add a vehicle before offering seats.");
    }
    // Scoped to the owner, so a vehicle id belonging to somebody else simply
    // does not resolve.
    const vehicle = await VehicleModel.findOne({
      _id: input.vehicleId,
      ownerId: user._id,
    });
    if (!vehicle) throw new UnprocessableError("That vehicle was not found.");
    vehicleId = vehicle._id;

    if (!input.seatsOffered || input.seatsOffered < 1) {
      throw new UnprocessableError("Say how many seats you can offer.");
    }
  }

  return { user, campus, area, vehicleId, offering };
}

export async function createCommute(
  userId: string,
  input: CommuteDraft,
): Promise<Commute> {
  const existing = await CommuteModel.findOne({
    ownerId: userId,
    status: { $ne: "cancelled" },
  });
  if (existing) {
    // One per person for now. Silently creating a second would leave matching
    // with two templates for one commuter and no way to say which is real.
    throw new BusinessRuleError("You already have a commute.");
  }

  const { user, campus, area, vehicleId, offering } = await resolveContext(
    userId,
    input,
  );

  const commute = await CommuteModel.create({
    ownerId: user._id,
    intent: input.intent,
    // From the account, never the body.
    institutionId: user.institutionId,
    campusId: campus._id,
    originAreaId: area._id,
    schedule: input.schedule,
    direction: input.direction,
    vehicleId,
    seatsOffered: offering ? input.seatsOffered : null,
    contribution: offering ? (input.contribution ?? null) : null,
    womenOnly: input.womenOnly,
    status: "active",
  });

  // Expanded immediately so the week is populated the moment setup finishes,
  // rather than waiting for the next scheduled run.
  await generateInstancesFor(commute._id);

  logger.info({ userId, commuteId: commute._id.toString() }, "commute created");
  return toCommute(commute);
}

export async function updateCommute(
  userId: string,
  commuteId: string,
  patch: Partial<CommuteDraft>,
): Promise<Commute> {
  // Scoped by owner in the query itself. A commute id belonging to somebody
  // else cannot match, so there is no window where the check is forgotten.
  const commute = await CommuteModel.findOne({ _id: commuteId, ownerId: userId });
  if (!commute) throw new NotFoundError("Commute not found.");

  const merged: CommuteDraft = {
    intent: patch.intent ?? (commute.intent as CommuteDraft["intent"]),
    campusId: patch.campusId ?? commute.campusId.toString(),
    originAreaId: patch.originAreaId ?? commute.originAreaId.toString(),
    schedule: patch.schedule ?? (commute.schedule as CommuteDraft["schedule"]),
    direction: patch.direction ?? (commute.direction as CommuteDraft["direction"]),
    ...(patch.vehicleId ?? commute.vehicleId
      ? { vehicleId: patch.vehicleId ?? commute.vehicleId?.toString() }
      : {}),
    ...(patch.seatsOffered ?? commute.seatsOffered
      ? { seatsOffered: patch.seatsOffered ?? commute.seatsOffered ?? undefined }
      : {}),
    ...(patch.contribution ?? commute.contribution
      ? { contribution: patch.contribution ?? commute.contribution ?? undefined }
      : {}),
    womenOnly: patch.womenOnly ?? commute.womenOnly,
  };

  // Changing what this commute is for, while people are relying on it.
  //
  // Refused rather than cascaded. Switching from offering to finding would
  // leave confirmed passengers with a seat in a car that is no longer being
  // driven, and switching the other way would leave this person holding a seat
  // they have stopped intending to use. Either is somebody standing at a kerb
  // tomorrow morning, and neither is worth a toggle doing silently.
  //
  // So the person cancels first, deliberately, and the people affected are
  // told by the cancellation — which already notifies them properly.
  if (patch.intent !== undefined && patch.intent !== commute.intent) {
    const [passengers, ownSeat] = await Promise.all([
      AttendanceModel.countDocuments({
        rideInstanceId: {
          $in: await RideInstanceModel.find({
            commuteId: commute._id,
            date: { $gte: startOfDay(new Date()) },
            status: { $ne: "cancelled" },
          }).distinct("_id"),
        },
        role: "passenger",
        status: "confirmed",
      }),
      AttendanceModel.countDocuments({
        userId,
        role: "passenger",
        status: "confirmed",
      }),
    ]);

    if (passengers > 0) {
      throw new BusinessRuleError(
        passengers === 1
          ? "Somebody has a confirmed seat with you. Cancel that ride before you stop offering."
          : `${passengers} people have confirmed seats with you. Cancel those rides before you stop offering.`,
      );
    }

    if (ownSeat > 0) {
      throw new BusinessRuleError(
        "You have a confirmed seat in somebody else's car. Cancel it before you start offering.",
      );
    }
  }

  const { campus, area, vehicleId, offering } = await resolveContext(userId, merged);

  const scheduleChanged =
    patch.schedule !== undefined &&
    JSON.stringify(patch.schedule) !== JSON.stringify(commute.schedule);

  commute.set({
    intent: merged.intent,
    campusId: campus._id,
    originAreaId: area._id,
    schedule: merged.schedule,
    direction: merged.direction,
    vehicleId,
    seatsOffered: offering ? merged.seatsOffered : null,
    contribution: offering ? (merged.contribution ?? null) : null,
    womenOnly: merged.womenOnly,
  });
  await commute.save();

  if (scheduleChanged) {
    // Who was booked, read BEFORE the rebuild. Afterwards their attendance has
    // been cleared along with the instances, and there is nobody left to tell.
    const affected = await RideInstanceModel.find({
      commuteId: commute._id,
      date: { $gte: startOfDay(new Date()) },
      status: { $ne: "cancelled" },
    })
      .select("_id")
      .lean();

    const riderIds = await passengersOn(affected.map((row) => row._id));

    // Only future days are rebuilt. Rewriting past instances would erase the
    // record of who actually travelled, and rewriting today's would cancel a
    // ride people may already be on their way to.
    await cancelFutureInstances(commute._id, "templateChanged");
    await generateInstancesFor(commute._id);

    // Somebody who had a seat at 08:00 may now have one at 09:00, or none.
    // Rebuilding their week without a word is how a passenger ends up at a
    // kerb at the old time.
    await announceScheduleChanged({
      riderIds,
      driverId: userId,
      commuteId: commute._id.toString(),
    });
  }

  return toCommute(commute);
}

export async function cancelCommute(
  userId: string,
  commuteId: string,
): Promise<void> {
  const commute = await CommuteModel.findOne({ _id: commuteId, ownerId: userId });
  if (!commute) throw new NotFoundError("Commute not found.");

  commute.status = "cancelled";
  await commute.save();

  // Everyone holding a seat on a future day needs their attendance cleared,
  // or they will keep seeing a ride that is no longer happening.
  const future = await RideInstanceModel.find({
    commuteId: commute._id,
    date: { $gte: new Date() },
  }).select("_id");

  if (future.length > 0) {
    // Read first: a moment later these rows say "cancelled" and this finds
    // nobody to tell.
    const riderIds = await passengersOn(future.map((i) => i._id));

    await AttendanceModel.updateMany(
      { rideInstanceId: { $in: future.map((i) => i._id) } },
      { $set: { status: "cancelled" } },
    );
    await RideInstanceModel.updateMany(
      { _id: { $in: future.map((i) => i._id) } },
      { $set: { status: "cancelled" } },
    );

    // Told after the writes and never awaited for delivery: the commute is
    // cancelled either way, and a notification failure must not report it as
    // still running.
    await announceCommuteCancelled({
      riderIds,
      driverId: userId,
      commuteId: commute._id.toString(),
    });
  }

  logger.info({ userId, commuteId }, "commute cancelled");
}
