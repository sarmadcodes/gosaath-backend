import { z } from "zod";

/**
 * Request validation.
 *
 * `.strict()` everywhere: an unknown key is rejected rather than ignored. That
 * is what stops `{"role":"superAdmin"}` riding along on a registration and
 * reaching a model that might one day spread the body.
 */

const objectId = z
  .string()
  .regex(/^[0-9a-fA-F]{24}$/, "Not a valid id");

const email = z
  .string()
  .trim()
  .toLowerCase()
  .email("Enter a valid email address")
  .max(254);

/**
 * Twelve characters, no composition rules.
 *
 * Length beats character classes: "P@ss1!" satisfies most rule sets and falls
 * to a dictionary in seconds, while a long passphrase does not. The upper
 * bound exists because Argon2 hashing time scales with input, so an
 * unbounded password is a cheap way to load the server.
 */
const password = z
  .string()
  .min(12, "Use at least 12 characters")
  .max(200, "That password is too long");

/** Pakistani mobile: 03xx xxxxxxx, with or without spacing or +92. */
const phone = z
  .string()
  .trim()
  .min(10)
  .max(20)
  .regex(/^(\+?92|0)?[\s-]?3\d{2}[\s-]?\d{7}$/, "Enter a valid mobile number");

/** Exactly six digits, as a string, so a leading zero survives. */
const otpCode = z
  .string()
  .trim()
  .regex(/^\d{6}$/, "Enter the six-digit code");

export const registerSchema = z
  .object({
    name: z.string().trim().min(2).max(120),
    email,
    password,
    phone,
    photoUrl: z.string().url().max(2000).nullish(),
    // "employee" is absent on purpose: the schema supports it for the future
    // organisation launch, the API does not accept it yet. The sign-up screen
    // shows it as "coming soon" and does not let it be chosen, so the two
    // agree — see the test that pins this.
    userType: z.enum(["student", "teacher"]),
    institutionId: objectId,
    campusId: objectId,
    areaId: objectId,
  })
  .strict();

export const verifyOtpSchema = z
  .object({ email, code: otpCode })
  .strict();

export const resendOtpSchema = z.object({ email }).strict();

export const loginSchema = z
  .object({
    email,
    // Not the `password` schema: an existing account may predate a rule
    // change, and rejecting a valid password for being too short at sign-in
    // would lock people out of their own accounts.
    password: z.string().min(1).max(200),
  })
  .strict();

export const passwordResetRequestSchema = z.object({ email }).strict();

export const passwordResetSchema = z
  .object({ email, code: otpCode, password })
  .strict();

export const refreshSchema = z
  .object({ token: z.string().min(20).max(500) })
  .strict();

export type RegisterBody = z.infer<typeof registerSchema>;
export type LoginBody = z.infer<typeof loginSchema>;
