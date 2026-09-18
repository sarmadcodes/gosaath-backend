import { describe, expect, it } from "vitest";
import { distanceKm, roundKm } from "../../src/utils/geo.js";
import { KARACHI_AREAS } from "../../src/data/areas.seed.js";

const area = (id: string) => {
  const found = KARACHI_AREAS.find((a) => a.id === id);
  if (!found) throw new Error(`missing seed area ${id}`);
  return found.centroid;
};

describe("distanceKm", () => {
  it("is zero for the same point", () => {
    expect(distanceKm(area("area-clifton"), area("area-clifton"))).toBe(0);
  });

  it("is symmetric", () => {
    const a = distanceKm(area("area-gulshan"), area("area-malir"));
    const b = distanceKm(area("area-malir"), area("area-gulshan"));
    expect(roundKm(a)).toBe(roundKm(b));
  });

  it("places adjacent DHA phases within a couple of kilometres", () => {
    expect(distanceKm(area("area-dha-5"), area("area-dha-6"))).toBeLessThan(2);
  });

  it("places opposite ends of Karachi far apart", () => {
    // Clifton (south, coastal) to North Karachi. Anything under 15km here
    // would mean the centroids are wrong.
    expect(distanceKm(area("area-clifton"), area("area-nk"))).toBeGreaterThan(15);
  });
});

describe("the 3km nearby threshold", () => {
  const RADIUS = 3;
  const within = (a: string, b: string) => distanceKm(area(a), area(b)) <= RADIUS;

  it("treats neighbouring areas as nearby", () => {
    // Tariq Road and Bahadurabad genuinely adjoin.
    expect(within("area-tariq-road", "area-bahadurabad")).toBe(true);
    expect(within("area-dha-5", "area-dha-6")).toBe(true);
  });

  it("does not treat a cross-city run as nearby", () => {
    expect(within("area-clifton", "area-malir")).toBe(false);
    expect(within("area-nk", "area-dha-8")).toBe(false);
  });

  it("excludes Gulshan from Clifton", () => {
    // ~13km apart. If this ever passes, the radius or the centroids are wrong
    // and "nearby" has quietly become "everyone".
    expect(within("area-gulshan", "area-clifton")).toBe(false);
  });
});

describe("area seed data", () => {
  it("gives every area a centroid inside Karachi", () => {
    for (const a of KARACHI_AREAS) {
      // Karachi sits roughly 24.7–25.1 N, 66.9–67.3 E. A typo that swapped
      // lat and lng would land in the Arabian Sea and silently break matching.
      expect(a.centroid.lat, a.name).toBeGreaterThan(24.6);
      expect(a.centroid.lat, a.name).toBeLessThan(25.2);
      expect(a.centroid.lng, a.name).toBeGreaterThan(66.8);
      expect(a.centroid.lng, a.name).toBeLessThan(67.4);
    }
  });

  it("has no duplicate ids or names", () => {
    expect(new Set(KARACHI_AREAS.map((a) => a.id)).size).toBe(KARACHI_AREAS.length);
    expect(new Set(KARACHI_AREAS.map((a) => a.name)).size).toBe(KARACHI_AREAS.length);
  });
});
