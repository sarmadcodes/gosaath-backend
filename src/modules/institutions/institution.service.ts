import { escapeRegExp } from "../../utils/text.js";
import { NotFoundError } from "../../utils/errors.js";
import {
  CampusModel,
  InstitutionModel,
  InstitutionRequestModel,
} from "../../db/models/index.js";
import type {
  Campus,
  Institution,
  InstitutionRequest,
  InstitutionType,
} from "../../contract/types.js";

/**
 * Institutions, campuses and the request queue.
 *
 * Everything user-facing here filters on `active`. The seed holds 25 Karachi
 * institutions and exactly one is live; the rest must be invisible until the
 * Super Admin activation checklist has been through them, or somebody
 * registers into a campus with no real campus list and nobody to review
 * badges.
 */

function toInstitution(doc: {
  _id: { toString(): string };
  name: string;
  shortName?: string | null;
  type: string;
  emailDomains: string[];
  city: string;
  active: boolean;
  brandColor: string;
  featured?: boolean | null;
}): Institution {
  return {
    id: doc._id.toString(),
    name: doc.name,
    ...(doc.shortName ? { shortName: doc.shortName } : {}),
    type: doc.type as InstitutionType,
    emailDomains: doc.emailDomains,
    city: doc.city,
    active: doc.active,
    brandColor: doc.brandColor,
    ...(doc.featured ? { featured: true } : {}),
  };
}

export async function searchInstitutions(
  query: string,
  type?: InstitutionType,
): Promise<Institution[]> {
  const filter: Record<string, unknown> = { active: true };
  if (type) filter["type"] = type;

  const trimmed = query.trim();
  if (trimmed) {
    // Escaped before it becomes a regex. A raw user string here would let
    // somebody send ".*" to match everything, or a catastrophically
    // backtracking pattern to pin the CPU.
    const safe = new RegExp(escapeRegExp(trimmed), "i");
    filter["$or"] = [{ name: safe }, { shortName: safe }];
  }

  const results = await InstitutionModel.find(filter)
    // Featured first, so SZABIST leads the picker at launch.
    .sort({ featured: -1, name: 1 })
    .limit(50)
    .lean();

  return results.map(toInstitution);
}

export async function campusesFor(institutionId: string): Promise<Campus[]> {
  const institution = await InstitutionModel.findOne({
    _id: institutionId,
    active: true,
  }).lean();

  // 404 rather than an empty list: an inactive institution having no campuses
  // and an unknown id are different situations, and the client should not
  // quietly show an empty picker for either.
  if (!institution) throw new NotFoundError("That institution is not available.");

  const campuses = await CampusModel.find({
    institutionId: institution._id,
    active: true,
  })
    .sort({ name: 1 })
    .lean();

  return campuses.map((campus) => ({
    id: campus._id.toString(),
    institutionId: campus.institutionId.toString(),
    name: campus.name,
    ...(campus.areaId ? { areaId: campus.areaId.toString() } : {}),
  }));
}

/**
 * Submits an institution for review.
 *
 * Creates a request and nothing else. A user-submitted institution must never
 * become a live one — that is a Super Admin action behind a checklist, and
 * letting this endpoint create an Institution would be a way to conjure a
 * community with unverified email domains and register into it.
 */
export async function requestInstitution(input: {
  name: string;
  type: InstitutionType;
  website?: string | undefined;
  campusName?: string | undefined;
  requestedByEmail: string;
}): Promise<InstitutionRequest> {
  const created = await InstitutionRequestModel.create({
    name: input.name,
    type: input.type,
    website: input.website ?? undefined,
    campusName: input.campusName ?? undefined,
    requestedByEmail: input.requestedByEmail,
    status: "pending",
  });

  return {
    id: created._id.toString(),
    name: created.name,
    type: created.type as InstitutionType,
    ...(created.website ? { website: created.website } : {}),
    ...(created.campusName ? { campusName: created.campusName } : {}),
    requestedByEmail: created.requestedByEmail,
    status: created.status as InstitutionRequest["status"],
    createdAt: created.createdAt.toISOString(),
  };
}
