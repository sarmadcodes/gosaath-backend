import { env } from "../../config/env.js";
import { logger } from "../../utils/logger.js";
import type { Centroid } from "../../utils/geo.js";

/**
 * Road distance and travel time between two area centroids.
 *
 * Google's Routes API, used deliberately narrowly. It is asked only for the
 * pair of areas somebody is actually looking at — a match they opened, a
 * route preview on a ride they are considering — and never on the matching
 * path, which compares every candidate area and would turn one screen into
 * dozens of billable calls and a visible wait.
 *
 * Everything here degrades to nothing. No key, a timeout, a quota error, a
 * shape Google changed: each returns null and the caller falls back to the
 * straight-line estimate that shipped before this existed. A routing outage
 * must never be a GoSaath outage.
 *
 * What is sent is two neighbourhood centroids. Not a person, not an address,
 * not a device position — the same public geography that is already in the
 * seed file.
 */

const ENDPOINT = "https://routes.googleapis.com/directions/v2:computeRoutes";

/**
 * How long an answer is reused.
 *
 * Centroids never move, so the distance is effectively permanent; the
 * duration is traffic-aware and goes stale. Fifteen minutes is the
 * compromise: long enough that opening the same match twice costs one call,
 * short enough that a morning estimate is not shown in the evening.
 */
const TTL_MS = 15 * 60_000;

/** Bounded so a long session cannot grow it without limit. */
const MAX_ENTRIES = 500;

export type RoadEstimate = {
  km: number;
  minutes: number;
};

type Entry = { value: RoadEstimate | null; expiresAt: number };

const cache = new Map<string, Entry>();

const keyFor = (from: Centroid, to: Centroid) =>
  `${from.lat.toFixed(4)},${from.lng.toFixed(4)}>${to.lat.toFixed(4)},${to.lng.toFixed(4)}`;

/** Exposed for tests, which must not inherit another test's answers. */
export function resetRoutingCache(): void {
  cache.clear();
}

export function routingConfigured(): boolean {
  return Boolean(env.GOOGLE_MAPS_API_KEY);
}

/**
 * Google returns a duration as a string of seconds with a trailing "s".
 * Anything else is treated as absent rather than coerced.
 */
function secondsFrom(duration: unknown): number | null {
  if (typeof duration !== "string") return null;
  const match = /^(\d+(?:\.\d+)?)s$/.exec(duration);
  if (!match) return null;
  const seconds = Number(match[1]);
  return Number.isFinite(seconds) ? seconds : null;
}

export async function roadEstimate(
  from: Centroid,
  to: Centroid,
): Promise<RoadEstimate | null> {
  const key = env.GOOGLE_MAPS_API_KEY;
  if (!key) return null;

  const cacheKey = keyFor(from, to);
  const hit = cache.get(cacheKey);
  if (hit && hit.expiresAt > Date.now()) return hit.value;

  // Aborted rather than merely awaited with a race: an abandoned fetch holds
  // a socket open, and under load that is how a slow dependency becomes
  // this server's problem.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.ROUTING_TIMEOUT_MS);

  try {
    const response = await fetch(ENDPOINT, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": key,
        // Google bills partly on the fields returned, and refuses the call
        // without this header. Two fields are all this needs.
        "X-Goog-FieldMask": "routes.distanceMeters,routes.duration",
      },
      body: JSON.stringify({
        origin: { location: { latLng: { latitude: from.lat, longitude: from.lng } } },
        destination: { location: { latLng: { latitude: to.lat, longitude: to.lng } } },
        travelMode: "DRIVE",
        // The whole reason to call a routing service rather than measure a
        // straight line: a commute is planned around traffic.
        routingPreference: "TRAFFIC_AWARE",
        units: "METRIC",
      }),
    });

    if (!response.ok) {
      // Logged without the key and without the body, which can echo it back.
      logger.warn({ status: response.status }, "routing provider refused");
      cache.set(cacheKey, { value: null, expiresAt: Date.now() + TTL_MS });
      return null;
    }

    const body = (await response.json()) as {
      routes?: { distanceMeters?: number; duration?: string }[];
    };

    const route = body.routes?.[0];
    const metres = route?.distanceMeters;
    const seconds = secondsFrom(route?.duration);

    if (typeof metres !== "number" || seconds === null) {
      cache.set(cacheKey, { value: null, expiresAt: Date.now() + TTL_MS });
      return null;
    }

    const value: RoadEstimate = {
      km: Math.round((metres / 1000) * 10) / 10,
      // Rounded up: arriving early is a smaller failure than arriving late.
      minutes: Math.max(1, Math.ceil(seconds / 60)),
    };

    if (cache.size >= MAX_ENTRIES) cache.clear();
    cache.set(cacheKey, { value, expiresAt: Date.now() + TTL_MS });
    return value;
  } catch (error) {
    // Includes the abort. Debug rather than warn: a timeout here is an
    // expected outcome with a working fallback, not an incident.
    logger.debug({ err: error }, "routing lookup failed, using straight line");
    return null;
  } finally {
    clearTimeout(timer);
  }
}
