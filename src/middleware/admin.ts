import type { FastifyReply, FastifyRequest } from "fastify";
import { Types } from "mongoose";
import { authenticate, requireUser } from "./authenticate.js";
import {
  AuthenticationError,
  AuthorizationError,
  NotFoundError,
} from "../utils/errors.js";
import { UserModel } from "../db/models/index.js";
import { roleOf, scopeCovers, scopeOf } from "../contract/roles.js";
import type { AdminScope, Role } from "../contract/types.js";

/**
 * Admin authorisation, in one place.
 *
 * Every admin route goes through `requireAdmin` or `requireSuperAdmin`, and
 * every admin query is built from `scopeFilter(request.admin.scope)`. There is
 * no other way to reach admin data, which is the point: scoping written into
 * thirty controllers is scoping that is missing from the thirty-first.
 */

export type AdminContext = {
  userId: string;
  role: Role;
  institutionId: string;
  scope: AdminScope;
};

declare module "fastify" {
  interface FastifyRequest {
    admin?: AdminContext;
  }
}

/**
 * Resolves the caller's admin scope from the DATABASE, not the token.
 *
 * The access token carries a role claim, but it lives for up to fifteen
 * minutes. Removing somebody's admin role has to take effect on their very
 * next request, not a quarter of an hour later — so the role and institution
 * are read fresh here. One indexed read per admin request is a small price for
 * revocation that actually revokes.
 */
async function resolveAdmin(request: FastifyRequest): Promise<AdminContext> {
  const { id } = requireUser(request);

  const user = await UserModel.findById(id)
    .select("role institutionId suspendedAt")
    .lean();

  if (!user || user.suspendedAt) {
    throw new AuthenticationError("Your session has expired. Sign in again.");
  }

  const scope = scopeOf({
    role: (user.role as Role | undefined) ?? "member",
    institutionId: user.institutionId.toString(),
  });

  if (!scope) {
    // 403 is right here: the admin area's existence is not a secret, only
    // what is inside it.
    throw new AuthorizationError("This area is for administrators.");
  }

  return {
    userId: id,
    role: roleOf({ role: (user.role as Role | undefined) ?? "member" }),
    institutionId: user.institutionId.toString(),
    scope,
  };
}

export async function requireAdmin(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  await authenticate(request, reply);
  request.admin = await resolveAdmin(request);
}

export async function requireSuperAdmin(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  await requireAdmin(request, reply);
  if (request.admin?.scope.kind !== "platform") {
    throw new AuthorizationError("This area is for platform administrators.");
  }
}

/** The admin context, or an error if a route forgot its guard. */
export function requireAdminContext(request: FastifyRequest): AdminContext {
  if (!request.admin) {
    throw new AuthorizationError("This area is for administrators.");
  }
  return request.admin;
}

/**
 * The filter every admin query starts from.
 *
 * Spread LAST into a query, so nothing the caller supplied can widen it:
 *
 *   Model.find({ ...filtersFromRequest, ...scopeFilter(scope) })
 *
 * A university admin's filter always pins their own institution, whatever a
 * query string said.
 */
export function scopeFilter(scope: AdminScope): { institutionId?: Types.ObjectId } {
  return scope.kind === "platform"
    ? {}
    : { institutionId: new Types.ObjectId(scope.institutionId) };
}

/**
 * Checks a single resource against the scope.
 *
 * 404, never 403, for something outside it. A 403 on
 * `/admin/members/<id-from-another-institution>` would confirm that id exists
 * and belongs to somebody — exactly what an enumeration attempt is looking for.
 */
export function assertInScope(
  scope: AdminScope,
  institutionId: { toString(): string } | null | undefined,
): void {
  if (!institutionId || !scopeCovers(scope, institutionId.toString())) {
    throw new NotFoundError("Not found.");
  }
}
