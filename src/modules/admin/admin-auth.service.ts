import type { FastifyRequest } from "fastify";
import { Types } from "mongoose";
import { logger } from "../../utils/logger.js";
import { AuthenticationError, RateLimitError } from "../../utils/errors.js";
import { UserModel } from "../../db/models/index.js";
import { roleOf } from "../../contract/roles.js";
import { createSession } from "../auth/token.service.js";
import { consumeOtp, issueOtp } from "../auth/otp.service.js";
import { emailService } from "../../services/email/index.js";
import { recordAudit } from "../audit/audit.service.js";
import type { Role } from "../../contract/types.js";

/**
 * Administrator sign-in, by emailed code.
 *
 * No password. An admin console is the most valuable thing in this system —
 * one account can read every member of an institution — and a password is a
 * credential that can be reused from a breach somewhere else, written on a
 * whiteboard, or typed into a phishing page that looks like this one. A code
 * sent to a mailbox we already know belongs to the institution is a second
 * factor that cannot be any of those things.
 *
 * **Nothing here reveals who is an administrator.** Requesting a code answers
 * identically for an admin, an ordinary member, and an address that has never
 * existed. Otherwise this endpoint becomes a tool for finding out exactly which
 * three people to phish.
 */

/**
 * Carries the request itself, not a copy of two fields from it.
 *
 * The audit log records the caller's address and user agent, and it takes the
 * request to read them consistently with every other audited action.
 */
type RequestContext = { request: FastifyRequest };

/** Roles that may hold a session issued by this route. */
function isAdminRole(role: Role): boolean {
  return role === "universityAdmin" || role === "superAdmin";
}

/**
 * Sends a sign-in code, if the address belongs to an administrator.
 *
 * Returns nothing, always, and never throws for a reason the caller could learn
 * something from. Every early return below is an address that gets no email:
 *
 *   - no such account
 *   - an account that never confirmed its email
 *   - a suspended or deleted account
 *   - an ordinary member
 *
 * A caller cannot tell which, nor tell any of them from success.
 */
export async function requestAdminCode(
  rawEmail: string,
  context: RequestContext,
): Promise<void> {
  const email = rawEmail.trim().toLowerCase();

  const user = await UserModel.findOne({ email })
    .select("name email role emailVerifiedAt suspendedAt deletedAt institutionId")
    .lean();

  if (!user) {
    // Logged so a real attempt against a non-existent admin address is
    // visible in operations, without telling the caller anything.
    logger.info({ email: "redacted" }, "admin code requested for unknown address");
    return;
  }
  if (!user.emailVerifiedAt || user.suspendedAt || user.deletedAt) return;
  if (!isAdminRole(roleOf(user))) return;

  let issued: { code: string; expiresInMinutes: number };
  try {
    issued = await issueOtp({ email, purpose: "adminSignIn" });
  } catch (error) {
    // The cooldown and the send ceiling are the one place this flow could leak
    // whether an address is an admin: a rate-limit error for admins and
    // silence for everyone else is an oracle. Swallowed, so the response stays
    // identical. The admin simply does not get a second email until the
    // cooldown passes, which is what the cooldown is for.
    if (error instanceof RateLimitError) {
      logger.info({ userId: user._id.toString() }, "admin code suppressed by cooldown");
      return;
    }
    throw error;
  }

  await emailService()
    .sendAdminSignInCode({
      to: email,
      name: user.name,
      code: issued.code,
      expiresInMinutes: issued.expiresInMinutes,
    })
    .catch((error: unknown) => {
      // A provider outage must not be reported as a bad address, and there is
      // nothing useful to tell the caller either way.
      logger.error({ err: error, userId: user._id.toString() }, "admin code email failed");
    });

  logger.info({ userId: user._id.toString() }, "admin sign-in code sent");

  await recordAudit({
    actor: { userId: user._id.toString(), role: roleOf(user) },
    action: "admin.signInRequested",
    targetType: "user",
    targetId: user._id.toString(),
    institutionId: user.institutionId,
    request: context.request,
  }).catch((error: unknown) => {
    logger.warn({ err: error }, "could not record admin sign-in request");
  });
}

/**
 * Exchanges a correct code for a session.
 *
 * The role is read again here, not carried over from the request step. A code
 * lives for ten minutes, and an administrator whose access is revoked inside
 * that window must not be able to spend a code that was valid when it was
 * sent — which is exactly when revoking somebody's access matters most.
 */
export async function verifyAdminCode(
  rawEmail: string,
  code: string,
  context: RequestContext,
): Promise<{ token: string; role: Role }> {
  const email = rawEmail.trim().toLowerCase();

  // Throws the same error for a wrong code, an expired one, and an address
  // with no challenge at all. Attempts are counted and the challenge is burned
  // past the limit, so six digits cannot be walked through.
  await consumeOtp({ email, purpose: "adminSignIn", code });

  const user = await UserModel.findOne({ email })
    .select("name email role emailVerifiedAt suspendedAt deletedAt institutionId")
    .lean();

  const reject = () => new AuthenticationError("That code is no longer valid.");

  if (!user || !user.emailVerifiedAt || user.suspendedAt || user.deletedAt) throw reject();

  const role = roleOf(user);
  if (!isAdminRole(role)) throw reject();

  const issued = await createSession({
    userId: user._id as Types.ObjectId,
    userAgent: context.request.headers["user-agent"],
    ip: context.request.ip,
  });

  logger.info({ userId: user._id.toString(), role }, "admin signed in");

  await recordAudit({
    actor: { userId: user._id.toString(), role },
    action: "admin.signedIn",
    targetType: "user",
    targetId: user._id.toString(),
    institutionId: user.institutionId,
    request: context.request,
  }).catch((error: unknown) => {
    logger.warn({ err: error }, "could not record admin sign-in");
  });

  // The refresh token only. The access token is minted by /auth/refresh like
  // everywhere else, so there is one code path issuing access tokens rather
  // than two that can drift apart on claims.
  return { token: issued.refreshToken, role };
}
