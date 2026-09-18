import type { FastifyReply, FastifyRequest } from "fastify";
import { AuthenticationError } from "../utils/errors.js";
import { verifyAccessToken } from "../modules/auth/token.service.js";
import type { Role } from "../contract/types.js";

/**
 * Turns a bearer token into an authenticated caller.
 *
 * Verification is a signature check with no database read, which is what keeps
 * an authenticated request cheap. Revocation is handled by the access token's
 * short life rather than a lookup on every call — a revoked session stops
 * working within minutes, and anything that must die instantly (a password
 * reset, a detected token theft) also revokes the refresh chain.
 */

export type AuthenticatedUser = {
  id: string;
  sessionId: string;
  role: Role;
  institutionId: string;
};

declare module "fastify" {
  interface FastifyRequest {
    /** Present only after `authenticate` has run on the route. */
    user?: AuthenticatedUser;
  }
}

function bearerFrom(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (typeof header !== "string") return null;
  const [scheme, token] = header.split(" ");
  // Case-insensitive: some clients send "bearer".
  if (!scheme || scheme.toLowerCase() !== "bearer" || !token) return null;
  return token.trim() || null;
}

export async function authenticate(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  const token = bearerFrom(request);
  if (!token) {
    throw new AuthenticationError("Sign in to continue.");
  }

  const claims = await verifyAccessToken(token);

  request.user = {
    id: claims.sub,
    sessionId: claims.sid,
    role: (claims.role as Role) ?? "member",
    institutionId: claims.institutionId,
  };
}

/**
 * The authenticated caller, or an error.
 *
 * Handlers call this rather than reading `request.user` directly, so a route
 * that forgot to register `authenticate` fails loudly instead of quietly
 * treating `undefined` as anonymous and carrying on.
 */
export function requireUser(request: FastifyRequest): AuthenticatedUser {
  if (!request.user) {
    throw new AuthenticationError("Sign in to continue.");
  }
  return request.user;
}
