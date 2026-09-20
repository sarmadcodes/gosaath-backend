import { distanceKm, roundKm } from "../../utils/geo.js";
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
 * How close two areas are, as a phrase.
 *
 * `label` is what the client renders. `distanceKm` is carried for the nearby
 * filter and is never displayed: "2.4 km" implies a precision this product
 * does not have and is not going to have, because it does not know where
 * anybody actually lives.
 */
export function proximityBetween(
  from: AreaLike,
  to: AreaLike,
): ProximityEstimate {
  if (!from.centroid || !to.centroid) {
    return { label: "Nearby", approximate: true };
  }

  const km = distanceKm(from.centroid, to.centroid);
  const minutes = Math.max(5, Math.round((km * MINUTES_PER_KM) / 5) * 5);

  return {
    label: km < 1.5 ? "Same part of town" : `~${minutes} min away`,
    distanceKm: roundKm(km),
    approximate: true,
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
  return proximityBetween(from, to);
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
    ? proximityBetween(origin, destination)
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
