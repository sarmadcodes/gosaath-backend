import { Types } from "mongoose";
import {
  AuthorizationError,
  BusinessRuleError,
  ConflictError,
  NotFoundError,
  UnprocessableError,
} from "../../utils/errors.js";
import { escapeRegExp } from "../../utils/text.js";
import {
  AreaModel,
  CampusModel,
  CommuteModel,
  InstitutionModel,
  ReportModel,
  SeatRequestModel,
  UserModel,
} from "../../db/models/index.js";
import { assertInScope, scopeFilter, type AdminContext } from "../../middleware/admin.js";
import { recordAudit } from "../audit/audit.service.js";
import { revokeAllSessions } from "../auth/token.service.js";
import { emailService } from "../../services/email/index.js";
import { notifyQuietly } from "../notifications/notification.service.js";
import { logger } from "../../utils/logger.js";
import { readUrlFor } from "../../services/storage/index.js";
import type { FastifyRequest } from "fastify";

/**
 * The University Admin surface — also used by Super Admins, across every
 * institution.
 *
 * Every read starts from `scopeFilter(admin.scope)`, spread last. Every single
 * resource is checked with `assertInScope`, which answers 404 for anything
 * outside it. Every change is audited.
 */

type Ctx = { admin: AdminContext; request?: FastifyRequest };

/**
 * An explicit institution filter from the request.
 *
 * Allowed for platform admins, who genuinely choose between institutions. A
 * university admin naming an institution that is not theirs is refused
 * outright rather than silently narrowed: quietly returning their own data
 * would teach them the parameter is respected but unlucky.
 */
function institutionFilter(
  admin: AdminContext,
  requested: string | undefined,
): { institutionId?: Types.ObjectId } {
  if (requested && admin.scope.kind === "institution" && requested !== admin.scope.institutionId) {
    throw new AuthorizationError("You can only manage your own institution.");
  }
  if (admin.scope.kind === "platform") {
    return requested ? { institutionId: new Types.ObjectId(requested) } : {};
  }
  return scopeFilter(admin.scope);
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

export async function overview(ctx: Ctx, institutionId?: string) {
  const scoped = institutionFilter(ctx.admin, institutionId);
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const [members, newMembers, activeCommutes, pendingVerifications, openReports, seatTotals, topAreas, daily] =
    await Promise.all([
      // `deletedAt: null` throughout: somebody who closed their account is
      // not a member, and counting them would quietly overstate the pilot.
      UserModel.countDocuments({ ...scoped, emailVerifiedAt: { $ne: null }, deletedAt: null }),
      UserModel.countDocuments({
        ...scoped,
        emailVerifiedAt: { $ne: null },
        deletedAt: null,
        createdAt: { $gte: weekAgo },
      }),
      CommuteModel.countDocuments({ ...scoped, status: "active" }),
      UserModel.countDocuments({ ...scoped, badgeStatus: "pending", deletedAt: null }),
      ReportModel.countDocuments({ ...scoped, status: { $in: ["open", "escalated"] } }),
      CommuteModel.aggregate<{ offered: number }>([
        { $match: { ...scoped, status: "active" } },
        { $group: { _id: null, offered: { $sum: { $ifNull: ["$seatsOffered", 0] } } } },
      ]),
      // Where members actually commute from — the number most universities do
      // not know about their own students. Area names only; never a person.
      CommuteModel.aggregate<{ _id: Types.ObjectId; count: number }>([
        { $match: { ...scoped, status: "active" } },
        { $group: { _id: "$originAreaId", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 5 },
      ]),
      UserModel.aggregate<{ _id: string; count: number }>([
        { $match: { ...scoped, createdAt: { $gte: weekAgo } } },
        {
          $group: {
            _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt", timezone: "Asia/Karachi" } },
            count: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
      ]),
    ]);

  // Seats taken counts accepted requests, not attendance: attendance also
  // carries drivers, and "taken" here means passengers who joined.
  const scopedInstitution = scoped.institutionId;
  const driverIds = scopedInstitution
    ? (await UserModel.find({ institutionId: scopedInstitution }).select("_id").lean()).map((u) => u._id)
    : null;
  const seatsTaken = await SeatRequestModel.countDocuments({
    status: "accepted",
    ...(driverIds ? { driverId: { $in: driverIds } } : {}),
  });

  const areas = await AreaModel.find({ _id: { $in: topAreas.map((a) => a._id) } }).select("name").lean();
  const areaName = new Map(areas.map((a) => [a._id.toString(), a.name]));

  return {
    members,
    newMembersThisWeek: newMembers,
    activeCommutes,
    seatsOffered: seatTotals[0]?.offered ?? 0,
    seatsTaken,
    pendingVerifications,
    openReports,
    topAreas: topAreas.map((a) => ({ area: areaName.get(a._id.toString()) ?? "Unknown", commuters: a.count })),
    signupsLast7Days: daily.map((d) => ({ date: d._id, count: d.count })),
  };
}

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------

export type MemberRow = {
  id: string;
  name: string;
  email: string;
  userType: string;
  institutionId: string;
  campusName: string;
  areaName: string;
  badgeStatus: string;
  role: string;
  hasCommute: boolean;
  suspended: boolean;
  joinedAt: string;
};

export type MemberFilters = {
  institutionId?: string | undefined;
  campusId?: string | undefined;
  userType?: "student" | "teacher" | undefined;
  badgeStatus?: "none" | "pending" | "approved" | "rejected" | undefined;
  suspended?: boolean | undefined;
  q?: string | undefined;
  before?: string | undefined;
  limit: number;
};

function memberQuery(ctx: Ctx, filters: MemberFilters): Record<string, unknown> {
  // Built field by field from validated values. Never `find(req.query)`.
  // Deleted accounts keep their row so reports and audit entries still point
  // somewhere, but they are not members any more and must not appear in a
  // list an admin acts on — there is nobody there to suspend or verify.
  const query: Record<string, unknown> = {
    emailVerifiedAt: { $ne: null },
    deletedAt: null,
  };
  if (filters.campusId) query["campusId"] = new Types.ObjectId(filters.campusId);
  if (filters.userType) query["userType"] = filters.userType;
  if (filters.badgeStatus) query["badgeStatus"] = filters.badgeStatus;
  if (filters.suspended !== undefined) {
    query["suspendedAt"] = filters.suspended ? { $ne: null } : null;
  }
  if (filters.q) {
    const safe = new RegExp(escapeRegExp(filters.q), "i");
    query["$or"] = [{ name: safe }, { email: safe }];
  }
  // Scope last: nothing above can widen it.
  return { ...query, ...institutionFilter(ctx.admin, filters.institutionId) };
}

async function toMemberRows(users: Array<Record<string, unknown>>): Promise<MemberRow[]> {
  const ids = users.map((u) => u["_id"] as Types.ObjectId);
  const [campuses, areas, commutes] = await Promise.all([
    CampusModel.find({ _id: { $in: users.map((u) => u["campusId"]) } }).select("name").lean(),
    AreaModel.find({ _id: { $in: users.map((u) => u["areaId"]) } }).select("name").lean(),
    CommuteModel.find({ ownerId: { $in: ids }, status: "active" }).select("ownerId").lean(),
  ]);
  const campusName = new Map(campuses.map((c) => [c._id.toString(), c.name]));
  const areaName = new Map(areas.map((a) => [a._id.toString(), a.name]));
  const commuting = new Set(commutes.map((c) => c.ownerId.toString()));

  return users.map((u) => ({
    id: String(u["_id"]),
    name: String(u["name"]),
    email: String(u["email"]),
    userType: String(u["userType"]),
    institutionId: String(u["institutionId"]),
    campusName: campusName.get(String(u["campusId"])) ?? "",
    areaName: areaName.get(String(u["areaId"])) ?? "",
    badgeStatus: String(u["badgeStatus"]),
    role: String(u["role"] ?? "member"),
    hasCommute: commuting.has(String(u["_id"])),
    suspended: Boolean(u["suspendedAt"]),
    joinedAt: (u["createdAt"] as Date).toISOString(),
  }));
}

/**
 * Lists members. The phone number is deliberately absent — see revealPhone.
 */
export async function listMembers(ctx: Ctx, filters: MemberFilters) {
  const query = memberQuery(ctx, filters);
  if (filters.before) {
    query["_id"] = { $lt: new Types.ObjectId(filters.before) };
  }

  const users = await UserModel.find(query)
    .select("name email userType institutionId campusId areaId badgeStatus role suspendedAt createdAt")
    .sort({ _id: -1 })
    .limit(filters.limit + 1)
    .lean();

  const page = users.slice(0, filters.limit);
  const last = page[page.length - 1];
  return {
    members: await toMemberRows(page as unknown as Array<Record<string, unknown>>),
    nextCursor: users.length > filters.limit && last ? last._id.toString() : null,
  };
}

async function loadMember(ctx: Ctx, memberId: string) {
  const user = await UserModel.findById(memberId).lean();
  if (!user) throw new NotFoundError("Not found.");
  assertInScope(ctx.admin.scope, user.institutionId);
  return user;
}

export async function getMember(ctx: Ctx, memberId: string) {
  const user = await loadMember(ctx, memberId);
  const [row] = await toMemberRows([user as unknown as Record<string, unknown>]);

  const [commute, reportsAgainst] = await Promise.all([
    CommuteModel.findOne({ ownerId: user._id, status: { $ne: "cancelled" } })
      .select("intent schedule direction seatsOffered status")
      .lean(),
    ReportModel.countDocuments({ reportedUserId: user._id }),
  ]);

  return {
    ...row!,
    commute: commute
      ? {
          intent: commute.intent,
          direction: commute.direction,
          days: commute.schedule.map((s) => s.day),
          seatsOffered: commute.seatsOffered ?? null,
          status: commute.status,
        }
      : null,
    reportsAgainst,
  };
}

/**
 * Suspends a member, signing them out everywhere.
 *
 * A university admin may only act on members. Admins are managed by the
 * platform, and letting one institution's admin lock out another admin — or
 * a super admin — would put account recovery in the wrong hands.
 */
export async function suspendMember(ctx: Ctx, memberId: string, reason: string) {
  const user = await loadMember(ctx, memberId);

  if (user._id.toString() === ctx.admin.userId) {
    throw new UnprocessableError("You cannot suspend yourself.");
  }
  if (ctx.admin.scope.kind === "institution" && (user.role ?? "member") !== "member") {
    throw new AuthorizationError("Administrators are managed by the platform team.");
  }
  if (user.suspendedAt) throw new ConflictError("That account is already suspended.");

  await UserModel.updateOne(
    { _id: user._id },
    { $set: { suspendedAt: new Date(), suspendedReason: reason } },
  );
  // Immediately, not at token expiry: the refresh chain is revoked and the
  // admin middleware already refuses suspended accounts on the next request.
  await revokeAllSessions(user._id, "admin");

  await recordAudit({
    actor: ctx.admin,
    action: "member.suspended",
    targetType: "user",
    targetId: user._id.toString(),
    institutionId: user.institutionId,
    metadata: { reason },
    ...(ctx.request ? { request: ctx.request } : {}),
  });

  return getMember(ctx, memberId);
}

export async function restoreMember(ctx: Ctx, memberId: string) {
  const user = await loadMember(ctx, memberId);
  if (!user.suspendedAt) throw new ConflictError("That account is not suspended.");
  if (ctx.admin.scope.kind === "institution" && (user.role ?? "member") !== "member") {
    throw new AuthorizationError("Administrators are managed by the platform team.");
  }

  await UserModel.updateOne(
    { _id: user._id },
    { $set: { suspendedAt: null, suspendedReason: null } },
  );

  await recordAudit({
    actor: ctx.admin,
    action: "member.restored",
    targetType: "user",
    targetId: user._id.toString(),
    institutionId: user.institutionId,
    ...(ctx.request ? { request: ctx.request } : {}),
  });

  return getMember(ctx, memberId);
}

/**
 * Reveals a member's phone number — and records that it was revealed.
 *
 * Admins are staff, not a reason to drop the privacy model. The number is not
 * in any list or detail response; seeing it is a deliberate act with a stated
 * reason, and it leaves a trace.
 */
export async function revealPhone(ctx: Ctx, memberId: string, reason: string) {
  const user = await loadMember(ctx, memberId);

  await recordAudit({
    actor: ctx.admin,
    action: "member.phoneRevealed",
    targetType: "user",
    targetId: user._id.toString(),
    institutionId: user.institutionId,
    metadata: { reason },
    ...(ctx.request ? { request: ctx.request } : {}),
  });

  return { phone: user.phone };
}

// ---------------------------------------------------------------------------
// Verification queue
// ---------------------------------------------------------------------------

export async function verificationQueue(ctx: Ctx, institutionId?: string) {
  const users = await UserModel.find({
    badgeStatus: "pending",
    deletedAt: null,
    ...institutionFilter(ctx.admin, institutionId),
  })
    .select("+badgeDocumentUrl name email userType campusId badgeRequestedAt institutionId")
    // Oldest first: a queue, served in order.
    .sort({ badgeRequestedAt: 1 })
    .limit(100)
    .lean();

  const campuses = await CampusModel.find({ _id: { $in: users.map((u) => u.campusId) } })
    .select("name")
    .lean();
  const campusName = new Map(campuses.map((c) => [c._id.toString(), c.name]));

  return Promise.all(
    users.map(async (u) => ({
      id: u._id.toString(),
      name: u.name,
      email: u.email,
      userType: u.userType,
      campusName: campusName.get(u.campusId.toString()) ?? "",
      // Only here. The identity document is select:false everywhere else,
      // and what is handed over is a URL that stops working in fifteen
      // minutes — long enough to review a card, short enough that a copied
      // link in a browser history is not a copy of somebody's student ID.
      documentUrl: await readUrlFor(u.badgeDocumentUrl),
      requestedAt: u.badgeRequestedAt ? u.badgeRequestedAt.toISOString() : null,
    })),
  );
}

export const REJECTION_REASONS = [
  "document-unreadable",
  "document-mismatch",
  "not-a-member",
  "expired-document",
  "other",
] as const;

const REJECTION_COPY: Record<(typeof REJECTION_REASONS)[number], string> = {
  "document-unreadable": "We could not read the document you sent. A clearer photo usually fixes this.",
  "document-mismatch": "The document did not match the details on your account.",
  "not-a-member": "We could not confirm that you study or work at this institution.",
  "expired-document": "The document you sent has expired.",
  other: "Your request could not be approved.",
};

/**
 * Approves or rejects a badge request.
 *
 * A fixed list of reasons, plus an optional note. Free text alone produces
 * "no" and an unhappy student with no idea what to fix.
 */
export async function decideVerification(
  ctx: Ctx,
  memberId: string,
  decision: { approve: boolean; reason?: (typeof REJECTION_REASONS)[number] | undefined; note?: string | undefined },
) {
  const user = await loadMember(ctx, memberId);

  if (!decision.approve && !decision.reason) {
    throw new UnprocessableError("Choose a reason for the rejection.");
  }

  // Guarded on pending, so two admins deciding at once cannot both succeed —
  // or approve something the other just rejected.
  const updated = await UserModel.findOneAndUpdate(
    { _id: user._id, badgeStatus: "pending" },
    {
      $set: {
        badgeStatus: decision.approve ? "approved" : "rejected",
        badgeReviewedAt: new Date(),
        badgeReviewedBy: new Types.ObjectId(ctx.admin.userId),
        badgeRejectionReason: decision.approve ? null : decision.reason,
      },
    },
    { new: true },
  ).lean();

  if (!updated) throw new ConflictError("That request has already been decided.");

  await recordAudit({
    actor: ctx.admin,
    action: decision.approve ? "verification.approved" : "verification.rejected",
    targetType: "user",
    targetId: user._id.toString(),
    institutionId: user.institutionId,
    metadata: decision.approve ? {} : { reason: decision.reason, note: decision.note ?? null },
    ...(ctx.request ? { request: ctx.request } : {}),
  });

  const reasonText = decision.approve
    ? undefined
    : [REJECTION_COPY[decision.reason!], decision.note].filter(Boolean).join(" ");

  // Both non-fatal: the decision is recorded, and a mail provider having a bad
  // afternoon must not make it look like it was not.
  await notifyQuietly({
    userId: user._id,
    kind: "badgeUpdate",
    title: decision.approve ? "Your badge is approved" : "About your badge request",
    body: decision.approve
      ? "Your verified badge now shows to others at your campus."
      : "Your request was not approved this time. You can apply again from Profile.",
  });
  await emailService()
    .sendBadgeDecision({
      to: user.email,
      name: user.name,
      approved: decision.approve,
      ...(reasonText ? { reason: reasonText } : {}),
    })
    .catch((error: unknown) => logger.warn({ err: error }, "badge email failed"));

  return { id: user._id.toString(), badgeStatus: updated.badgeStatus };
}

// ---------------------------------------------------------------------------
// Campuses
// ---------------------------------------------------------------------------

async function campusMemberCount(campusId: Types.ObjectId) {
  // Deleted accounts are not members. Counting them here would warn an admin
  // that deactivating a campus affects people who already left.
  return UserModel.countDocuments({
    campusId,
    emailVerifiedAt: { $ne: null },
    deletedAt: null,
  });
}

export async function listCampuses(ctx: Ctx, institutionId?: string) {
  const campuses = await CampusModel.find(institutionFilter(ctx.admin, institutionId))
    .sort({ name: 1 })
    .lean();
  const counts = await Promise.all(campuses.map((c) => campusMemberCount(c._id)));
  const areas = await AreaModel.find({ _id: { $in: campuses.map((c) => c.areaId).filter(Boolean) } })
    .select("name")
    .lean();
  const areaName = new Map(areas.map((a) => [a._id.toString(), a.name]));

  return campuses.map((c, i) => ({
    id: c._id.toString(),
    institutionId: c.institutionId.toString(),
    name: c.name,
    areaName: c.areaId ? (areaName.get(c.areaId.toString()) ?? null) : null,
    active: c.active,
    members: counts[i] ?? 0,
  }));
}

export async function createCampus(
  ctx: Ctx,
  input: { name: string; areaId?: string | undefined; institutionId?: string | undefined },
) {
  // A university admin always creates in their own institution; a platform
  // admin must say which.
  const institutionId =
    ctx.admin.scope.kind === "institution" ? ctx.admin.scope.institutionId : input.institutionId;
  if (!institutionId) throw new UnprocessableError("Say which institution the campus belongs to.");
  institutionFilter(ctx.admin, input.institutionId);

  if (input.areaId && !(await AreaModel.exists({ _id: input.areaId, active: true }))) {
    throw new UnprocessableError("That area is not available.");
  }

  try {
    const campus = await CampusModel.create({
      institutionId,
      name: input.name,
      areaId: input.areaId ?? null,
      active: true,
    });
    await recordAudit({
      actor: ctx.admin,
      action: "campus.created",
      targetType: "campus",
      targetId: campus._id.toString(),
      institutionId,
      metadata: { name: input.name },
      ...(ctx.request ? { request: ctx.request } : {}),
    });
    return (await listCampuses(ctx, ctx.admin.scope.kind === "platform" ? institutionId : undefined)).find(
      (c) => c.id === campus._id.toString(),
    )!;
  } catch (error) {
    if ((error as { code?: number }).code === 11000) {
      throw new ConflictError("A campus with that name already exists.");
    }
    throw error;
  }
}

/**
 * Renames, re-areas or deactivates a campus.
 *
 * Deactivating a campus that has members needs `confirm: true`. Without it the
 * server answers 409 with the count, so the panel can say exactly what the
 * change would affect before anybody commits to it.
 */
export async function updateCampus(
  ctx: Ctx,
  campusId: string,
  patch: { name?: string | undefined; areaId?: string | null | undefined; active?: boolean | undefined; confirm?: boolean | undefined },
) {
  const campus = await CampusModel.findById(campusId);
  if (!campus) throw new NotFoundError("Not found.");
  assertInScope(ctx.admin.scope, campus.institutionId);

  if (patch.active === false && campus.active) {
    const members = await campusMemberCount(campus._id);
    if (members > 0 && !patch.confirm) {
      throw new BusinessRuleError(
        `${members} ${members === 1 ? "member is" : "members are"} attached to this campus. Confirm to deactivate it anyway.`,
        { affectedMembers: members },
      );
    }
  }

  if (patch.areaId && !(await AreaModel.exists({ _id: patch.areaId, active: true }))) {
    throw new UnprocessableError("That area is not available.");
  }

  const before = { name: campus.name, active: campus.active };
  if (patch.name !== undefined) campus.name = patch.name;
  if (patch.areaId !== undefined) campus.areaId = patch.areaId ? new Types.ObjectId(patch.areaId) : null;
  if (patch.active !== undefined) campus.active = patch.active;

  try {
    await campus.save();
  } catch (error) {
    if ((error as { code?: number }).code === 11000) {
      throw new ConflictError("A campus with that name already exists.");
    }
    throw error;
  }

  await recordAudit({
    actor: ctx.admin,
    action: "campus.updated",
    targetType: "campus",
    targetId: campus._id.toString(),
    institutionId: campus.institutionId,
    metadata: { before, after: { name: campus.name, active: campus.active } },
    ...(ctx.request ? { request: ctx.request } : {}),
  });

  return (await listCampuses(ctx, ctx.admin.scope.kind === "platform" ? campus.institutionId.toString() : undefined)).find(
    (c) => c.id === campus._id.toString(),
  )!;
}

// ---------------------------------------------------------------------------
// Institution profile
// ---------------------------------------------------------------------------

/**
 * Edits an institution's profile.
 *
 * Name, type and activation are not here: those are platform decisions. A
 * university admin shapes how their own institution looks and which email
 * domains it accepts — and a domain change that would orphan existing
 * accounts needs `confirm: true`, with the count returned first.
 */
export async function updateInstitutionProfile(
  ctx: Ctx,
  institutionId: string,
  patch: {
    shortName?: string | undefined;
    brandColor?: string | undefined;
    logoMarkUrl?: string | null | undefined;
    logoWideUrl?: string | null | undefined;
    emailDomains?: string[] | undefined;
    confirm?: boolean | undefined;
  },
) {
  const institution = await InstitutionModel.findById(institutionId);
  if (!institution) throw new NotFoundError("Not found.");
  assertInScope(ctx.admin.scope, institution._id);

  if (patch.emailDomains) {
    const domains = patch.emailDomains.map((d) => d.trim().toLowerCase().replace(/^@/, ""));
    // Live accounts only: a deleted account's address was rewritten when it
    // closed, and warning about it would be warning about nobody.
    const accounts = await UserModel.find({
      institutionId: institution._id,
      deletedAt: null,
    })
      .select("email")
      .lean();
    const orphaned = accounts.filter((a) => !domains.includes(a.email.split("@")[1] ?? "")).length;

    if (orphaned > 0 && !patch.confirm) {
      throw new BusinessRuleError(
        `${orphaned} existing ${orphaned === 1 ? "account uses" : "accounts use"} a domain this change removes. Confirm to save anyway.`,
        { affectedAccounts: orphaned },
      );
    }
    institution.emailDomains = domains;
  }

  const before = {
    shortName: institution.shortName ?? null,
    brandColor: institution.brandColor,
    emailDomains: [...institution.emailDomains],
  };

  if (patch.shortName !== undefined) institution.shortName = patch.shortName;
  if (patch.brandColor !== undefined) institution.brandColor = patch.brandColor;
  if (patch.logoMarkUrl !== undefined) institution.logoMarkUrl = patch.logoMarkUrl;
  if (patch.logoWideUrl !== undefined) institution.logoWideUrl = patch.logoWideUrl;

  await institution.save();

  await recordAudit({
    actor: ctx.admin,
    action: "institution.updated",
    targetType: "institution",
    targetId: institution._id.toString(),
    institutionId: institution._id,
    metadata: {
      before,
      after: {
        shortName: institution.shortName ?? null,
        brandColor: institution.brandColor,
        emailDomains: institution.emailDomains,
      },
    },
    ...(ctx.request ? { request: ctx.request } : {}),
  });

  return {
    id: institution._id.toString(),
    name: institution.name,
    shortName: institution.shortName ?? null,
    brandColor: institution.brandColor,
    logoMarkUrl: institution.logoMarkUrl ?? null,
    logoWideUrl: institution.logoWideUrl ?? null,
    emailDomains: institution.emailDomains,
    active: institution.active,
  };
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

export async function listReports(
  ctx: Ctx,
  filters: { status?: string | undefined; institutionId?: string | undefined; limit: number; before?: string | undefined },
) {
  const query: Record<string, unknown> = {};
  if (filters.status) query["status"] = filters.status;
  if (filters.before) query["_id"] = { $lt: new Types.ObjectId(filters.before) };
  const scoped = { ...query, ...institutionFilter(ctx.admin, filters.institutionId) };

  const rows = await ReportModel.find(scoped).sort({ _id: -1 }).limit(filters.limit + 1).lean();
  const page = rows.slice(0, filters.limit);
  const people = await UserModel.find({
    _id: { $in: page.flatMap((r) => [r.reporterId, r.reportedUserId].filter(Boolean)) },
  })
    .select("name")
    .lean();
  const nameOf = new Map(people.map((p) => [p._id.toString(), p.name]));
  const last = page[page.length - 1];

  return {
    reports: page.map((r) => ({
      id: r._id.toString(),
      institutionId: r.institutionId.toString(),
      reporter: { id: r.reporterId.toString(), name: nameOf.get(r.reporterId.toString()) ?? "" },
      reported: r.reportedUserId
        ? { id: r.reportedUserId.toString(), name: nameOf.get(r.reportedUserId.toString()) ?? "" }
        : null,
      category: r.category,
      detail: r.detail ?? null,
      status: r.status,
      createdAt: (r as { createdAt: Date }).createdAt.toISOString(),
    })),
    nextCursor: rows.length > filters.limit && last ? last._id.toString() : null,
  };
}

/**
 * Acts on a report.
 *
 * University admins act on open reports and may escalate. Escalated reports
 * belong to the platform team — the escalation exists precisely because the
 * institution handed it up.
 */
export async function actOnReport(
  ctx: Ctx,
  reportId: string,
  action: "dismiss" | "warn" | "suspend" | "escalate",
  note: string | undefined,
) {
  const report = await ReportModel.findById(reportId).lean();
  if (!report) throw new NotFoundError("Not found.");
  assertInScope(ctx.admin.scope, report.institutionId);

  const allowedFrom =
    ctx.admin.scope.kind === "platform" ? ["open", "escalated"] : ["open"];

  if (!allowedFrom.includes(report.status)) {
    throw new ConflictError("That report has already been handled.");
  }
  if (action === "escalate" && ctx.admin.scope.kind === "platform") {
    throw new UnprocessableError("Escalation hands a report to the platform team.");
  }
  if ((action === "suspend" || action === "warn") && !report.reportedUserId) {
    throw new UnprocessableError("This report is not about a person.");
  }

  // Checked BEFORE the report changes state. Otherwise a university admin
  // "suspending" a reported administrator would mark the report handled and
  // then fail the suspension, leaving a report that says something happened
  // when nothing did.
  if (action === "suspend" && report.reportedUserId && ctx.admin.scope.kind === "institution") {
    const target = await UserModel.findById(report.reportedUserId).select("role").lean();
    if ((target?.role ?? "member") !== "member") {
      throw new AuthorizationError(
        "This report concerns an administrator. Escalate it to the platform team.",
      );
    }
  }

  const status = { dismiss: "dismissed", warn: "warned", suspend: "suspended", escalate: "escalated" }[action];

  const updated = await ReportModel.findOneAndUpdate(
    { _id: report._id, status: report.status },
    { $set: { status, handledBy: new Types.ObjectId(ctx.admin.userId), handledAt: new Date() } },
    { new: true },
  ).lean();
  if (!updated) throw new ConflictError("That report has already been handled.");

  if (action === "suspend" && report.reportedUserId) {
    const target = await UserModel.findById(report.reportedUserId).select("suspendedAt role").lean();
    if (target && !target.suspendedAt) {
      await suspendMember(ctx, report.reportedUserId.toString(), note ?? `Report ${reportId}`);
    }
  }

  await recordAudit({
    actor: ctx.admin,
    action: "report.actioned",
    targetType: "report",
    targetId: report._id.toString(),
    institutionId: report.institutionId,
    metadata: { action, note: note ?? null },
    ...(ctx.request ? { request: ctx.request } : {}),
  });

  return { id: updated._id.toString(), status: updated.status };
}

/**
 * Streams members as CSV.
 *
 * A cursor, not an array: an institution with fifty thousand members must not
 * be loaded into memory to answer one export. Scope and field restrictions are
 * the same as the list — no phone numbers, ever, in an export.
 */
export async function* exportMembersCsv(ctx: Ctx, filters: Omit<MemberFilters, "limit" | "before">) {
  const escape = (value: string) =>
    /[",\n]/.test(value) || /^[=+\-@]/.test(value)
      ? // Quotes doubled; a leading formula character neutralised, so a name
        // like "=HYPERLINK(...)" cannot execute when opened in a spreadsheet.
        `"${(/^[=+\-@]/.test(value) ? `'${value}` : value).replace(/"/g, '""')}"`
      : value;

  yield "name,email,userType,campus,area,badgeStatus,hasCommute,suspended,joinedAt\n";

  const cursor = UserModel.find(memberQuery(ctx, { ...filters, limit: 0 }))
    .select("name email userType institutionId campusId areaId badgeStatus role suspendedAt createdAt")
    .sort({ _id: 1 })
    .lean()
    .cursor({ batchSize: 200 });

  let batch: Array<Record<string, unknown>> = [];
  const flush = async function* () {
    for (const row of await toMemberRows(batch)) {
      yield [
        row.name,
        row.email,
        row.userType,
        row.campusName,
        row.areaName,
        row.badgeStatus,
        String(row.hasCommute),
        String(row.suspended),
        row.joinedAt,
      ]
        .map(escape)
        .join(",") + "\n";
    }
    batch = [];
  };

  for await (const doc of cursor) {
    batch.push(doc as unknown as Record<string, unknown>);
    if (batch.length >= 200) yield* flush();
  }
  if (batch.length > 0) yield* flush();
}
