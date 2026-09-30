import type { FastifyRequest } from "fastify";
import { Types } from "mongoose";
import { logger } from "../../utils/logger.js";
import { AuditLogModel } from "../../db/models/index.js";
import type { AdminContext } from "../../middleware/admin.js";

/**
 * The audit log.
 *
 * Append-only, enforced by the model rather than by convention: any update or
 * delete through Mongoose throws (see platform.model.ts). Built before a
 * single privileged route exists, because "who did this" can only be answered
 * for actions that happened after the log did.
 */

export type AuditAction =
  | "institution.created"
  | "institution.activated"
  | "institution.deactivated"
  | "institution.updated"
  | "admin.signInRequested"
  | "admin.signedIn"
  | "admin.invited"
  | "admin.removed"
  | "member.suspended"
  | "member.restored"
  | "member.phoneRevealed"
  | "verification.approved"
  | "verification.rejected"
  | "report.actioned"
  | "campus.created"
  | "campus.updated"
  | "configuration.changed";

/**
 * Keys that must never be persisted in metadata.
 *
 * Metadata is written by our own handlers, but "our own handlers" includes the
 * one somebody writes next year in a hurry. A token or password landing here
 * would sit in an append-only collection indefinitely — the one place it can
 * never be cleaned out of.
 */
const FORBIDDEN_KEY = /pass(word)?|token|secret|otp|code|hash|authorization|cookie|phone/i;

function scrub(value: unknown, depth = 0): unknown {
  if (depth > 4 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => scrub(item, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    out[key] = FORBIDDEN_KEY.test(key) ? "[removed]" : scrub(inner, depth + 1);
  }
  return out;
}

export async function recordAudit(input: {
  actor: Pick<AdminContext, "userId" | "role">;
  action: AuditAction;
  targetType: string;
  targetId?: string | null;
  institutionId?: string | Types.ObjectId | null;
  metadata?: Record<string, unknown>;
  request?: FastifyRequest;
}): Promise<void> {
  await AuditLogModel.create({
    actorUserId: input.actor.userId,
    actorRole: input.actor.role,
    action: input.action,
    targetType: input.targetType,
    targetId: input.targetId ?? null,
    institutionId: input.institutionId ?? null,
    metadata: input.metadata ? scrub(input.metadata) : null,
    requestId: input.request?.id ?? null,
    ip: input.request?.ip ?? null,
  });

  logger.info(
    { action: input.action, actorUserId: input.actor.userId, targetType: input.targetType },
    "audit",
  );
}

export type AuditEntry = {
  id: string;
  actorUserId: string;
  actorRole: string;
  action: string;
  targetType: string;
  targetId: string | null;
  institutionId: string | null;
  metadata: unknown;
  requestId: string | null;
  createdAt: string;
};

/**
 * Reads the log, newest first, with cursor pagination.
 *
 * Cursor rather than offset: the log only grows, and an offset into a
 * collection that gains rows between pages skips or repeats entries.
 */
export async function listAudit(filters: {
  action?: string | undefined;
  actorUserId?: string | undefined;
  institutionId?: string | undefined;
  before?: string | undefined;
  limit: number;
}): Promise<{ entries: AuditEntry[]; nextCursor: string | null }> {
  const query: Record<string, unknown> = {};
  if (filters.action) query["action"] = filters.action;
  if (filters.actorUserId) query["actorUserId"] = new Types.ObjectId(filters.actorUserId);
  if (filters.institutionId) query["institutionId"] = new Types.ObjectId(filters.institutionId);
  if (filters.before) query["_id"] = { $lt: new Types.ObjectId(filters.before) };

  const rows = await AuditLogModel.find(query)
    .sort({ _id: -1 })
    .limit(filters.limit + 1)
    .lean();

  const page = rows.slice(0, filters.limit);
  const last = page[page.length - 1];

  return {
    entries: page.map((row) => ({
      id: row._id.toString(),
      actorUserId: row.actorUserId.toString(),
      actorRole: row.actorRole,
      action: row.action,
      targetType: row.targetType,
      targetId: row.targetId ?? null,
      institutionId: row.institutionId ? row.institutionId.toString() : null,
      metadata: row.metadata ?? null,
      requestId: row.requestId ?? null,
      createdAt: (row as { createdAt: Date }).createdAt.toISOString(),
    })),
    nextCursor: rows.length > filters.limit && last ? last._id.toString() : null,
  };
}
