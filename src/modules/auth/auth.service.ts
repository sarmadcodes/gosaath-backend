import { Types } from "mongoose";
import { env } from "../../config/env.js";
import { logger } from "../../utils/logger.js";
import {
  AuthenticationError,
  RateLimitError,
  UnprocessableError,
  ValidationError,
} from "../../utils/errors.js";
import { hashPassword, verifyPassword } from "../../utils/crypto.js";
import {
  CampusModel,
  InstitutionModel,
  LoginAttemptModel,
  UserModel,
} from "../../db/models/index.js";
import { emailService } from "../../services/email/index.js";
import { toUser } from "../users/user.mapper.js";
import { consumeOtp, issueOtp } from "./otp.service.js";
import {
  createSession,
  findLiveSession,
  revokeAllSessions,
  revokeSessionByToken,
  signAccessToken,
} from "./token.service.js";
import type { AuthSession, RegisterInput } from "../../contract/api.js";

/**
 * Registration, verification and sign-in.
 *
 * Two themes run through all of it:
 *
 *   1. The server decides. Institution, campus and email domain are validated
 *      here, never trusted from the client.
 *   2. Responses do not distinguish accounts that exist from ones that do not.
 *      Every path that could confirm an address returns the same thing.
 */

type RequestContext = {
  userAgent?: string | undefined;
  ip?: string | undefined;
};

const normaliseEmail = (email: string) => email.trim().toLowerCase();

/**
 * Turns a session into what the client contract expects.
 *
 * `token` is the REFRESH token, not the access token. The mobile app stores
 * one value and calls `restore()` on launch; the HTTP client exchanges it for
 * a short-lived access token in memory. That keeps a long-lived credential out
 * of every request header while leaving the contract untouched.
 */
async function buildSession(
  user: Parameters<typeof toUser>[0] & { _id: Types.ObjectId },
  context: RequestContext,
): Promise<AuthSession> {
  const issued = await createSession({
    userId: user._id,
    userAgent: context.userAgent,
    ip: context.ip,
  });
  return { token: issued.refreshToken, user: toUser(user) };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export async function register(
  input: RegisterInput,
): Promise<{ pendingEmail: string }> {
  const email = normaliseEmail(input.email);

  const institution = await InstitutionModel.findById(input.institutionId);
  if (!institution || !institution.active) {
    // Covers both "does not exist" and "not launched yet". The client only
    // ever offers active institutions, so either means a tampered request.
    throw new UnprocessableError("That institution is not available yet.");
  }

  const campus = await CampusModel.findOne({
    _id: input.campusId,
    institutionId: institution._id,
    active: true,
  });
  if (!campus) {
    // Checked against the institution, not on its own: otherwise a valid
    // campus id from a DIFFERENT institution would be accepted and the account
    // would be matched into the wrong community.
    throw new UnprocessableError("That campus is not available.");
  }

  // Rule 8: students and faculty only for now. The schema carries "employee"
  // so the organisation launch does not need a migration, but it is not
  // selectable, and a request naming it is a tampered client.
  if (input.userType === "employee") {
    throw new UnprocessableError("That account type is not available yet.");
  }

  const domain = email.split("@")[1] ?? "";
  if (!institution.emailDomains.includes(domain)) {
    // The one place we are specific, because it is genuinely the user's
    // mistake and reveals nothing: they know their own address already.
    throw new ValidationError(
      `Use your ${institution.shortName ?? institution.name} email address.`,
    );
  }

  const existing = await UserModel.findOne({ email });

  if (existing?.emailVerifiedAt) {
    // Anti-enumeration. The response is identical to a fresh signup, so the
    // form cannot be used to test which addresses hold accounts. The person
    // who actually owns the address is told what happened by email — which is
    // also the only channel that can reach the real owner rather than whoever
    // typed the address in.
    logger.info("registration attempted for an existing verified account");
    await emailService()
      .sendExistingAccountNotice({ to: email, name: existing.name })
      .catch(() => {
        // Never let a mail failure change the shape of this response; that
        // would reintroduce the very signal we are hiding.
      });
    return { pendingEmail: email };
  }

  const passwordHash = await hashPassword(input.password);

  if (existing) {
    // Unverified: they abandoned signup or lost the code. Overwrite rather
    // than reject, or the address is stranded until the row is cleaned up.
    existing.set({
      name: input.name,
      passwordHash,
      phone: input.phone,
      photoUrl: input.photoUrl ?? null,
      userType: input.userType,
      institutionId: institution._id,
      campusId: campus._id,
      areaId: new Types.ObjectId(input.areaId),
    });
    await existing.save();
  } else {
    await UserModel.create({
      name: input.name,
      email,
      passwordHash,
      phone: input.phone,
      photoUrl: input.photoUrl ?? null,
      userType: input.userType,
      institutionId: institution._id,
      campusId: campus._id,
      areaId: new Types.ObjectId(input.areaId),
      badgeStatus: "none",
      role: "member",
    });
  }

  const { code, expiresInMinutes } = await issueOtp({
    email,
    purpose: "verifyEmail",
  });

  // Awaited: if the code cannot be delivered there is no point reporting
  // success, because the user has no way to continue.
  await emailService().sendVerificationCode({
    to: email,
    name: input.name,
    code,
    expiresInMinutes,
  });

  return { pendingEmail: email };
}

export async function verifyEmailOtp(
  rawEmail: string,
  code: string,
  context: RequestContext,
): Promise<AuthSession> {
  const email = normaliseEmail(rawEmail);

  await consumeOtp({ email, purpose: "verifyEmail", code });

  const user = await UserModel.findOne({ email });
  if (!user) {
    // The challenge verified but the account is gone. Nothing useful to say.
    throw new ValidationError("That code is not right, or it has expired.");
  }

  if (!user.emailVerifiedAt) {
    user.emailVerifiedAt = new Date();
    await user.save();
  }

  logger.info({ userId: user._id.toString() }, "email verified");
  return buildSession(user, context);
}

export async function resendOtp(rawEmail: string): Promise<void> {
  const email = normaliseEmail(rawEmail);
  const user = await UserModel.findOne({ email });

  // Silent when there is nothing to send. Returning early with the same void
  // response keeps this from confirming whether an address is mid-signup.
  if (!user || user.emailVerifiedAt) return;

  const { code, expiresInMinutes } = await issueOtp({
    email,
    purpose: "verifyEmail",
  });

  await emailService().sendVerificationCode({
    to: email,
    name: user.name,
    code,
    expiresInMinutes,
  });
}

// ---------------------------------------------------------------------------
// Sign-in
// ---------------------------------------------------------------------------

/**
 * Lockout state, tracked per address and per IP.
 *
 * Per address alone would let one attacker lock every account they can name.
 * Per IP alone is defeated by a botnet. Both together raise the cost of each
 * without handing anybody a denial-of-service against a specific person.
 */
async function assertNotLockedOut(email: string, ip: string): Promise<void> {
  const now = new Date();
  const locked = await LoginAttemptModel.findOne({
    $or: [
      { key: email, kind: "email" },
      { key: ip, kind: "ip" },
    ],
    lockedUntil: { $gt: now },
  });

  if (locked) {
    throw new RateLimitError(
      "Too many sign-in attempts. Try again in a few minutes.",
    );
  }
}

async function recordFailure(key: string, kind: "email" | "ip"): Promise<void> {
  const windowMs = env.LOGIN_LOCKOUT_MIN * 60 * 1000;
  const updated = await LoginAttemptModel.findOneAndUpdate(
    { key, kind },
    {
      $inc: { failures: 1 },
      $set: { expiresAt: new Date(Date.now() + windowMs * 4) },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  if (updated && updated.failures >= env.LOGIN_MAX_FAILURES) {
    updated.lockedUntil = new Date(Date.now() + windowMs);
    updated.failures = 0;
    await updated.save();
  }
}

async function clearFailures(email: string, ip: string): Promise<void> {
  await LoginAttemptModel.deleteMany({
    $or: [
      { key: email, kind: "email" },
      { key: ip, kind: "ip" },
    ],
  });
}

export async function login(
  rawEmail: string,
  password: string,
  context: RequestContext,
): Promise<AuthSession> {
  const email = normaliseEmail(rawEmail);
  const ip = context.ip ?? "unknown";

  await assertNotLockedOut(email, ip);

  const user = await UserModel.findOne({ email }).select("+passwordHash");

  // One message for every failure: wrong password, no such account,
  // unverified, suspended. Anything more specific turns the login form into a
  // tool for discovering who has an account.
  const reject = () =>
    new AuthenticationError("That email or password is not right.");

  if (!user) {
    // Still hashes, so a missing account does not return measurably faster
    // than a wrong password. Without this the timing alone reveals which
    // addresses exist.
    await verifyPassword(
      "$argon2id$v=19$m=19456,t=2,p=1$YWJjZGVmZ2hpamtsbW5vcA$0000000000000000000000000000000000000000000",
      password,
    );
    await recordFailure(email, "email");
    await recordFailure(ip, "ip");
    throw reject();
  }

  const matches = await verifyPassword(user.passwordHash, password);
  if (!matches) {
    await recordFailure(email, "email");
    await recordFailure(ip, "ip");
    throw reject();
  }

  if (!user.emailVerifiedAt) {
    // Deliberately the same error. Saying "verify your email first" would
    // confirm the account exists AND that the password was correct.
    throw reject();
  }

  if (user.suspendedAt) {
    throw reject();
  }

  await clearFailures(email, ip);
  logger.info({ userId: user._id.toString() }, "login");

  return buildSession(user, context);
}

// ---------------------------------------------------------------------------
// Password reset
// ---------------------------------------------------------------------------

export async function requestPasswordReset(rawEmail: string): Promise<void> {
  const email = normaliseEmail(rawEmail);
  const user = await UserModel.findOne({ email });

  // Always void, always the same. A reset form that behaves differently for a
  // real address is an account-discovery tool.
  if (!user || !user.emailVerifiedAt) return;

  const { code, expiresInMinutes } = await issueOtp({
    email,
    purpose: "passwordReset",
  });

  await emailService().sendPasswordReset({
    to: email,
    name: user.name,
    code,
    expiresInMinutes,
  });
}

export async function resetPassword(input: {
  email: string;
  code: string;
  password: string;
}): Promise<void> {
  const email = normaliseEmail(input.email);

  await consumeOtp({ email, purpose: "passwordReset", code: input.code });

  const user = await UserModel.findOne({ email });
  if (!user) throw new ValidationError("That code is not right, or it has expired.");

  user.passwordHash = await hashPassword(input.password);
  await user.save();

  // Every existing session dies. If the reset happened because the account was
  // compromised, leaving the attacker signed in elsewhere would defeat it.
  await revokeAllSessions(user._id, "passwordChanged");

  logger.info({ userId: user._id.toString() }, "password reset");
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

export async function logout(refreshToken: string): Promise<void> {
  await revokeSessionByToken(refreshToken);
}

/**
 * Revalidates a stored token on app launch.
 *
 * Returns null rather than throwing when the session is gone: to the client
 * that is simply "signed out", and the launch gate routes to login. An error
 * would surface as a failure screen on a perfectly ordinary expiry.
 */
export async function restore(
  refreshToken: string,
): Promise<AuthSession | null> {
  const session = await findLiveSession(refreshToken);
  if (!session) return null;

  const user = await UserModel.findById(session.userId);
  if (!user || user.suspendedAt) return null;

  session.lastUsedAt = new Date();
  await session.save();

  return { token: refreshToken, user: toUser(user) };
}

/**
 * Exchanges a refresh token for a short-lived access token.
 *
 * Not part of the client contract — the HTTP client calls it internally and
 * keeps the result in memory, so no screen ever handles it.
 */
export async function accessTokenFor(
  refreshToken: string,
): Promise<{ accessToken: string; expiresInMinutes: number }> {
  const session = await findLiveSession(refreshToken);
  if (!session) {
    throw new AuthenticationError("Your session has expired. Sign in again.");
  }

  const user = await UserModel.findById(session.userId);
  if (!user || user.suspendedAt) {
    throw new AuthenticationError("Your session has expired. Sign in again.");
  }

  const accessToken = await signAccessToken({
    sub: user._id.toString(),
    sid: session._id.toString(),
    role: user.role ?? "member",
    institutionId: user.institutionId.toString(),
  });

  return { accessToken, expiresInMinutes: env.ACCESS_TOKEN_TTL_MIN };
}
