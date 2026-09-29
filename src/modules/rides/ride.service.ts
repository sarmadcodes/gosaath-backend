import { Types } from "mongoose";
import { AuthorizationError } from "../../utils/errors.js";
import {
  AreaModel,
  BlockModel,
  CampusModel,
  CommuteModel,
  RideInstanceModel,
  UserModel,
  VehicleModel,
} from "../../db/models/index.js";
import { toPublicUser } from "../users/user.mapper.js";
import { confirmedRideIds, maskPlate } from "../users/contact.service.js";
import { nearbyRadiusKm } from "../location/location.service.js";
import { distanceKm } from "../../utils/geo.js";
import { minutesFromTime } from "../../utils/dates.js";
import type { RideListing, VehicleType, Weekday } from "../../contract/types.js";
import type { RideSearch } from "../../contract/api.js";

/**
 * Ride listings.
 *
 * Two lists, not one:
 *
 *   search  matches a schedule — the right default, but it returns nothing on
 *           a campus still filling up, and nothing is what makes a new user
 *           leave.
 *   nearby  relaxes TIME only. Institution and campus stay hard constraints in
 *           both; only the clock is loosened.
 */

const DEFAULT_TIME_TOLERANCE = 45;

type Context = {
  userId: string;
  institutionId: Types.ObjectId;
  campusId: Types.ObjectId;
  originAreaId: Types.ObjectId | null;
  hidden: Types.ObjectId[];
};

/**
 * The caller's own constraints, taken from their account and commute.
 *
 * `RideSearch` carries optional `institutionId` and `campusId` because the
 * client type has them. They are never read. A supplied value that differs
 * from the caller's own is rejected outright rather than ignored: returning an
 * empty list would teach an attacker the field is respected but unlucky.
 */
async function contextFor(userId: string, params: RideSearch): Promise<Context> {
  const user = await UserModel.findById(userId).lean();
  if (!user) throw new AuthorizationError();

  if (
    (params.institutionId && params.institutionId !== user.institutionId.toString()) ||
    (params.campusId && params.campusId !== user.campusId.toString())
  ) {
    throw new AuthorizationError(
      "Rides are limited to your own institution and campus.",
    );
  }

  const commute = await CommuteModel.findOne({ ownerId: userId })
    .select("originAreaId")
    .lean();

  const [blockedByMe, blockedMe] = await Promise.all([
    BlockModel.find({ blockerId: userId }).select("blockedId").lean(),
    BlockModel.find({ blockedId: userId }).select("blockerId").lean(),
  ]);

  return {
    userId,
    institutionId: user.institutionId,
    campusId: user.campusId,
    originAreaId: commute?.originAreaId ?? null,
    // Both directions, so a blocked person cannot see the blocker either.
    hidden: [
      ...blockedByMe.map((row) => row.blockedId),
      ...blockedMe.map((row) => row.blockerId),
    ],
  };
}

type ListingRow = {
  _id: Types.ObjectId;
  driverId: Types.ObjectId;
  commuteId: Types.ObjectId;
  day: string;
  arriveBy?: string | null;
  seatsOffered: number;
  seatsTaken: number;
};

async function buildListings(
  context: Context,
  instances: ListingRow[],
): Promise<RideListing[]> {
  if (instances.length === 0) return [];

  const driverIds = [...new Set(instances.map((i) => i.driverId.toString()))];
  const commuteIds = instances.map((i) => i.commuteId);

  const [users, commutes, campus] = await Promise.all([
    UserModel.find({ _id: { $in: driverIds } }).lean(),
    CommuteModel.find({ _id: { $in: commuteIds } })
      .select("originAreaId contribution vehicleId womenOnly schedule direction")
      .lean(),
    CampusModel.findById(context.campusId).select("name").lean(),
  ]);

  const commuteById = new Map(commutes.map((c) => [c._id.toString(), c]));
  const userById = new Map(users.map((u) => [u._id.toString(), u]));

  const areas = await AreaModel.find({
    _id: { $in: commutes.map((c) => c.originAreaId) },
  })
    .select("name")
    .lean();
  const areaById = new Map(areas.map((a) => [a._id.toString(), a]));

  const vehicles = await VehicleModel.find({
    _id: { $in: commutes.map((c) => c.vehicleId).filter(Boolean) },
  })
    .select("type model plate")
    .lean();
  const vehicleById = new Map(vehicles.map((v) => [v._id.toString(), v]));

  // Plates are masked while browsing and shown in full on a ride the caller
  // actually has a seat on. See maskPlate.
  const confirmed = await confirmedRideIds(
    context.userId,
    instances.map((i) => i._id),
  );

  const listings: RideListing[] = [];

  for (const instance of instances) {
    const commute = commuteById.get(instance.commuteId.toString());
    const driver = userById.get(instance.driverId.toString());
    if (!commute || !driver) continue;

    const vehicle = commute.vehicleId
      ? vehicleById.get(commute.vehicleId.toString())
      : undefined;

    // No vehicle means no listing. Creating a commute that offers seats
    // already requires one, so this only catches a vehicle deleted underneath
    // an existing offer — and a ride with no vehicle is not one to show.
    if (!vehicle) continue;

    listings.push({
      // The instance, because that is what a seat is requested on. The
      // template is carried separately as commuteId.
      id: instance._id.toString(),
      commuteId: commute._id.toString(),
      driver: toPublicUser(driver),
      vehicleType: vehicle.type as VehicleType,
      ...(vehicle.model ? { vehicleModel: vehicle.model } : {}),
      ...(vehicle.plate
        ? confirmed.has(instance._id.toString())
          ? { vehiclePlate: vehicle.plate, plateVisibility: "full" as const }
          : { vehiclePlate: maskPlate(vehicle.plate), plateVisibility: "masked" as const }
        : {}),
      originArea: areaById.get(commute.originAreaId.toString())?.name ?? "",
      destinationCampus: campus?.name ?? "",
      // Their whole pattern, so the viewer can see which days line up rather
      // than being shown one day out of context.
      schedule: commute.schedule.map((entry) => ({
        day: entry.day as Weekday,
        ...(entry.arriveBy ? { arriveBy: entry.arriveBy } : {}),
        ...(entry.leaveCampusAt ? { leaveCampusAt: entry.leaveCampusAt } : {}),
      })),
      direction: commute.direction as RideListing["direction"],
      seatsAvailable: Math.max(0, instance.seatsOffered - instance.seatsTaken),
      contribution: commute.contribution ?? 0,
      womenOnly: commute.womenOnly,
      // Always true: every result is filtered to the caller's own campus
      // before it gets here, and the card drops the redundant destination.
      sameCampus: true,
    });
  }

  return listings;
}

/** Everything with a free seat, before any of the caller's own filters. */
function openSeatFilter(context: Context, day?: Weekday) {
  return {
    driverId: { $nin: [new Types.ObjectId(context.userId), ...context.hidden] },
    date: { $gte: new Date() },
    status: "scheduled" as const,
    // Atomic in the query rather than filtered afterwards, so a ride that
    // filled up between the read and the render never appears as available.
    $expr: { $lt: ["$seatsTaken", "$seatsOffered"] },
    ...(day ? { day } : {}),
  };
}

/**
 * Schedule-matched search.
 *
 * Institution and campus are constraints and come from the account. Time is
 * compared against the caller's requested arrival with a tolerance, because
 * "on campus by 8:00" and "by 8:15" are the same run.
 */
export async function searchRides(
  userId: string,
  params: RideSearch,
): Promise<RideListing[]> {
  const context = await contextFor(userId, params);

  // Restricted to commutes at the caller's own campus before anything else.
  const eligible = await CommuteModel.find({
    institutionId: context.institutionId,
    campusId: context.campusId,
    status: "active",
    intent: { $in: ["offer", "both"] },
    ...(params.womenOnly !== undefined ? { womenOnly: params.womenOnly } : {}),
  })
    .select("_id")
    .lean();

  if (eligible.length === 0) return [];

  const instances = (await RideInstanceModel.find({
    ...openSeatFilter(context, params.day),
    commuteId: { $in: eligible.map((c) => c._id) },
  })
    .sort({ date: 1 })
    .limit(100)
    .lean()) as ListingRow[];

  const wanted = params.time ? minutesFromTime(params.time) : null;

  const timely =
    wanted === null
      ? instances
      : instances.filter((instance) => {
          if (!instance.arriveBy) return false;
          const theirs = minutesFromTime(instance.arriveBy);
          return theirs !== null && Math.abs(theirs - wanted) <= DEFAULT_TIME_TOLERANCE;
        });

  const listings = await buildListings(context, timely);

  return params.vehicleType
    ? listings.filter((listing) => listing.vehicleType === params.vehicleType)
    : listings;
}

/**
 * Nearby: same institution and campus, time relaxed, distance enforced.
 *
 * The radius has to mean something or this is just "every ride". Three
 * kilometres between area centroids is roughly a detour a driver would make on
 * a route they were already taking.
 *
 * The distance itself is never returned — only the phrase.
 */
export async function nearbyRides(
  userId: string,
  params: { day?: Weekday },
): Promise<RideListing[]> {
  const context = await contextFor(userId, {});
  if (!context.originAreaId) return [];

  const myArea = await AreaModel.findById(context.originAreaId).lean();
  if (!myArea?.centroid) return [];

  const radius = await nearbyRadiusKm();

  // Area centroids are compared in memory: there are sixteen of them, and a
  // geospatial index exists for querying user locations — which this product
  // does not have.
  const areas = await AreaModel.find({ city: myArea.city, active: true }).lean();
  const nearbyAreaIds = areas
    .filter(
      (area) =>
        area.centroid && distanceKm(myArea.centroid!, area.centroid) <= radius,
    )
    .map((area) => area._id);

  if (nearbyAreaIds.length === 0) return [];

  const eligible = await CommuteModel.find({
    institutionId: context.institutionId,
    campusId: context.campusId,
    status: "active",
    intent: { $in: ["offer", "both"] },
    originAreaId: { $in: nearbyAreaIds },
  })
    .select("_id")
    .lean();

  if (eligible.length === 0) return [];

  const instances = (await RideInstanceModel.find({
    ...openSeatFilter(context, params.day),
    commuteId: { $in: eligible.map((c) => c._id) },
  })
    .sort({ date: 1 })
    .limit(100)
    .lean()) as ListingRow[];

  return buildListings(context, instances);
}

export async function getRide(
  userId: string,
  rideId: string,
): Promise<RideListing | null> {
  const context = await contextFor(userId, {});

  const instance = (await RideInstanceModel.findOne({
    _id: rideId,
    driverId: { $nin: context.hidden },
  }).lean()) as ListingRow | null;

  if (!instance) return null;

  // Campus is re-checked here: a ride id guessed or shared from elsewhere must
  // not open a listing from another community.
  const commute = await CommuteModel.findOne({
    _id: instance.commuteId,
    institutionId: context.institutionId,
    campusId: context.campusId,
  }).select("_id").lean();

  if (!commute) return null;

  const listings = await buildListings(context, [instance]);
  return listings[0] ?? null;
}
