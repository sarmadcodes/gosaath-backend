import { UserModel } from "../../db/models/index.js";
import type { Gender } from "../../contract/types.js";

/**
 * Women-only, as one rule in one place.
 *
 * Gender is self-declared and optional. A commute is women-only IN EFFECT
 * only when its flag is set AND its owner has declared themselves a woman;
 * only declared women may create one, see one, or take a seat on one.
 *
 * Deriving the effective value rather than trusting the stored flag is what
 * keeps older data safe: a flag set before anybody had a gender, or left
 * behind by someone who later changed theirs, simply has no effect. It reads
 * as an ordinary ride instead of a promise the system cannot keep.
 */

export function genderOf(doc: { gender?: string | null } | null | undefined): Gender {
  const value = doc?.gender;
  return value === "woman" || value === "man" ? value : "undisclosed";
}

export function isWoman(doc: { gender?: string | null } | null | undefined): boolean {
  return genderOf(doc) === "woman";
}

export async function isWomanById(userId: { toString(): string }): Promise<boolean> {
  const user = await UserModel.findById(userId).select("gender").lean();
  return isWoman(user);
}

/** Of these users, the ones who have declared themselves women. */
export async function womenAmong(
  userIds: readonly { toString(): string }[],
): Promise<Set<string>> {
  if (userIds.length === 0) return new Set();
  const rows = await UserModel.find({
    _id: { $in: userIds.map((id) => id.toString()) },
    gender: "woman",
  })
    .select("_id")
    .lean();
  return new Set(rows.map((row) => row._id.toString()));
}

export function womenOnlyInEffect(
  commute: { womenOnly?: boolean | null },
  ownerIsWoman: boolean,
): boolean {
  return Boolean(commute.womenOnly) && ownerIsWoman;
}

export const WOMEN_ONLY_REFUSAL =
  "Women-only rides are for members who have said they are women. You can set this in your profile.";
