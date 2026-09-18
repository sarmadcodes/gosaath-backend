import { env } from "../../config/env.js";
import { logger } from "../../utils/logger.js";
import { RateLimitError, ValidationError } from "../../utils/errors.js";
import { generateOtp, hashOtp, verifyOtp } from "../../utils/crypto.js";
import { OtpChallengeModel } from "../../db/models/index.js";

/**
 * One-time codes.
 *
 * A six-digit code carries about twenty bits, which would fall to a script in
 * seconds on its own. The protection is not the code — it is everything around
 * it: a short expiry, a hard attempt limit that burns the challenge rather
 * than throttling it, a bounded number of resends, and a cooldown between
 * them.
 */

export type OtpPurpose = "verifyEmail" | "passwordReset";

/**
 * Creates or refreshes a challenge and returns the plain code.
 *
 * The plain code is returned to exactly one caller — the service that hands it
 * to the email provider. It is never stored, logged, or included in any
 * response.
 */
export async function issueOtp(input: {
  email: string;
  purpose: OtpPurpose;
}): Promise<{ code: string; expiresInMinutes: number }> {
  const email = input.email.trim().toLowerCase();
  const now = Date.now();

  const existing = await OtpChallengeModel.findOne({
    email,
    purpose: input.purpose,
  });

  if (existing && !existing.consumedAt) {
    const sinceLastSend = now - existing.lastSentAt.getTime();
    const cooldownMs = env.OTP_RESEND_COOLDOWN_SEC * 1000;

    if (sinceLastSend < cooldownMs) {
      const waitSeconds = Math.ceil((cooldownMs - sinceLastSend) / 1000);
      throw new RateLimitError(
        `Wait ${waitSeconds} seconds before asking for another code.`,
      );
    }

    // Bounded resends. Without this, an attacker could keep a challenge alive
    // forever and farm codes against one address indefinitely.
    if (existing.sendCount >= env.OTP_MAX_SENDS) {
      throw new RateLimitError(
        "Too many codes requested. Try again in a little while.",
      );
    }
  }

  const code = generateOtp();
  const codeHash = await hashOtp(code);
  const expiresAt = new Date(now + env.OTP_TTL_MIN * 60 * 1000);

  // Upsert, because the unique index guarantees one live challenge per address
  // and purpose. Issuing a second code must invalidate the first, not leave
  // two valid codes widening the keyspace an attacker is guessing against.
  await OtpChallengeModel.findOneAndUpdate(
    { email, purpose: input.purpose },
    {
      $set: {
        codeHash,
        expiresAt,
        consumedAt: null,
        attempts: 0,
        lastSentAt: new Date(now),
      },
      $inc: { sendCount: existing && !existing.consumedAt ? 1 : 0 },
      $setOnInsert: { email, purpose: input.purpose },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  logger.info(
    { purpose: input.purpose, expiresInMinutes: env.OTP_TTL_MIN },
    "otp issued",
  );

  return { code, expiresInMinutes: env.OTP_TTL_MIN };
}

/**
 * Checks a code and consumes it on success.
 *
 * Throws on every failure path with the same message. Distinguishing "no such
 * challenge" from "wrong code" would confirm whether an address is mid-signup,
 * and distinguishing "expired" from "wrong" tells an attacker whether to keep
 * guessing.
 */
export async function consumeOtp(input: {
  email: string;
  purpose: OtpPurpose;
  code: string;
}): Promise<void> {
  const email = input.email.trim().toLowerCase();

  const challenge = await OtpChallengeModel.findOne({
    email,
    purpose: input.purpose,
  }).select("+codeHash");

  const invalid = () =>
    new ValidationError("That code is not right, or it has expired.");

  if (!challenge || challenge.consumedAt) throw invalid();

  if (challenge.expiresAt.getTime() <= Date.now()) {
    await challenge.deleteOne();
    throw invalid();
  }

  if (challenge.attempts >= env.OTP_MAX_ATTEMPTS) {
    // Burned, not throttled. Throttling lets an attacker simply wait; deleting
    // the challenge forces them back through the resend cooldown and the send
    // limit, which is where the real cost is.
    await challenge.deleteOne();
    throw new RateLimitError(
      "Too many incorrect attempts. Ask for a new code.",
    );
  }

  const matches = await verifyOtp(challenge.codeHash, input.code);

  if (!matches) {
    // Counted atomically: several wrong guesses arriving at once must each be
    // recorded, or a burst of parallel requests would get far more tries than
    // the limit allows.
    const updated = await OtpChallengeModel.findOneAndUpdate(
      { _id: challenge._id },
      { $inc: { attempts: 1 } },
      { new: true },
    );
    if (updated && updated.attempts >= env.OTP_MAX_ATTEMPTS) {
      await updated.deleteOne();
    }
    throw invalid();
  }

  // Deleted rather than flagged. Nothing needs a spent challenge, and a row
  // that still holds a code hash is a row that can leak one.
  await challenge.deleteOne();

  logger.info({ purpose: input.purpose }, "otp consumed");
}

/** Clears a challenge, e.g. when an account is removed. */
export async function clearOtp(email: string, purpose: OtpPurpose): Promise<void> {
  await OtpChallengeModel.deleteOne({
    email: email.trim().toLowerCase(),
    purpose,
  });
}
