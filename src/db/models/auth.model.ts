import { Schema, model, type InferSchemaType } from "mongoose";
import { baseOptions } from "./shared.js";

/**
 * A one-time code, for email verification or password reset.
 *
 * Keyed on the email address rather than a user id, because a verification
 * challenge exists before the account is confirmed and a reset challenge must
 * not reveal whether an account exists at all.
 */
const otpChallengeSchema = new Schema(
  {
    email: { type: String, required: true, lowercase: true, trim: true },
    purpose: {
      type: String,
      enum: ["verifyEmail", "passwordReset"],
      required: true,
    },

    /** Argon2id. The plain code exists only in the email that was sent. */
    codeHash: { type: String, required: true, select: false },

    /**
     * Wrong guesses. Six digits is a small keyspace, so this — not the
     * entropy — is what actually stops a brute force. The challenge is burned
     * at the limit rather than throttled, so an attacker cannot simply wait.
     */
    attempts: { type: Number, default: 0 },

    /** How many times a code has been sent, to bound resend abuse. */
    sendCount: { type: Number, default: 1 },
    lastSentAt: { type: Date, default: Date.now },

    expiresAt: { type: Date, required: true },
    /** Set the moment a code is accepted, so it can never be reused. */
    consumedAt: { type: Date, default: null },
  },
  baseOptions,
);

/**
 * One live challenge per address per purpose.
 *
 * Without this, requesting a second code would leave the first one valid, and
 * an attacker could farm several simultaneously live codes to widen the
 * keyspace they are guessing against.
 */
otpChallengeSchema.index({ email: 1, purpose: 1 }, { unique: true });

/**
 * Mongo removes expired challenges on its own.
 *
 * A TTL index rather than a cleanup job: this is the one kind of expiry the
 * database can enforce without us remembering to run anything, and a stale
 * challenge left lying around is a code that still works.
 */
otpChallengeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export type OtpChallengeDoc = InferSchemaType<typeof otpChallengeSchema>;
export const OtpChallengeModel = model(
  "OtpChallenge",
  otpChallengeSchema,
  "otpChallenges",
);

/**
 * A signed-in device.
 *
 * The refresh token lives here as a digest. Access tokens are short-lived
 * JWTs and are not stored — checking one is a signature verification, not a
 * database read, which is what keeps authenticated requests cheap.
 */
const sessionSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },

    /** SHA-256 of the refresh token. The token itself is never stored. */
    refreshTokenHash: { type: String, required: true },

    /**
     * Rotation chain.
     *
     * Each refresh mints a new token and points the old row here. If a token
     * that was already rotated is presented again, it was captured — the whole
     * chain is then revoked, because we cannot tell the thief from the
     * legitimate device and the safe answer is to sign both out.
     */
    replacedBySessionId: {
      type: Schema.Types.ObjectId,
      ref: "Session",
      default: null,
    },

    revokedAt: { type: Date, default: null },
    revokedReason: {
      type: String,
      enum: ["logout", "rotated", "reuseDetected", "passwordChanged", "admin"],
      default: null,
    },

    expiresAt: { type: Date, required: true },
    lastUsedAt: { type: Date, default: Date.now },

    /** Shown in a future "signed-in devices" screen. Never used for auth. */
    userAgent: { type: String, default: null },
    ip: { type: String, default: null },
  },
  baseOptions,
);

sessionSchema.index({ refreshTokenHash: 1 }, { unique: true });
sessionSchema.index({ userId: 1, revokedAt: 1 });
// Expired sessions clear themselves out.
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export type SessionDoc = InferSchemaType<typeof sessionSchema>;
export const SessionModel = model("Session", sessionSchema, "sessions");

/**
 * Failed sign-in attempts, for lockout.
 *
 * Recorded per address AND per IP. Per address alone lets one attacker lock
 * every account they know of; per IP alone is defeated by a botnet. Both
 * together raise the cost of each without handing anyone a denial-of-service
 * against a specific person.
 */
const loginAttemptSchema = new Schema(
  {
    key: { type: String, required: true },
    kind: { type: String, enum: ["email", "ip"], required: true },
    failures: { type: Number, default: 0 },
    lockedUntil: { type: Date, default: null },
    expiresAt: { type: Date, required: true },
  },
  baseOptions,
);

loginAttemptSchema.index({ key: 1, kind: 1 }, { unique: true });
loginAttemptSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export type LoginAttemptDoc = InferSchemaType<typeof loginAttemptSchema>;
export const LoginAttemptModel = model(
  "LoginAttempt",
  loginAttemptSchema,
  "loginAttempts",
);

/**
 * An invitation to administer.
 *
 * The only way a role is ever granted. The token is emailed and stored as a
 * SHA-256 digest; it is single-use, expires, and can be revoked. Receiving it
 * at the invited address is what proves ownership of that address, which is
 * why an invited administrator can register into an institution that is not
 * yet live — the one exception to the active-institution rule, and only for
 * the person named on the invitation.
 */
const adminInvitationSchema = new Schema(
  {
    email: { type: String, required: true, lowercase: true, trim: true },
    institutionId: { type: Schema.Types.ObjectId, ref: "Institution", required: true },
    role: { type: String, enum: ["universityAdmin", "superAdmin"], required: true },
    tokenHash: { type: String, required: true, select: false },
    invitedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    expiresAt: { type: Date, required: true },
    acceptedAt: { type: Date, default: null },
    acceptedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    revokedAt: { type: Date, default: null },
  },
  baseOptions,
);

adminInvitationSchema.index({ tokenHash: 1 }, { unique: true });
adminInvitationSchema.index({ email: 1, acceptedAt: 1, revokedAt: 1 });
adminInvitationSchema.index({ institutionId: 1, createdAt: -1 });

export type AdminInvitationDoc = InferSchemaType<typeof adminInvitationSchema>;
export const AdminInvitationModel = model(
  "AdminInvitation",
  adminInvitationSchema,
  "adminInvitations",
);
