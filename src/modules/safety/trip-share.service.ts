import { createHash, randomBytes } from "node:crypto";
import { Types } from "mongoose";
import { env } from "../../config/env.js";
import { logger } from "../../utils/logger.js";
import {
  AttendanceModel,
  CampusModel,
  CommuteModel,
  RideInstanceModel,
  TripShareModel,
  UserModel,
  VehicleModel,
} from "../../db/models/index.js";
import { BusinessRuleError, NotFoundError } from "../../utils/errors.js";
import { maskPlate } from "../users/contact.service.js";

/**
 * Trip sharing.
 *
 * A passenger tells somebody outside GoSaath which car they are in and when
 * they should have arrived, so that a person who cares about them would notice
 * if they had not. That is the whole feature.
 *
 * **It is not tracking and it cannot become tracking.** What a holder of the
 * link sees is a scheduled journey — the day, the times, the campus, the area
 * it starts from, the driver's first name and a masked plate. GoSaath holds no
 * position for anybody, so there is nothing live for this to expose, and the
 * response below is assembled field by field rather than by serialising a
 * document, so a field added to a model later cannot leak through it.
 *
 * Everything in it is something the passenger already knows and could have
 * typed into a message by hand. The link saves them the typing and gives the
 * recipient something that expires.
 */

/**
 * How long a link lives past the end of the journey it describes.
 *
 * Long enough to still be useful if somebody checks it that evening, short
 * enough that it is not a standing answer to "where is this person on a
 * Monday morning". Forgetting to revoke should not be dangerous.
 */
const GRACE_HOURS = 8;

function hash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** First name only. A surname is more than this needs. */
function firstNameOf(name: string | undefined | null): string {
  return (name ?? "").trim().split(/\s+/)[0] || "A member";
}

/**
 * Creates a link to one ride.
 *
 * Only somebody actually on the ride may share it — a driver or a confirmed
 * passenger. Without that check this would be a way to publish any ride's
 * details by guessing an id, including rides belonging to people the sharer has
 * never met.
 */
export async function shareTrip(
  userId: string,
  rideInstanceId: string,
): Promise<{ url: string; token: string; expiresAt: Date }> {
  const ride = await RideInstanceModel.findById(rideInstanceId)
    .select("_id driverId date status")
    .lean();

  if (!ride) throw new NotFoundError("That ride was not found.");

  const isDriver = ride.driverId.toString() === userId;

  if (!isDriver) {
    const seat = await AttendanceModel.findOne({
      rideInstanceId: ride._id,
      userId,
      role: "passenger",
      status: "confirmed",
    })
      .select("_id")
      .lean();

    // The same message either way: whether a ride exists is not something to
    // confirm to somebody with no seat on it.
    if (!seat) throw new NotFoundError("That ride was not found.");
  }

  if (ride.status === "cancelled") {
    throw new BusinessRuleError("That ride was cancelled, so there is nothing to share.");
  }

  // Replaced rather than stacked. Somebody who shares twice means "give me a
  // link", not "leave two working links behind".
  await TripShareModel.updateMany(
    { rideInstanceId: ride._id, sharedByUserId: userId, revokedAt: null },
    { $set: { revokedAt: new Date() } },
  );

  // 32 bytes. This is a bearer credential held by somebody with no account and
  // no second factor, so its only protection is being unguessable.
  const token = randomBytes(32).toString("base64url");

  const expiresAt = new Date(
    new Date(ride.date).getTime() + 24 * 60 * 60 * 1000 + GRACE_HOURS * 60 * 60 * 1000,
  );

  await TripShareModel.create({
    rideInstanceId: ride._id,
    sharedByUserId: userId,
    tokenHash: hash(token),
    expiresAt,
  });

  logger.info({ userId, rideInstanceId }, "trip shared");

  return {
    // Deep-links into the app's public page. The token is in the path rather
    // than a query string so it does not end up in a Referer header when the
    // page links anywhere.
    url: `${env.PUBLIC_URL}/t/${token}`,
    token,
    expiresAt,
  };
}

/** Stops a link working. Only whoever created it may do this. */
export async function revokeTripShare(userId: string, rideInstanceId: string): Promise<void> {
  await TripShareModel.updateMany(
    { rideInstanceId, sharedByUserId: userId, revokedAt: null },
    { $set: { revokedAt: new Date() } },
  );
  logger.info({ userId, rideInstanceId }, "trip share revoked");
}

/** What the sharer sees: whether a link is live, and whether anybody looked. */
export async function myTripShare(
  userId: string,
  rideInstanceId: string,
): Promise<{ active: boolean; expiresAt: Date | null; viewCount: number } | null> {
  const row = await TripShareModel.findOne({
    rideInstanceId,
    sharedByUserId: userId,
    revokedAt: null,
    expiresAt: { $gt: new Date() },
  }).lean();

  if (!row) return null;

  // The token is deliberately absent. It was shown once, when it was created;
  // an endpoint that returns it again turns read access to this account into
  // the link itself.
  return { active: true, expiresAt: row.expiresAt, viewCount: row.viewCount };
}

export type SharedTrip = {
  /** The person who shared it, by first name. */
  passenger: string;
  day: string;
  /** "08:00", as scheduled. Not an estimate, and not a position. */
  arriveBy: string | null;
  leaveCampusAt: string | null;
  campus: string;
  /** Area, never an address. The same granularity the product stores. */
  fromArea: string | null;
  driver: {
    name: string;
    verified: boolean;
    vehicle: { model: string; colour: string; plate: string } | null;
  } | null;
  status: "scheduled" | "cancelled" | "noDriver" | "completed";
  expiresAt: Date;
};

/**
 * Resolves a token into the facts of one journey.
 *
 * **Unauthenticated.** The token is the authorisation, so everything this
 * returns is chosen on the assumption that whoever holds it may not be the
 * person it was sent to. No phone number, no email, no surname, no address, no
 * other passenger — a group of students' names is not the sharer's to give
 * away, and the recipient does not need them to notice somebody is late.
 *
 * The plate is masked exactly as it is while browsing. A full plate is how a
 * stranger finds a car, and the passenger can read it out if they want to.
 */
export async function readSharedTrip(token: string): Promise<SharedTrip> {
  const share = await TripShareModel.findOne({
    tokenHash: hash(token),
    revokedAt: null,
    expiresAt: { $gt: new Date() },
  });

  // One message for every failure: unknown, revoked, expired. Distinguishing
  // them would confirm that a token was once real.
  if (!share) throw new NotFoundError("This link is no longer valid.");

  const ride = await RideInstanceModel.findById(share.rideInstanceId)
    .select("driverId day arriveBy leaveCampusAt status commuteId")
    .lean();

  if (!ride) throw new NotFoundError("This link is no longer valid.");

  const [sharer, driver, commute] = await Promise.all([
    UserModel.findById(share.sharedByUserId).select("name").lean(),
    UserModel.findById(ride.driverId).select("name badgeStatus").lean(),
    CommuteModel.findById(ride.commuteId)
      .select("campusId originAreaId vehicleId")
      .populate<{ originAreaId: { name: string } | null }>("originAreaId", "name")
      .lean(),
  ]);

  const [campus, vehicle] = await Promise.all([
    commute?.campusId
      ? CampusModel.findById(commute.campusId).select("name").lean()
      : null,
    commute?.vehicleId
      ? VehicleModel.findById(commute.vehicleId).select("model colour plate").lean()
      : null,
  ]);

  // Counted, so the sharer can tell whether the person they sent it to ever
  // opened it. Not awaited: a view must not fail because a counter did.
  void TripShareModel.updateOne(
    { _id: share._id },
    { $inc: { viewCount: 1 }, $set: { lastViewedAt: new Date() } },
  ).catch(() => {});

  return {
    passenger: firstNameOf(sharer?.name),
    day: ride.day,
    arriveBy: ride.arriveBy ?? null,
    leaveCampusAt: ride.leaveCampusAt ?? null,
    campus: campus?.name ?? "their campus",
    fromArea: commute?.originAreaId?.name ?? null,
    driver: driver
      ? {
          name: firstNameOf(driver.name),
          verified: driver.badgeStatus === "approved",
          vehicle: vehicle
            ? {
                model: vehicle.model,
                colour: vehicle.colour,
                plate: maskPlate(vehicle.plate),
              }
            : null,
        }
      : null,
    status: ride.status as SharedTrip["status"],
    expiresAt: share.expiresAt,
  };
}

/** Used by the ride detail endpoint to avoid a second round trip. */
export async function activeShareCount(
  userId: string,
  rideIds: Types.ObjectId[],
): Promise<Set<string>> {
  if (rideIds.length === 0) return new Set();
  const rows = await TripShareModel.find({
    sharedByUserId: userId,
    rideInstanceId: { $in: rideIds },
    revokedAt: null,
    expiresAt: { $gt: new Date() },
  })
    .select("rideInstanceId")
    .lean();
  return new Set(rows.map((row) => row.rideInstanceId.toString()));
}
