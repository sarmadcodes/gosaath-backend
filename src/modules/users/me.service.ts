import { Types } from "mongoose";
import { logger } from "../../utils/logger.js";
import {
  AuthenticationError,
  BusinessRuleError,
  NotFoundError,
  UnprocessableError,
} from "../../utils/errors.js";
import {
  AreaModel,
  InstitutionModel,
  UserModel,
} from "../../db/models/index.js";
import { toUser } from "./user.mapper.js";
import type { User } from "../../contract/types.js";
import type { UpdateMeBody } from "./me.schemas.js";

/**
 * The authenticated user's own record.
 *
 * Every function here loads the user by the id on the session, never by an id
 * from the request. There is deliberately no "get user by id" in this module:
 * a member has no business fetching another member's record, and the only
 * shape anyone else is ever exposed as is `PublicUser`.
 */

async function load(userId: string, withBadgeDocument = false) {
  const query = UserModel.findById(userId);
  // The badge document is select:false, so asking for it has to be deliberate.
  if (withBadgeDocument) query.select("+badgeDocumentUrl");
  const user = await query;
  if (!user) {
    // The session is valid but the account is gone — deleted, or the database
    // was restored. Treated as signed out rather than as a 404, because the
    // client's only sensible response is to sign in again.
    throw new AuthenticationError("Your session has expired. Sign in again.");
  }
  return user;
}

export async function getMe(userId: string): Promise<User> {
  return toUser(await load(userId));
}

export async function updateMe(
  userId: string,
  patch: UpdateMeBody,
): Promise<User> {
  const user = await load(userId);

  // Assigned field by field. Never `user.set(patch)` — that is one schema
  // change away from letting a validated-but-wider body reach the document.
  if (patch.name !== undefined) user.name = patch.name;
  if (patch.phone !== undefined) user.phone = patch.phone;
  if (patch.photoUrl !== undefined) user.photoUrl = patch.photoUrl ?? null;

  if (patch.areaId !== undefined) {
    // Checked, because an unknown area silently breaks matching: the commute
    // would point at nothing and the person would simply never appear.
    const area = await AreaModel.findOne({ _id: patch.areaId, active: true });
    if (!area) throw new UnprocessableError("That area is not available.");
    user.areaId = area._id;
  }

  await user.save();
  return toUser(user);
}

export async function setPhoto(
  userId: string,
  uri: string | null,
): Promise<User> {
  const user = await load(userId);
  user.photoUrl = uri;
  await user.save();
  return toUser(user);
}

/**
 * Applies for the optional verified badge.
 *
 * One badge, reviewed by a person. There is no second tier and no automatic
 * approval — the document is held for an admin to look at, and the status
 * moves to "pending" so the UI can say so.
 */
export async function requestBadge(
  userId: string,
  documentUri: string,
): Promise<User> {
  const user = await load(userId, true);

  if (user.badgeStatus === "approved") {
    throw new BusinessRuleError("Your badge is already approved.");
  }
  if (user.badgeStatus === "pending") {
    // Not an error worth failing on, but re-submitting should not reset the
    // queue position or overwrite a document an admin is mid-review on.
    throw new BusinessRuleError("Your badge request is already being reviewed.");
  }

  user.badgeStatus = "pending";
  user.badgeDocumentUrl = documentUri;
  user.badgeRequestedAt = new Date();
  await user.save();

  logger.info({ userId }, "badge requested");
  return toUser(user);
}

/**
 * Adds a second institution, for people who genuinely belong to two.
 *
 * It does NOT change the primary institution, which is what matching uses.
 * Letting this move somebody between communities would be a way to walk into
 * another institution's member list without an email from that institution.
 */
export async function addInstitution(
  userId: string,
  institutionId: string,
): Promise<User> {
  const user = await load(userId);

  const institution = await InstitutionModel.findOne({
    _id: institutionId,
    active: true,
  });
  if (!institution) {
    throw new UnprocessableError("That institution is not available yet.");
  }

  if (institution._id.equals(user.institutionId)) {
    throw new BusinessRuleError("That is already your institution.");
  }

  const already = user.additionalInstitutionIds.some((id) =>
    id.equals(institution._id),
  );
  if (!already) {
    user.additionalInstitutionIds.push(institution._id);
    await user.save();
  }

  return toUser(user);
}

export async function removeInstitution(
  userId: string,
  institutionId: string,
): Promise<User> {
  const user = await load(userId);
  const target = new Types.ObjectId(institutionId);

  if (target.equals(user.institutionId)) {
    // Removing the primary would leave an account with no community, no
    // matching, and no way back in without an admin.
    throw new BusinessRuleError(
      "You cannot remove the institution your account belongs to.",
    );
  }

  const before = user.additionalInstitutionIds.length;
  user.additionalInstitutionIds = user.additionalInstitutionIds.filter(
    (id) => !id.equals(target),
  );

  if (user.additionalInstitutionIds.length === before) {
    throw new NotFoundError("That institution is not on your account.");
  }

  await user.save();
  return toUser(user);
}
