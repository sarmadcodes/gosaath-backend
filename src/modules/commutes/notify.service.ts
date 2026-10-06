import { Types } from "mongoose";
import { AttendanceModel, UserModel } from "../../db/models/index.js";
import { notifyQuietly } from "../notifications/notification.service.js";
import { publish } from "../realtime/hub.js";

/**
 * Telling the people who were relying on a ride.
 *
 * Gathered here because the alternative is what this file replaced: four
 * places that changed somebody's seat and three of them that forgot to say so.
 * A passenger whose ride disappears without a word finds out at the kerb, and
 * every one of these is a morning somebody spent waiting for a car that was
 * never coming.
 *
 * Every function is best-effort. The change has already happened by the time
 * these run — a driver's cancellation is not undone because a notification
 * failed, and reporting it as failed would invite a retry that cancels nothing
 * twice.
 */

/** First name only, which is all any of these messages needs. */
function firstNameOf(name: string | undefined | null): string {
  return (name ?? "").trim().split(/\s+/)[0] || "Your driver";
}

/**
 * Who is booked on these rides, right now.
 *
 * Exported because the order matters: every caller has to read this BEFORE it
 * clears or rebuilds attendance, or it finds nobody and tells nobody. That
 * mistake is invisible — the code looks correct and simply never notifies.
 */
export async function passengersOn(instanceIds: unknown[]): Promise<string[]> {
  if (instanceIds.length === 0) return [];
  const rows = await AttendanceModel.find({
    rideInstanceId: { $in: instanceIds },
    role: "passenger",
    status: { $in: ["confirmed", "pending"] },
  })
    .select("userId")
    .lean();
  return [...new Set(rows.map((row) => row.userId.toString()))];
}

/**
 * The whole commute is off, for good.
 *
 * Distinct from a single day: there is nothing to come back to next week, so
 * the message says so rather than implying a gap.
 */
export async function announceCommuteCancelled(input: {
  /** Gathered before the attendance rows were cleared. See `passengersOn`. */
  riderIds: string[];
  driverId: string;
  commuteId: string;
}): Promise<void> {
  const riders = input.riderIds;
  if (riders.length === 0) return;

  const driver = await UserModel.findById(input.driverId).select("name").lean();
  const who = firstNameOf(driver?.name);

  await Promise.all(
    riders.map((riderId) =>
      notifyQuietly({
        userId: riderId,
        kind: "cancellation",
        title: "Your ride has been cancelled",
        body: `${who} is no longer running this commute. You can look for another ride from Matches.`,
      }),
    ),
  );

  // commute.updated rather than a ride event: what changed is the whole
  // arrangement, and an event carrying an empty ride id would be a lie the
  // client has to special-case.
  for (const riderId of riders) {
    publish(
      { kind: "user", userId: riderId },
      { type: "commute.updated", commuteId: input.commuteId },
    );
  }
}

/**
 * The driver moved the days or the times.
 *
 * Their seats are rebuilt against the new schedule, which in practice means
 * somebody who had a seat at 08:00 may now have one at 09:00 or none at all.
 * Saying "your ride changed" is the only honest summary; the week view shows
 * what it changed to.
 */
export async function announceScheduleChanged(input: {
  /** Gathered before the instances were rebuilt. See `passengersOn`. */
  riderIds: string[];
  driverId: string;
  commuteId: string;
}): Promise<void> {
  const riders = input.riderIds;
  if (riders.length === 0) return;

  const driver = await UserModel.findById(input.driverId).select("name").lean();
  const who = firstNameOf(driver?.name);

  await Promise.all(
    riders.map((riderId) =>
      notifyQuietly({
        userId: riderId,
        kind: "cancellation",
        title: "Your ride times have changed",
        body: `${who} changed the days or times of this commute. Check your week to see what you still have.`,
      }),
    ),
  );

  for (const riderId of riders) {
    publish(
      { kind: "user", userId: riderId },
      { type: "commute.updated", commuteId: input.commuteId },
    );
  }
}

/**
 * A passenger is not coming on a day they had a seat.
 *
 * The driver is told for two reasons: they would otherwise wait at a pickup
 * for somebody who is not coming, and the seat is now free for the day, which
 * they may want to offer to somebody else.
 */
export async function announcePassengerSkipped(input: {
  rideInstanceId: Types.ObjectId | string;
  driverId: Types.ObjectId | string;
  passengerId: string;
  day: string;
}): Promise<void> {
  const passenger = await UserModel.findById(input.passengerId).select("name").lean();

  await notifyQuietly({
    userId: input.driverId,
    kind: "cancellation",
    title: "A passenger is not coming",
    body: `${firstNameOf(passenger?.name)} is skipping ${input.day}. Their seat is free for that day.`,
    payload: { rideId: String(input.rideInstanceId) },
  });

  // ride.updated, not seatsChanged: the seat count on the instance has not
  // moved — an attendance row changed — and publishing a seat count we have
  // not read would be inventing one.
  publish(
    { kind: "user", userId: String(input.driverId) },
    { type: "ride.updated", rideId: String(input.rideInstanceId) },
  );
}
