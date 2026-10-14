import { distanceKm, roundKm } from "../../utils/geo.js";
import { roadEstimate } from "./routing.service.js";
import { escapeRegExp } from "../../utils/text.js";
import { NotFoundError } from "../../utils/errors.js";
import {
  AreaModel,
  CampusModel,
  CommuteModel,
  ConfigurationModel,
} from "../../db/models/index.js";
import type {
  AreaSuggestion,
  ProximityEstimate,
  RoutePreview,
} from "../../contract/types.js";

/**
 * Location, at area granularity and no finer.
 *
 * Note what is absent: no current position, no watch, no coordinate in any
 * signature. Everything resolves to an `areaId`, because that is the only
 * granularity this product stores for a person.
 *
 * Area centroids exist here and are used to decide what counts as nearby. They
 * are geography about a neighbourhood, not about anybody, and they never leave
 * the server.
 */

const DEFAULT_NEARBY_RADIUS_KM = 3;

/** Rough minutes per kilometre across Karachi traffic. */
const MINUTES_PER_KM = 3;

type AreaLike = {
  _id: { toString(): string };
  name: string;
  city: string;
  centroid?: { lat: number; lng: number } | null;
};

export async function nearbyRadiusKm(): Promise<number> {
  const setting = await ConfigurationModel.findOne({
    key: "NEARBY_RADIUS_KM",
  }).lean();
  const value = setting?.value;
  return typeof value === "number" && value > 0 ? value : DEFAULT_NEARBY_RADIUS_KM;
}

function toSuggestion(area: AreaLike): AreaSuggestion {
  return {
    areaId: area._id.toString(),
    name: area.name,
    city: area.city,
  };
}

export async function searchAreas(query: string): Promise<AreaSuggestion[]> {
  const trimmed = query.trim();
  const filter: Record<string, unknown> = { active: true };

  if (trimmed) {
    // Escaped: a raw user string here lets somebody send ".*" to match
    // everything, or a backtracking pattern to pin the CPU.
    filter["name"] = new RegExp(escapeRegExp(trimmed), "i");
  }

  const areas = await AreaModel.find(filter)
    .select("name city")
    .sort({ name: 1 })
    .limit(20)
    .lean();

  return areas.map(toSuggestion);
}

/**
 * Areas this person has actually used.
 *
 * Their own origin first, then the campus area. Not a global "popular areas"
 * list: what is common across the campus is not what this person wants, and
 * surfacing it would leak where everybody else lives.
 */
export async function recentAreas(userId: string): Promise<AreaSuggestion[]> {
  const commute = await CommuteModel.findOne({ ownerId: userId })
    .select("originAreaId campusId")
    .lean();

  if (!commute) return [];

  const campus = await CampusModel.findById(commute.campusId).select("areaId").lean();

  const ids = [commute.originAreaId, campus?.areaId].filter(Boolean);
  if (ids.length === 0) return [];

  const areas = await AreaModel.find({ _id: { $in: ids }, active: true })
    .select("name city")
    .lean();

  return areas.map(toSuggestion);
}

/**
 * How close two areas are, as a phrase and a figure.
 *
 * Synchronous and straight-line on purpose. This is the version the matching
 * path uses, where every candidate area is compared and a network call per
 * candidate would be both slow and billable. `proximityFor` is the one that
 * asks a routing service, and it is only ever called about a single pair
 * somebody is looking at.
 *
 * The kilometres are area to area, which is public geography about two
 * neighbourhoods rather than about either person — the finest thing this
 * product knows. `approximate` says which kind of figure it is.
 */
export function proximityBetween(
  from: AreaLike,
  to: AreaLike,
): ProximityEstimate {
  if (!from.centroid || !to.centroid) {
    return { label: "Nearby", approximate: true };
  }

  const km = roundKm(distanceKm(from.centroid, to.centroid));
  const minutes = Math.max(5, Math.round((km * MINUTES_PER_KM) / 5) * 5);

  return {
    label: labelFor(km, minutes, true),
    distanceKm: km,
    approximate: true,
  };
}

/**
 * One phrase, so the two paths below cannot drift apart.
 *
 * Under a kilometre and a half the distance is noise and the honest answer is
 * that they are in the same place. Beyond that both numbers are given,
 * because "how far" and "how long" are different questions and in Karachi
 * they have very different answers.
 */
function labelFor(km: number, minutes: number, approximate: boolean): string {
  if (km < 1.5) return "Same part of town";
  const tilde = approximate ? "~" : "";
  return `${km} km · ${tilde}${minutes} min`;
}

/**
 * The same estimate, allowed to ask a routing service first.
 *
 * Used where somebody is looking at one specific pair — a match they opened,
 * a ride they are considering. Falls back to the straight line whenever
 * routing is unconfigured, slow or unhappy, so the figure is always present
 * and `approximate` is the only thing that changes.
 */
export async function proximityFor(
  from: AreaLike,
  to: AreaLike,
): Promise<ProximityEstimate> {
  const fallback = proximityBetween(from, to);
  if (!from.centroid || !to.centroid) return fallback;

  const road = await roadEstimate(from.centroid, to.centroid);
  if (!road) return fallback;

  return {
    label: labelFor(road.km, road.minutes, false),
    distanceKm: road.km,
    approximate: false,
  };
}

export async function proximity(
  fromAreaId: string,
  toAreaId: string,
): Promise<ProximityEstimate> {
  const [from, to] = await Promise.all([
    AreaModel.findById(fromAreaId).lean(),
    AreaModel.findById(toAreaId).lean(),
  ]);

  if (!from || !to) throw new NotFoundError("That area was not found.");
  return proximityFor(from, to);
}

/**
 * Origin area to destination campus.
 *
 * Deliberately not a map and not a polyline. A pin over somebody's home area
 * would expose more than the product should, and a drawn route implies a
 * precision that does not exist.
 */
export async function routePreview(
  originAreaId: string,
  campusId: string,
): Promise<RoutePreview> {
  const [origin, campus] = await Promise.all([
    AreaModel.findById(originAreaId).lean(),
    CampusModel.findById(campusId).lean(),
  ]);

  if (!origin || !campus) throw new NotFoundError("That route was not found.");

  const destination = campus.areaId
    ? await AreaModel.findById(campus.areaId).lean()
    : null;

  const estimate = destination
    ? await proximityFor(origin, destination)
    : { label: "Nearby", approximate: true as const };

  return {
    originArea: origin.name,
    destinationCampus: campus.name,
    estimate,
  };
}

/**
 * Whether two areas are close enough to count as nearby.
 *
 * The radius has to mean something, or "nearby rides" is just "every ride".
 * Three kilometres is roughly a detour a driver would make on a route they
 * were already taking; beyond that the pickup stops being incidental and
 * becomes a favour.
 */
export async function areasAreNearby(
  from: AreaLike,
  to: AreaLike,
  radiusKm?: number,
): Promise<boolean> {
  if (!from.centroid || !to.centroid) return false;
  const radius = radiusKm ?? (await nearbyRadiusKm());
  return distanceKm(from.centroid, to.centroid) <= radius;
}
