import type { FastifyRequest } from "fastify";
import mongoose, { Types } from "mongoose";
import { env } from "../../config/env.js";
import { logger } from "../../utils/logger.js";
import {
  AuthenticationError,
  BusinessRuleError,
  ConflictError,
  NotFoundError,
  UnprocessableError,
} from "../../utils/errors.js";
import { escapeRegExp } from "../../utils/text.js";
import { generateRefreshToken, hashPassword, hashToken, verifyPassword } from "../../utils/crypto.js";
import {
  AdminInvitationModel,
  CampusModel,
  CommuteModel,
  ConfigurationModel,
  InstitutionModel,
  InstitutionRequestModel,
  ReportModel,
  UserModel,
} from "../../db/models/index.js";
import type { AdminContext } from "../../middleware/admin.js";
import { recordAudit } from "../audit/audit.service.js";
import { revokeAllSessions } from "../auth/token.service.js";
import { emailService } from "../../services/email/index.js";
import { toUser } from "../users/user.mapper.js";
import { createSession } from "../auth/token.service.js";
import type { AuthSession } from "../../contract/api.js";

/**
 * The Super Admin surface: institutions, activation, requests and admins.
 *
 * Every route that reaches this runs `requireSuperAdmin`. Destructive actions
 * additionally require the admin's password again — the platform role is the
 * highest privilege there is, and a stolen session should not be enough on
 * its own to switch off an institution or remove the people who could fix it.
 */

type Ctx = { admin: AdminContext; request?: FastifyRequest };

const INVITATION_TTL_HOURS = 72;

const audit = (ctx: Ctx) => ({
  actor: ctx.admin,
  ...(ctx.request ? { request: ctx.request } : {}),
});

/**
 * Re-authentication for destructive actions.
 *
 * Same error whatever went wrong, and it counts as a failed attempt in the
 * log, so this cannot be used as a quiet password oracle.
 */
export async function confirmPassword(userId: string, password: string): Promise<void> {
  const user = await UserModel.findById(userId).select("+passwordHash").lean();
  if (!user || !(await verifyPassword(user.passwordHash, password))) {
    logger.warn({ userId }, "re-authentication failed");
    throw new AuthenticationError("That password is not right.");
  }
}

// ---------------------------------------------------------------------------
// Institutions and the activation checklist
// ---------------------------------------------------------------------------

type ChecklistItem = {
  key: string;
  label: string;
  done: boolean;
  required: boolean;
  /** Derived from the database, or ticked by a person. */
  source: "derived" | "manual";
};

/**
 * The activation checklist, as it actually stands.
 *
 * Anything the database can answer is answered by the database. A tick-box
 * saying "logos uploaded" is a claim; two logo URLs on the record are a fact.
 * Only the human judgements — was the institution contacted, did their IT
 * confirm the domains, is the colour sampled from the real logo — are manual.
 *
 * Two items in the original plan could never be satisfied before launch,
 * because registration refuses inactive institutions:
 *
 *   - "a named admin" is met through an admin invitation, which is the one
 *     path allowed to register into an inactive institution;
 *   - "enough signups" cannot be signups at all, so it is the number of
 *     people who asked for this institution, and it is ADVISORY — shown, not
 *     enforced. Blocking on it would make activation impossible.
 */
async function checklistFor(institution: {
  _id: Types.ObjectId;
  name: string;
  emailDomains: string[];
  logoMarkUrl?: string | null;
  logoWideUrl?: string | null;
  activation?: {
    contacted?: boolean | null;
    campusesConfirmed?: boolean | null;
    emailDomainsConfirmed?: boolean | null;
    brandColorConfirmed?: boolean | null;
  } | null;
}): Promise<{ items: ChecklistItem[]; interest: number; ready: boolean }> {
  const manual = institution.activation ?? {};

  const [activeCampuses, admins, pendingInvites, interest] = await Promise.all([
    CampusModel.countDocuments({ institutionId: institution._id, active: true }),
    UserModel.countDocuments({ institutionId: institution._id, role: "universityAdmin" }),
    AdminInvitationModel.countDocuments({
      institutionId: institution._id,
      role: "universityAdmin",
      acceptedAt: null,
      revokedAt: null,
      expiresAt: { $gt: new Date() },
    }),
    InstitutionRequestModel.countDocuments({
      name: new RegExp(`^${escapeRegExp(institution.name.trim())}$`, "i"),
    }),
  ]);

  const items: ChecklistItem[] = [
    { key: "contacted", label: "Contacted and agreed to launch", done: Boolean(manual.contacted), required: true, source: "manual" },
    {
      key: "campusesConfirmed",
      label: "Real campus list confirmed",
      done: Boolean(manual.campusesConfirmed) && activeCampuses > 0,
      required: true,
      source: "manual",
    },
    {
      key: "emailDomainsConfirmed",
      label: "Email domains confirmed with their IT department",
      done: Boolean(manual.emailDomainsConfirmed) && institution.emailDomains.length > 0,
      required: true,
      source: "manual",
    },
    { key: "brandColorConfirmed", label: "Brand colour sampled from the official logo", done: Boolean(manual.brandColorConfirmed), required: true, source: "manual" },
    {
      key: "logosUploaded",
      label: "Mark and wide logos uploaded",
      done: Boolean(institution.logoMarkUrl && institution.logoWideUrl),
      required: true,
      source: "derived",
    },
    {
      key: "adminAssigned",
      label: pendingInvites > 0 && admins === 0 ? "An admin is invited but has not accepted yet" : "A named admin who will review badges",
      done: admins > 0,
      required: true,
      source: "derived",
    },
    {
      key: "interest",
      label: `${interest} ${interest === 1 ? "person has" : "people have"} asked for this institution`,
      done: interest >= 10,
      required: false,
      source: "derived",
    },
  ];

  return { items, interest, ready: items.filter((i) => i.required).every((i) => i.done) };
}

async function toInstitutionRow(institution: Awaited<ReturnType<typeof InstitutionModel.findOne>> & object) {
  const doc = institution as unknown as {
    _id: Types.ObjectId;
    name: string;
    shortName?: string | null;
    type: string;
    city: string;
    active: boolean;
    brandColor: string;
    emailDomains: string[];
    logoMarkUrl?: string | null;
    logoWideUrl?: string | null;
    activation?: Record<string, unknown> | null;
  };
  const [members, campuses, commutes, checklist] = await Promise.all([
    UserModel.countDocuments({ institutionId: doc._id, emailVerifiedAt: { $ne: null } }),
    CampusModel.countDocuments({ institutionId: doc._id }),
    CommuteModel.countDocuments({ institutionId: doc._id, status: "active" }),
    checklistFor(doc as Parameters<typeof checklistFor>[0]),
  ]);

  return {
    id: doc._id.toString(),
    name: doc.name,
    shortName: doc.shortName ?? null,
    type: doc.type,
    city: doc.city,
    active: doc.active,
    // "Onboarding" is inactive with at least one thing done; a fresh row with
    // nothing ticked is simply inactive.
    status: doc.active
      ? "active"
      : checklist.items.some((i) => i.required && i.done)
        ? "onboarding"
        : "inactive",
    brandColor: doc.brandColor,
    emailDomains: doc.emailDomains,
    members,
    campuses,
    activeCommutes: commutes,
    checklist: checklist.items,
    readyToActivate: checklist.ready,
  };
}

export async function listInstitutions(filters: { status?: "active" | "inactive" | undefined; q?: string | undefined }) {
  const query: Record<string, unknown> = {};
  if (filters.status) query["active"] = filters.status === "active";
  if (filters.q) query["name"] = new RegExp(escapeRegExp(filters.q), "i");

  const rows = await InstitutionModel.find(query).sort({ active: -1, name: 1 }).limit(200);
  return Promise.all(rows.map((row) => toInstitutionRow(row)));
}

export async function getInstitution(institutionId: string) {
  const row = await InstitutionModel.findById(institutionId);
  if (!row) throw new NotFoundError("Not found.");
  return toInstitutionRow(row);
}

/**
 * Creates an institution — always inactive.
 *
 * There is no way to create one live. Karachi only, for now. Organisations
 * are refused while the feature flag is off: the schema supports them so the
 * later launch needs no migration, but the product is not ready for them.
 */
export async function createInstitution(
  ctx: Ctx,
  input: {
    name: string;
    shortName?: string | undefined;
    type: "university" | "college" | "school" | "organisation";
    city: string;
    emailDomains: string[];
    brandColor: string;
  },
) {
  if (input.city.trim().toLowerCase() !== "karachi") {
    throw new UnprocessableError("GoSaath is Karachi only for now.");
  }

  if (input.type === "organisation") {
    const flag = await ConfigurationModel.findOne({ key: "FEATURE_ORGANISATIONS" }).lean();
    if (flag?.value !== true) {
      throw new UnprocessableError("Organisations are not open yet.");
    }
  }

  const clash = await InstitutionModel.exists({
    name: new RegExp(`^${escapeRegExp(input.name.trim())}$`, "i"),
  });
  if (clash) throw new ConflictError("An institution with that name already exists.");

  const created = await InstitutionModel.create({
    name: input.name.trim(),
    shortName: input.shortName,
    type: input.type,
    city: "Karachi",
    emailDomains: input.emailDomains,
    brandColor: input.brandColor,
    active: false,
  });

  await recordAudit({
    ...audit(ctx),
    action: "institution.created",
    targetType: "institution",
    targetId: created._id.toString(),
    institutionId: created._id,
    metadata: { name: created.name, type: created.type },
  });

  return toInstitutionRow(created);
}

/** Ticks or unticks the human judgements. The derived items cannot be set. */
export async function updateChecklist(
  ctx: Ctx,
  institutionId: string,
  patch: Partial<Record<"contacted" | "campusesConfirmed" | "emailDomainsConfirmed" | "brandColorConfirmed", boolean>>,
) {
  const institution = await InstitutionModel.findById(institutionId);
  if (!institution) throw new NotFoundError("Not found.");

  const set: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (typeof value === "boolean") set[`activation.${key}`] = value;
  }
  await InstitutionModel.updateOne({ _id: institution._id }, { $set: set });

  await recordAudit({
    ...audit(ctx),
    action: "institution.updated",
    targetType: "institution",
    targetId: institution._id.toString(),
    institutionId: institution._id,
    metadata: { checklist: patch },
  });

  return getInstitution(institutionId);
}

/**
 * Activates an institution, if and only if the checklist says it is ready.
 *
 * Guarded on `active: false` in the same update, so two admins activating at
 * once record one activation, not two.
 */
export async function activateInstitution(ctx: Ctx, institutionId: string) {
  const institution = await InstitutionModel.findById(institutionId);
  if (!institution) throw new NotFoundError("Not found.");
  if (institution.active) throw new ConflictError("That institution is already live.");

  const checklist = await checklistFor(institution);
  if (!checklist.ready) {
    const missing = checklist.items.filter((i) => i.required && !i.done);
    throw new BusinessRuleError(
      `Not ready to go live: ${missing.map((i) => i.label.toLowerCase()).join("; ")}.`,
      { missingItems: missing.length },
    );
  }

  const updated = await InstitutionModel.findOneAndUpdate(
    { _id: institution._id, active: false },
    {
      $set: {
        active: true,
        "activation.activatedAt": new Date(),
        "activation.activatedBy": new Types.ObjectId(ctx.admin.userId),
      },
    },
    { new: true },
  );
  if (!updated) throw new ConflictError("That institution is already live.");

  await recordAudit({
    ...audit(ctx),
    action: "institution.activated",
    targetType: "institution",
    targetId: institution._id.toString(),
    institutionId: institution._id,
    metadata: { interest: checklist.interest },
  });

  return toInstitutionRow(updated);
}

/**
 * Takes an institution offline. Requires the admin's password again.
 *
 * Existing accounts are kept: nobody's data disappears because a launch was
 * paused. New registrations stop, and the institution leaves the picker.
 */
export async function deactivateInstitution(ctx: Ctx, institutionId: string, password: string, reason: string) {
  await confirmPassword(ctx.admin.userId, password);

  const updated = await InstitutionModel.findOneAndUpdate(
    { _id: institutionId, active: true },
    { $set: { active: false } },
    { new: true },
  );
  if (!updated) {
    if (!(await InstitutionModel.exists({ _id: institutionId }))) throw new NotFoundError("Not found.");
    throw new ConflictError("That institution is not live.");
  }

  await recordAudit({
    ...audit(ctx),
    action: "institution.deactivated",
    targetType: "institution",
    targetId: institutionId,
    institutionId,
    metadata: { reason },
  });

  return toInstitutionRow(updated);
}

// ---------------------------------------------------------------------------
// Institution requests
// ---------------------------------------------------------------------------

/**
 * The request queue, grouped by name.
 *
 * Grouped because the count is the signal: ten students asking for the same
 * campus is the roadmap, and ten separate rows hide it.
 */
export async function listInstitutionRequests(status: "pending" | "approved" | "rejected" = "pending") {
  const groups = await InstitutionRequestModel.aggregate<{
    _id: string;
    count: number;
    type: string;
    firstAt: Date;
    lastAt: Date;
    ids: Types.ObjectId[];
    campuses: string[];
  }>([
    { $match: { status } },
    {
      $group: {
        _id: { $toLower: { $trim: { input: "$name" } } },
        count: { $sum: 1 },
        type: { $first: "$type" },
        firstAt: { $min: "$createdAt" },
        lastAt: { $max: "$createdAt" },
        ids: { $push: "$_id" },
        campuses: { $addToSet: "$campusName" },
        name: { $first: "$name" },
      },
    },
    { $sort: { count: -1, lastAt: -1 } },
    { $limit: 200 },
  ]);

  // Requester emails are not returned: the queue is about demand, and the
  // people who asked did not ask to be contacted by us from it.
  return groups.map((g) => ({
    name: (g as unknown as { name: string }).name,
    type: g.type,
    requests: g.count,
    campuses: g.campuses.filter(Boolean),
    firstRequestedAt: g.firstAt.toISOString(),
    lastRequestedAt: g.lastAt.toISOString(),
    requestIds: g.ids.map((id) => id.toString()),
  }));
}

/**
 * Marks every request for one name approved or rejected.
 *
 * Approving does NOT create an institution. That stays a separate, explicit
 * step with its own checklist — a request becoming a live institution by a
 * status flip is exactly what this design exists to prevent.
 */
export async function decideInstitutionRequests(ctx: Ctx, name: string, approve: boolean) {
  const result = await InstitutionRequestModel.updateMany(
    { name: new RegExp(`^${escapeRegExp(name.trim())}$`, "i"), status: "pending" },
    {
      $set: {
        status: approve ? "approved" : "rejected",
        reviewedBy: new Types.ObjectId(ctx.admin.userId),
        reviewedAt: new Date(),
      },
    },
  );
  if (result.matchedCount === 0) throw new NotFoundError("No pending requests for that name.");

  await recordAudit({
    ...audit(ctx),
    action: "institution.updated",
    targetType: "institutionRequest",
    targetId: null,
    metadata: { name, approve, requests: result.modifiedCount },
  });

  return { name, decided: result.modifiedCount, status: approve ? "approved" : "rejected" };
}

// ---------------------------------------------------------------------------
// Administrators
// ---------------------------------------------------------------------------

export async function listAdmins() {
  const admins = await UserModel.find({ role: { $in: ["universityAdmin", "superAdmin"] } })
    .select("name email role institutionId suspendedAt createdAt")
    .sort({ role: -1, name: 1 })
    .lean();
  const institutions = await InstitutionModel.find({ _id: { $in: admins.map((a) => a.institutionId) } })
    .select("name")
    .lean();
  const nameOf = new Map(institutions.map((i) => [i._id.toString(), i.name]));

  const invitations = await AdminInvitationModel.find({
    acceptedAt: null,
    revokedAt: null,
    expiresAt: { $gt: new Date() },
  })
    .sort({ createdAt: -1 })
    .lean();
  const inviteInstitutions = await InstitutionModel.find({ _id: { $in: invitations.map((i) => i.institutionId) } })
    .select("name")
    .lean();
  for (const i of inviteInstitutions) nameOf.set(i._id.toString(), i.name);

  return {
    admins: admins.map((a) => ({
      id: a._id.toString(),
      name: a.name,
      email: a.email,
      role: a.role,
      institutionId: a.institutionId.toString(),
      institutionName: nameOf.get(a.institutionId.toString()) ?? "",
      suspended: Boolean(a.suspendedAt),
    })),
    pendingInvitations: invitations.map((i) => ({
      id: i._id.toString(),
      email: i.email,
      role: i.role,
      institutionId: i.institutionId.toString(),
      institutionName: nameOf.get(i.institutionId.toString()) ?? "",
      expiresAt: i.expiresAt.toISOString(),
    })),
  };
}

/**
 * Invites somebody to administer.
 *
 * The address must belong to the institution's own domains, even for a super
 * admin: every account belongs to an institution, and an admin with an
 * address the institution does not recognise is an admin nobody can vouch for.
 */
export async function inviteAdmin(
  ctx: Ctx,
  input: { email: string; institutionId: string; role: "universityAdmin" | "superAdmin" },
) {
  const institution = await InstitutionModel.findById(input.institutionId).lean();
  if (!institution) throw new NotFoundError("Not found.");

  const email = input.email.trim().toLowerCase();
  const domain = email.split("@")[1] ?? "";
  if (!institution.emailDomains.includes(domain)) {
    throw new UnprocessableError(`Invite an address on ${institution.emailDomains.join(" or ") || "the institution's domain"}.`);
  }

  const existing = await UserModel.findOne({ email }).select("role institutionId").lean();
  if (existing && (existing.role ?? "member") === input.role) {
    throw new ConflictError("That person already has this role.");
  }
  if (existing && !existing.institutionId.equals(institution._id)) {
    throw new UnprocessableError("That account belongs to a different institution.");
  }

  // One live invitation per address and role; a new one replaces the old,
  // so an earlier link cannot be used after a re-send.
  await AdminInvitationModel.updateMany(
    { email, acceptedAt: null, revokedAt: null },
    { $set: { revokedAt: new Date() } },
  );

  const token = generateRefreshToken();
  const invitation = await AdminInvitationModel.create({
    email,
    institutionId: institution._id,
    role: input.role,
    tokenHash: hashToken(token),
    invitedBy: new Types.ObjectId(ctx.admin.userId),
    expiresAt: new Date(Date.now() + INVITATION_TTL_HOURS * 60 * 60 * 1000),
  });

  await recordAudit({
    ...audit(ctx),
    action: "admin.invited",
    targetType: "adminInvitation",
    targetId: invitation._id.toString(),
    institutionId: institution._id,
    metadata: { email, role: input.role },
  });

  // Awaited: an invitation nobody receives is not an invitation. The token is
  // never returned in the response — only the invited inbox gets it.
  await emailService().sendAdminInvitation({
    to: email,
    institutionName: institution.name,
    role: input.role,
    acceptUrl: `${env.ADMIN_PANEL_URL}/invitations/accept?token=${encodeURIComponent(token)}`,
    expiresInHours: INVITATION_TTL_HOURS,
  });

  return { id: invitation._id.toString(), email, role: input.role, expiresAt: invitation.expiresAt.toISOString() };
}

export async function revokeInvitation(ctx: Ctx, invitationId: string) {
  const updated = await AdminInvitationModel.findOneAndUpdate(
    { _id: invitationId, acceptedAt: null, revokedAt: null },
    { $set: { revokedAt: new Date() } },
    { new: true },
  ).lean();
  if (!updated) throw new NotFoundError("Not found.");

  await recordAudit({
    ...audit(ctx),
    action: "admin.removed",
    targetType: "adminInvitation",
    targetId: invitationId,
    institutionId: updated.institutionId,
    metadata: { email: updated.email, revoked: true },
  });
}

/**
 * Removes an administrator's role. Requires the admin's password again.
 *
 * The account survives as an ordinary member: losing admin rights should not
 * cost somebody their commute. Two guard rails — nobody removes themselves,
 * and the last super admin cannot be removed, or the platform would have
 * nobody left who can appoint another.
 */
export async function removeAdmin(ctx: Ctx, userId: string, password: string) {
  await confirmPassword(ctx.admin.userId, password);

  if (userId === ctx.admin.userId) {
    throw new UnprocessableError("You cannot remove your own role.");
  }

  const target = await UserModel.findById(userId).select("role institutionId").lean();
  if (!target || (target.role ?? "member") === "member") throw new NotFoundError("Not found.");

  if (target.role === "superAdmin") {
    await demoteSuperAdmin(target._id);
  } else {
    await UserModel.updateOne({ _id: target._id }, { $set: { role: "member" } });
  }
  // Their admin sessions end now. The admin middleware already reads the role
  // from the database, but signing them out removes any doubt.
  await revokeAllSessions(target._id, "admin");

  await recordAudit({
    ...audit(ctx),
    action: "admin.removed",
    targetType: "user",
    targetId: userId,
    institutionId: target.institutionId,
    metadata: { previousRole: target.role },
  });
}

/**
 * Demotes a super admin without ever leaving the platform with none.
 *
 * The obvious version — count the others, then demote — is read-then-write.
 * Two super admins removing each other at the same instant would each count
 * the other as remaining, both pass, and the platform would be left with
 * nobody who can appoint anyone.
 *
 * So both halves run in one transaction that first writes a shared lock
 * document. Two such transactions always conflict on that write; MongoDB
 * aborts one, `withTransaction` retries it, and the retry counts again —
 * now seeing the first removal — and refuses.
 */
async function demoteSuperAdmin(targetId: Types.ObjectId): Promise<void> {
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      await ConfigurationModel.updateOne(
        { key: "lock:superAdmins" },
        { $inc: { value: 1 }, $setOnInsert: { description: "Serialises super admin removal." } },
        { upsert: true, session },
      );

      const others = await UserModel.countDocuments(
        { role: "superAdmin", _id: { $ne: targetId }, suspendedAt: null },
        { session },
      );
      if (others === 0) {
        throw new BusinessRuleError("The last platform administrator cannot be removed.");
      }

      await UserModel.updateOne({ _id: targetId }, { $set: { role: "member" } }, { session });
    });
  } finally {
    await session.endSession();
  }
}

async function liveInvitation(token: string) {
  const invitation = await AdminInvitationModel.findOne({
    tokenHash: hashToken(token),
    acceptedAt: null,
    revokedAt: null,
    expiresAt: { $gt: new Date() },
  }).lean();
  // One message for missing, used, revoked and expired: a token that does not
  // work should say nothing about which of those it is.
  if (!invitation) throw new NotFoundError("That invitation is not valid. Ask for a new one.");
  return invitation;
}

/** Claims an invitation atomically, so it can be used exactly once. */
async function claim(invitationId: Types.ObjectId, userId: Types.ObjectId) {
  const claimed = await AdminInvitationModel.findOneAndUpdate(
    { _id: invitationId, acceptedAt: null, revokedAt: null, expiresAt: { $gt: new Date() } },
    { $set: { acceptedAt: new Date(), acceptedBy: userId } },
    { new: true },
  ).lean();
  if (!claimed) throw new NotFoundError("That invitation is not valid. Ask for a new one.");
}

/**
 * Accepts an invitation into an existing, signed-in account.
 *
 * The account's address must be the invited one. Holding the link is not
 * enough on its own; it has to be the person it was sent to.
 */
export async function acceptInvitation(userId: string, token: string) {
  const invitation = await liveInvitation(token);
  const user = await UserModel.findById(userId).select("email institutionId role").lean();
  if (!user) throw new AuthenticationError();

  if (user.email !== invitation.email) {
    throw new NotFoundError("That invitation is not valid. Ask for a new one.");
  }
  if (!user.institutionId.equals(invitation.institutionId)) {
    throw new UnprocessableError("That invitation is for a different institution.");
  }

  await claim(invitation._id, user._id);
  await UserModel.updateOne({ _id: user._id }, { $set: { role: invitation.role } });

  logger.info({ userId, role: invitation.role }, "admin invitation accepted");
  return { role: invitation.role, institutionId: invitation.institutionId.toString() };
}

/**
 * Registers a new account from an invitation.
 *
 * The one path allowed into an institution that is not yet live — which is
 * what lets an institution have its admin in place BEFORE activation. The
 * emailed token proves ownership of the address, so no separate code is
 * needed. The campus must belong to the invited institution.
 */
export async function registerFromInvitation(
  input: {
    token: string;
    name: string;
    password: string;
    phone: string;
    campusId: string;
    areaId: string;
    userType: "student" | "teacher";
  },
  context: { userAgent?: string | undefined; ip?: string | undefined },
): Promise<AuthSession> {
  const invitation = await liveInvitation(input.token);

  if (await UserModel.exists({ email: invitation.email })) {
    // Safe to say: whoever holds the token already controls this inbox.
    throw new ConflictError("An account with this address exists. Sign in and accept the invitation there.");
  }

  const campus = await CampusModel.findOne({ _id: input.campusId, institutionId: invitation.institutionId }).lean();
  if (!campus) throw new UnprocessableError("That campus is not part of this institution.");

  const user = await UserModel.create({
    name: input.name,
    email: invitation.email,
    passwordHash: await hashPassword(input.password),
    phone: input.phone,
    userType: input.userType,
    institutionId: invitation.institutionId,
    campusId: campus._id,
    areaId: new Types.ObjectId(input.areaId),
    role: invitation.role,
    badgeStatus: "none",
    emailVerifiedAt: new Date(),
  });

  try {
    await claim(invitation._id, user._id);
  } catch (error) {
    // Lost a race for the same token: undo the account rather than leave an
    // admin whose invitation somebody else consumed.
    await UserModel.deleteOne({ _id: user._id });
    throw error;
  }

  const issued = await createSession({ userId: user._id, userAgent: context.userAgent, ip: context.ip });
  return { token: issued.refreshToken, user: toUser(user) };
}

// ---------------------------------------------------------------------------
// Platform overview
// ---------------------------------------------------------------------------

export async function platformOverview() {
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const [institutions, liveInstitutions, members, newMembers, activeCommutes, escalated, pendingRequests, signupsByInstitution] =
    await Promise.all([
      InstitutionModel.countDocuments({}),
      InstitutionModel.countDocuments({ active: true }),
      UserModel.countDocuments({ emailVerifiedAt: { $ne: null } }),
      UserModel.countDocuments({ emailVerifiedAt: { $ne: null }, createdAt: { $gte: weekAgo } }),
      CommuteModel.countDocuments({ status: "active" }),
      ReportModel.countDocuments({ status: "escalated" }),
      InstitutionRequestModel.distinct("name", { status: "pending" }),
      UserModel.aggregate<{ _id: Types.ObjectId; count: number }>([
        { $match: { createdAt: { $gte: weekAgo }, emailVerifiedAt: { $ne: null } } },
        { $group: { _id: "$institutionId", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 10 },
      ]),
    ]);

  const names = await InstitutionModel.find({ _id: { $in: signupsByInstitution.map((s) => s._id) } })
    .select("name")
    .lean();
  const nameOf = new Map(names.map((n) => [n._id.toString(), n.name]));

  // Live institutions with no commutes created in the last week: the ones
  // about to churn, and the reason to look at this screen at all.
  const quiet = await InstitutionModel.aggregate<{ name: string }>([
    { $match: { active: true } },
    {
      $lookup: {
        from: "commutes",
        let: { id: "$_id" },
        pipeline: [
          { $match: { $expr: { $and: [{ $eq: ["$institutionId", "$$id"] }, { $gte: ["$createdAt", weekAgo] }] } } },
          { $limit: 1 },
        ],
        as: "recent",
      },
    },
    { $match: { recent: { $size: 0 } } },
    { $project: { name: 1 } },
  ]);

  return {
    institutions,
    liveInstitutions,
    members,
    newMembersThisWeek: newMembers,
    activeCommutes,
    escalatedReports: escalated,
    pendingInstitutionRequests: pendingRequests.length,
    signupsThisWeek: signupsByInstitution.map((s) => ({
      institution: nameOf.get(s._id.toString()) ?? "Unknown",
      count: s.count,
    })),
    quietInstitutions: quiet.map((q) => q.name),
  };
}
