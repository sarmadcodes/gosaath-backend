import { PreferencesModel } from "../../db/models/index.js";
import type { MatchPreferences } from "../../contract/api.js";

/**
 * Matching preferences, owned entirely by the user they belong to.
 *
 * Every function takes the id from the session. There is no route that accepts
 * a user id, so there is nothing to tamper with — `PATCH /preferences/:userId`
 * simply does not exist.
 */

const DEFAULTS: MatchPreferences = {
  womenOnly: false,
  verifiedOnly: false,
  carsOnly: false,
  sameCampusOnly: true,
  autoAcceptVerified: false,
  pickupRadius: "Same area",
  timeWindow: "30 minutes",
};

function toPreferences(doc: Partial<MatchPreferences> | null): MatchPreferences {
  // Defaults rather than a 404. Somebody who has never opened the screen has
  // preferences — they are simply the defaults — and the client should not
  // have to treat "never saved" as an error state.
  return { ...DEFAULTS, ...(doc ?? {}) };
}

export async function getPreferences(userId: string): Promise<MatchPreferences> {
  const doc = await PreferencesModel.findOne({ userId }).lean();
  return toPreferences(doc);
}

export async function updatePreferences(
  userId: string,
  patch: Partial<MatchPreferences>,
): Promise<MatchPreferences> {
  // Upsert, because the screen writes through on every toggle and the first
  // one must not fail for want of a row. Idempotent by construction: the same
  // toggle sent twice by a retrying client lands on the same value.
  const updated = await PreferencesModel.findOneAndUpdate(
    { userId },
    { $set: patch, $setOnInsert: { userId } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).lean();

  return toPreferences(updated);
}
