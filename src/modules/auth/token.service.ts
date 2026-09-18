import { SignJWT, jwtVerify, type JWTPayload } from "jose";
import { Types } from "mongoose";
import { env } from "../../config/env.js";
import { logger } from "../../utils/logger.js";
import { AuthenticationError } from "../../utils/errors.js";
import { generateRefreshToken, hashToken } from "../../utils/crypto.js";
import { SessionModel } from "../../db/models/index.js";

/**
 * Access tokens and refresh sessions.
 *
 * Two different things on purpose:
 *
 *   access   short-lived signed JWT, verified without touching the database,
 *            which is what keeps an authenticated request cheap
 *   refresh  opaque random string backed by a row, so it can be revoked
 *
 * A single long-lived token would mean either a database read on every request
 * or no way to sign anybody out.
 */

const ISSUER = "gosaath";
const AUDIENCE = "gosaath-app";

export type AccessClaims = {
  sub: string;
  sid: string;
  role: string;
  institutionId: string;
};

function secret(): Uint8Array {
  if (!env.JWT_SECRET) {
    // Unreachable in staging or production, where config validation requires
    // it. In development this is the clear failure rather than a silent one.
    throw new Error("JWT_SECRET is not configured");
  }
  return new TextEncoder().encode(env.JWT_SECRET);
}

export async function signAccessToken(claims: AccessClaims): Promise<string> {
  return new SignJWT({
    sid: claims.sid,
    role: claims.role,
    institutionId: claims.institutionId,
    // Distinguishes an access token from anything else we ever sign, so one
    // kind of token can never be replayed as another.
    typ: "access",
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(claims.sub)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${env.ACCESS_TOKEN_TTL_MIN}m`)
    .sign(secret());
}

/**
 * Verifies an access token.
 *
 * Checks signature, expiry, issuer, audience AND token type. Verifying only
 * the signature is the classic mistake: a token minted for another purpose,
 * or by another service sharing the secret, would otherwise sail through.
 */
export async function verifyAccessToken(token: string): Promise<AccessClaims> {
  let payload: JWTPayload;
  try {
    const result = await jwtVerify(token, secret(), {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: ["HS256"],
    });
    payload = result.payload;
  } catch {
    // Never surfaces why: expired, forged and malformed all look identical to
    // the caller, so a probe learns nothing.
    throw new AuthenticationError("Your session has expired. Sign in again.");
  }

  if (payload["typ"] !== "access") {
    throw new AuthenticationError("Your session has expired. Sign in again.");
  }

  const sub = payload.sub;
  const sid = payload["sid"];
  if (typeof sub !== "string" || typeof sid !== "string") {
    throw new AuthenticationError("Your session has expired. Sign in again.");
  }

  return {
    sub,
    sid,
    role: typeof payload["role"] === "string" ? payload["role"] : "member",
    institutionId:
      typeof payload["institutionId"] === "string"
        ? payload["institutionId"]
        : "",
  };
}

export type IssuedSession = {
  sessionId: string;
  refreshToken: string;
  expiresAt: Date;
};

export async function createSession(input: {
  userId: Types.ObjectId;
  userAgent?: string | undefined;
  ip?: string | undefined;
}): Promise<IssuedSession> {
  const refreshToken = generateRefreshToken();
  const expiresAt = new Date(
    Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000,
  );

  const session = await SessionModel.create({
    userId: input.userId,
    refreshTokenHash: hashToken(refreshToken),
    expiresAt,
    userAgent: input.userAgent ?? null,
    ip: input.ip ?? null,
  });

  return {
    sessionId: session._id.toString(),
    refreshToken,
    expiresAt,
  };
}

/**
 * Exchanges a refresh token for a new one, rotating the session.
 *
 * Presenting a token that has already been rotated means it was captured: the
 * legitimate device would be holding the newer one. We cannot tell the thief
 * from the victim, so the entire chain is revoked and both are signed out.
 * Letting it slide would leave the attacker with a working session
 * indefinitely.
 */
export async function rotateSession(input: {
  refreshToken: string;
  userAgent?: string | undefined;
  ip?: string | undefined;
}): Promise<{ userId: Types.ObjectId; issued: IssuedSession }> {
  const presentedHash = hashToken(input.refreshToken);
  const existing = await SessionModel.findOne({ refreshTokenHash: presentedHash });

  if (!existing) {
    throw new AuthenticationError("Your session has expired. Sign in again.");
  }

  if (existing.revokedAt) {
    if (existing.revokedReason === "rotated") {
      logger.warn(
        { userId: existing.userId.toString(), sessionId: existing._id.toString() },
        "refresh token reuse detected; revoking the whole chain",
      );
      await revokeAllSessions(existing.userId, "reuseDetected");
    }
    throw new AuthenticationError("Your session has expired. Sign in again.");
  }

  if (existing.expiresAt.getTime() <= Date.now()) {
    throw new AuthenticationError("Your session has expired. Sign in again.");
  }

  const issued = await createSession({
    userId: existing.userId,
    userAgent: input.userAgent,
    ip: input.ip,
  });

  existing.revokedAt = new Date();
  existing.revokedReason = "rotated";
  existing.replacedBySessionId = new Types.ObjectId(issued.sessionId);
  existing.lastUsedAt = new Date();
  await existing.save();

  return { userId: existing.userId, issued };
}

export async function revokeSessionByToken(refreshToken: string): Promise<void> {
  // Idempotent: logging out twice, or with a token already gone, is a no-op
  // rather than an error the client has to handle.
  await SessionModel.updateOne(
    { refreshTokenHash: hashToken(refreshToken), revokedAt: null },
    { $set: { revokedAt: new Date(), revokedReason: "logout" } },
  );
}

export async function revokeAllSessions(
  userId: Types.ObjectId,
  reason: "passwordChanged" | "reuseDetected" | "admin" | "logout",
): Promise<void> {
  await SessionModel.updateMany(
    { userId, revokedAt: null },
    { $set: { revokedAt: new Date(), revokedReason: reason } },
  );
}

/** Looks up a live session, for turning a refresh token into an access token. */
export async function findLiveSession(refreshToken: string) {
  return SessionModel.findOne({
    refreshTokenHash: hashToken(refreshToken),
    revokedAt: null,
    expiresAt: { $gt: new Date() },
  });
}
