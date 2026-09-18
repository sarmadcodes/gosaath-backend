/**
 * Distance between two area centroids.
 *
 * Used only to decide what counts as "nearby". The result never leaves the
 * server: the client receives a phrase ("~12 min away"), because a figure like
 * "2.4 km" would imply a precision this product does not have.
 */

const EARTH_RADIUS_KM = 6371;

export type Centroid = { lat: number; lng: number };

const toRadians = (degrees: number) => (degrees * Math.PI) / 180;

/**
 * Great-circle distance, in kilometres.
 *
 * Haversine rather than a routed distance on purpose. A routing API would be
 * more accurate and would also cost a network call per candidate on the
 * matching hot path. At the three-kilometre threshold this decides, straight
 * line and road distance rank neighbourhoods the same way.
 */
export function distanceKm(a: Centroid, b: Centroid): number {
  const dLat = toRadians(b.lat - a.lat);
  const dLng = toRadians(b.lng - a.lng);
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);

  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}

/** Rounded to one decimal, for logs and internal comparisons only. */
export function roundKm(value: number): number {
  return Math.round(value * 10) / 10;
}
