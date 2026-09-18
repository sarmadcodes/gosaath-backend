import { AreaModel } from "../../db/models/index.js";
import type { Area } from "../../contract/types.js";

/**
 * Areas.
 *
 * The centroid is NEVER included in what is returned. It exists so the server
 * can decide whether two areas are within the nearby radius; handing it to a
 * client would turn an area-level product into one that ships coordinates.
 */
export async function listAreas(city = "Karachi"): Promise<Area[]> {
  const areas = await AreaModel.find({ city, active: true })
    .select("name city")
    .sort({ name: 1 })
    .lean();

  return areas.map((area) => ({
    id: area._id.toString(),
    name: area.name,
    city: area.city,
  }));
}
