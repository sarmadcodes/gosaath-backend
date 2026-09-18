/**
 * Karachi areas, with an approximate centroid for each.
 *
 * The centroid is public geography about a *neighbourhood* — roughly where
 * Gulshan-e-Iqbal sits on a map. It is categorically different from storing
 * where a person is, and the product rule stands unchanged: a user record
 * holds `areaId` and nothing else. No latitude or longitude is ever collected
 * from, stored against, or returned for a human being.
 *
 * The centroid exists for exactly one job: deciding whether two areas are
 * within `NEARBY_RADIUS_KM` of each other. It is never serialised to a client.
 *
 * Coordinates are hand-placed at the commonly understood centre of each area
 * and are accurate to roughly a kilometre, which is the right precision for a
 * product that deliberately refuses to know more.
 */
export type AreaSeed = {
  id: string;
  name: string;
  city: string;
  centroid: { lat: number; lng: number };
};

export const KARACHI_AREAS: AreaSeed[] = [
  { id: "area-dha-2",      name: "DHA Phase 2",      city: "Karachi", centroid: { lat: 24.8210, lng: 67.0470 } },
  { id: "area-dha-5",      name: "DHA Phase 5",      city: "Karachi", centroid: { lat: 24.8030, lng: 67.0620 } },
  { id: "area-dha-6",      name: "DHA Phase 6",      city: "Karachi", centroid: { lat: 24.7990, lng: 67.0730 } },
  { id: "area-dha-8",      name: "DHA Phase 8",      city: "Karachi", centroid: { lat: 24.7900, lng: 67.0350 } },
  { id: "area-clifton",    name: "Clifton",          city: "Karachi", centroid: { lat: 24.8138, lng: 67.0300 } },
  { id: "area-gulshan",    name: "Gulshan-e-Iqbal",  city: "Karachi", centroid: { lat: 24.9215, lng: 67.0950 } },
  { id: "area-johar",      name: "Gulistan-e-Johar", city: "Karachi", centroid: { lat: 24.9260, lng: 67.1300 } },
  { id: "area-nazimabad",  name: "North Nazimabad",  city: "Karachi", centroid: { lat: 24.9420, lng: 67.0370 } },
  { id: "area-pechs",      name: "PECHS",            city: "Karachi", centroid: { lat: 24.8720, lng: 67.0640 } },
  { id: "area-bahadurabad",name: "Bahadurabad",      city: "Karachi", centroid: { lat: 24.8790, lng: 67.0650 } },
  { id: "area-tariq-road", name: "Tariq Road",       city: "Karachi", centroid: { lat: 24.8700, lng: 67.0590 } },
  { id: "area-malir",      name: "Malir",            city: "Karachi", centroid: { lat: 24.8930, lng: 67.2050 } },
  { id: "area-saddar",     name: "Saddar",           city: "Karachi", centroid: { lat: 24.8600, lng: 67.0200 } },
  { id: "area-korangi",    name: "Korangi",          city: "Karachi", centroid: { lat: 24.8400, lng: 67.1330 } },
  { id: "area-nk",         name: "North Karachi",    city: "Karachi", centroid: { lat: 24.9800, lng: 67.0620 } },
  { id: "area-fbarea",     name: "Federal B Area",   city: "Karachi", centroid: { lat: 24.9350, lng: 67.0680 } },
];
