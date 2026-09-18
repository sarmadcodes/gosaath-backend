import type { PublicUser, User } from "../../contract/types.js";

/**
 * The privacy boundary, in code.
 *
 * Every user-shaped response is built here. Routes never serialise a Mongoose
 * document directly — doing so is how `passwordHash`, `role` or an internal
 * flag reaches a client the first time somebody adds a field.
 */

type UserLike = {
  _id: { toString(): string };
  name: string;
  email: string;
  phone: string;
  photoUrl?: string | null;
  userType: string;
  institutionId: { toString(): string };
  campusId: { toString(): string };
  areaId: { toString(): string };
  badgeStatus: string;
  additionalInstitutionIds?: Array<{ toString(): string }>;
  role?: string | null;
};

/**
 * The full record, for the authenticated user themselves and nobody else.
 *
 * Fields are listed explicitly rather than spread, so a new column on the
 * schema does not silently join the response.
 */
export function toUser(doc: UserLike): User {
  return {
    id: doc._id.toString(),
    name: doc.name,
    email: doc.email,
    phone: doc.phone,
    photoUrl: doc.photoUrl ?? null,
    userType: doc.userType as User["userType"],
    institutionId: doc.institutionId.toString(),
    campusId: doc.campusId.toString(),
    areaId: doc.areaId.toString(),
    badgeStatus: doc.badgeStatus as User["badgeStatus"],
    additionalInstitutionIds: (doc.additionalInstitutionIds ?? []).map((id) =>
      id.toString(),
    ),
    role: (doc.role as User["role"]) ?? "member",
  };
}

/**
 * What anyone else is allowed to see.
 *
 * First name, photo, and whether the optional badge was approved. No full
 * name, no email, no phone, no area, and deliberately no `role` — which staff
 * member administers a campus is not another commuter's business, and exposing
 * it would leak staff identities to every person they match with.
 *
 * Adding a field here is a product decision, not a technical one.
 */
export function toPublicUser(doc: UserLike): PublicUser {
  return {
    id: doc._id.toString(),
    // Split rather than stored separately: the account holds one name, and
    // showing "Ayesha" where the record says "Ayesha Khan" is the whole point.
    firstName: doc.name.trim().split(/\s+/)[0] ?? doc.name.trim(),
    photoUrl: doc.photoUrl ?? null,
    verified: doc.badgeStatus === "approved",
  };
}

/**
 * Contact details, for people already in a relationship.
 *
 * Separate from `toPublicUser` on purpose: a phone number is not part of the
 * public shape, and the caller must have established a reason — a match, or
 * shared membership of a commute — before reaching for this.
 */
export function contactPhoneFor(doc: { phone: string }): string {
  return doc.phone;
}
