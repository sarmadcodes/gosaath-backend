import { Types } from "mongoose";
import { logger } from "../../utils/logger.js";
import {
  AuthenticationError,
  BusinessRuleError,
  NotFoundError,
  UnprocessableError,
} from "../../utils/errors.js";
import { randomUUID } from "node:crypto";
import {
  AreaMatchModel,
  AreaModel,
  AttendanceModel,
  CommuteModel,
  InstitutionModel,
  NotificationModel,
  PreferencesModel,
  PushTokenModel,
  RideInstanceModel,
  SeatRequestModel,
  SessionModel,
  UserModel,
  VehicleModel,
} from "../../db/models/index.js";
import { hashPassword, verifyPassword } from "../../utils/crypto.js";
import { cancelFutureInstances } from "../commutes/instance.service.js";
import { confirmUploaded, keyBelongsTo, removeFile } from "../../services/storage/index.js";
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

/**
 * Sets, replaces or clears the profile photo.
 *
 * Takes the key of a file the person has already uploaded, not a URL and not
 * the bytes. The key is checked against their own id — a key belonging to
 * somebody else is refused however it was obtained — and the file is checked
 * to have actually arrived, so nobody ends up with a photo that is a broken
 * image nobody can explain.
 */
export async function setPhoto(
  userId: string,
  key: string | null,
): Promise<User> {
  const user = await load(userId);

  if (key !== null) {
    if (!keyBelongsTo(key, "photo", userId)) {
      throw new UnprocessableError("That upload does not belong to this account.");
    }
    await confirmUploaded(key, "photo");
  }

  // The old one goes: nobody is served it any more, and a bucket that only
  // ever grows is a bill that only ever grows.
  const previous = user.photoUrl;
  user.photoUrl = key;
  await user.save();
  if (previous && previous !== key) await removeFile(previous);

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
  documentKey: string,
): Promise<User> {
  const user = await load(userId, true);

  // Their own upload, and one that arrived. An admin opening a review to find
  // nothing there is worse than the upload having failed loudly.
  if (!keyBelongsTo(documentKey, "badge", userId)) {
    throw new UnprocessableError("That upload does not belong to this account.");
  }
  await confirmUploaded(documentKey, "badge");

  if (user.badgeStatus === "approved") {
    throw new BusinessRuleError("Your badge is already approved.");
  }
  if (user.badgeStatus === "pending") {
    // Not an error worth failing on, but re-submitting should not reset the
    // queue position or overwrite a document an admin is mid-review on.
    throw new BusinessRuleError("Your badge request is already being reviewed.");
  }

  const previousDocument = user.badgeDocumentUrl;
  user.badgeStatus = "pending";
  user.badgeDocumentUrl = documentKey;
  user.badgeRequestedAt = new Date();
  await user.save();

  if (previousDocument && previousDocument !== documentKey) {
    // A rejected application's document has served its purpose. Keeping a
    // student card longer than the review that needed it is not ours to do.
    await removeFile(previousDocument);
  }

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

/**
 * Closes an account for good.
 *
 * SYSTEM.md 4.5.8: "Delete account anonymises reports (safety history
 * survives) but removes name, photo, phone, email, documents."
 *
 * So this is not a hard delete. Reports, blocks and audit entries point at a
 * user id; deleting the row would either break them or erase a safety record,
 * and erasing the record would make deleting your account the way to undo
 * what you did. The row stays, emptied of everything that identifies a person,
 * and locked out through the same check that locks out a suspension.
 *
 * What goes with it matters just as much as the personal fields: the commute
 * stops, future rides are cancelled so their passengers stop planning around
 * them, seats held on other people's rides are given back, and every session
 * and push token is dropped so the phone in someone's hand stops being a way
 * in and stops receiving notifications for an account that no longer exists.
 */
export async function deleteAccount(
  userId: string,
  password: string,
): Promise<void> {
  const user = await UserModel.findById(userId).select("+passwordHash");
  if (!user) throw new NotFoundError("That account was not found.");
  if (user.deletedAt) return;

  // Asked for again because this cannot be undone: an unlocked phone left on
  // a table should not be enough to close somebody's account.
  const ok = await verifyPassword(user.passwordHash, password);
  if (!ok) throw new AuthenticationError("That password is not right.");

  const now = new Date();

  // Their own commutes stop, and the rides they were driving are cancelled
  // rather than left for passengers to turn up to.
  const commutes = await CommuteModel.find({ ownerId: user._id }).select("_id").lean();
  for (const commute of commutes) {
    await cancelFutureInstances(commute._id, "commuteCancelled");
  }
  await CommuteModel.updateMany(
    { ownerId: user._id },
    { $set: { status: "cancelled" } },
  );

  // Seats they held on other people's rides go back, so somebody else can
  // have them rather than the ride running with a phantom passenger.
  const held = await AttendanceModel.find({
    userId: user._id,
    role: "passenger",
    status: { $in: ["confirmed", "pending"] },
  })
    .select("rideInstanceId")
    .lean();

  for (const row of held) {
    await RideInstanceModel.updateOne(
      { _id: row.rideInstanceId, seatsTaken: { $gt: 0 } },
      { $inc: { seatsTaken: -1 } },
    );
  }
  await AttendanceModel.deleteMany({ userId: user._id });
  await SeatRequestModel.updateMany(
    { requesterId: user._id, status: "pending" },
    { $set: { status: "cancelled", respondedAt: now } },
  );

  await Promise.all([
    SessionModel.deleteMany({ userId: user._id }),
    PushTokenModel.deleteMany({ userId: user._id }),
    VehicleModel.deleteMany({ ownerId: user._id }),
    NotificationModel.deleteMany({ userId: user._id }),
    PreferencesModel.deleteMany({ userId: user._id }),
    AreaMatchModel.deleteMany({
      $or: [{ userId: user._id }, { matchedUserId: user._id }],
    }),
  ]);

  // Blocks are deliberately kept. They are a safety decision somebody else
  // made, and they are silent — restoring contact by deleting an account
  // would hand exactly the wrong person a way around being blocked.

  // The files go too. "Removes name, photo, phone, email, documents" is not
  // satisfied by forgetting where a student card is while it sits in a bucket.
  await Promise.all([removeFile(user.photoUrl), removeFile(user.badgeDocumentUrl)]);

  user.name = "Former member";
  user.email = `deleted+${user._id.toString()}@gosaath.invalid`;
  // A marker rather than an empty string: `phone` is required, and a schema
  // that guarantees every member has a number is worth more than the small
  // satisfaction of storing nothing at all. It is not a dialable number.
  user.phone = "removed";
  user.photoUrl = null;
  user.badgeDocumentUrl = null;
  user.badgeStatus = "none";
  user.passwordHash = await hashPassword(randomUUID());
  user.deletedAt = now;
  // The existing lockout: login, refresh and restore all refuse a suspended
  // account, so this needs no new check anywhere.
  user.suspendedAt = now;
  user.suspendedReason = "Account deleted by the member.";
  await user.save();

  logger.info({ userId }, "account deleted");
}
