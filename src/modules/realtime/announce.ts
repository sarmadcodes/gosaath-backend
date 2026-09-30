import { ReportModel, UserModel } from "../../db/models/index.js";
import { logger } from "../../utils/logger.js";
import { publish, publishAll } from "./hub.js";
import type { Channel } from "./events.js";

/**
 * Domain events that carry a queue count.
 *
 * An admin panel's sidebar shows "Verifications 4". For that badge to move on
 * its own, the event has to carry the new number — and the number has to be
 * counted the same way the panel counts it, or the badge and the list it links
 * to disagree. Recounting in each service is how that divergence happens, so
 * the queries live here, once, mirroring `overview()`.
 *
 * **Never throws.** Every function is a side effect on a screen somebody may
 * not even have open. An admin approving a verification must not see it fail
 * because a count query timed out, so each one logs and swallows. The
 * authoritative state is in MongoDB either way; the worst case is a sidebar
 * that is briefly stale, which is exactly where we were before any of this.
 */

/** Institution admins, and the platform console, which sees everything. */
function adminChannels(institutionId: string): Channel[] {
  return [{ kind: "institution", institutionId }, { kind: "platform" }];
}

async function pendingVerifications(institutionId: string): Promise<number> {
  return UserModel.countDocuments({
    institutionId,
    badgeStatus: "pending",
    deletedAt: null,
  });
}

async function openReports(institutionId: string): Promise<number> {
  return ReportModel.countDocuments({
    institutionId,
    status: { $in: ["open", "escalated"] },
  });
}

/** Somebody applied for the verified badge. */
export async function announceVerificationCreated(institutionId: string): Promise<void> {
  try {
    publishAll(adminChannels(institutionId), {
      type: "admin.verification.created",
      pending: await pendingVerifications(institutionId),
    });
  } catch (error) {
    logger.warn({ err: error }, "could not announce verification");
  }
}

/**
 * An admin decided one.
 *
 * Two audiences with different needs: the other admins lose a row from the
 * queue, and the member learns the outcome. The member's event carries the
 * status because it is about them and they are allowed to know it; the admin
 * event carries only a count.
 */
export async function announceVerificationDecided(input: {
  institutionId: string;
  userId: string;
  status: "approved" | "rejected";
}): Promise<void> {
  try {
    publishAll(adminChannels(input.institutionId), {
      type: "admin.verification.updated",
      pending: await pendingVerifications(input.institutionId),
    });
    publish(
      { kind: "user", userId: input.userId },
      { type: "verification.updated", status: input.status },
    );
  } catch (error) {
    logger.warn({ err: error }, "could not announce verification decision");
  }
}

/**
 * Somebody reported somebody.
 *
 * Only the count goes out. Who reported whom, and why, is the most sensitive
 * thing in this system — an admin event reaches every administrator of the
 * institution, and a reporter was promised the person they reported would
 * never find out. The queue itself is fetched through the authorised endpoint.
 */
export async function announceReportCreated(institutionId: string): Promise<void> {
  try {
    publishAll(adminChannels(institutionId), {
      type: "admin.report.created",
      open: await openReports(institutionId),
    });
  } catch (error) {
    logger.warn({ err: error }, "could not announce report");
  }
}

export async function announceReportUpdated(institutionId: string): Promise<void> {
  try {
    publishAll(adminChannels(institutionId), {
      type: "admin.report.updated",
      open: await openReports(institutionId),
    });
  } catch (error) {
    logger.warn({ err: error }, "could not announce report update");
  }
}

/**
 * A member's standing changed — suspended, restored, verified.
 *
 * Carries an id and nothing else, so an open member list or detail page knows
 * to refetch that one row. Two admins working the same queue see each other's
 * decisions instead of both acting on a stale list.
 */
export function announceMemberChanged(institutionId: string, memberId: string): void {
  publishAll(adminChannels(institutionId), {
    type: "admin.member.changed",
    memberId,
  });
}

/** Told directly, because it changes what the app will let them do. */
export function announceAccountStanding(
  userId: string,
  standing: "suspended" | "restored",
): void {
  publish(
    { kind: "user", userId },
    { type: standing === "suspended" ? "account.suspended" : "account.restored" },
  );
}

export function announceInstitutionChanged(institutionId: string): void {
  publish({ kind: "platform" }, { type: "admin.institution.changed", institutionId });
}
