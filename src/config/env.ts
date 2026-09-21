import { config as loadDotenv } from "dotenv";
import { z } from "zod";

/**
 * Environment configuration.
 *
 * Parsed and validated once at startup. A missing or malformed value fails the
 * process immediately rather than surfacing as an undefined halfway through a
 * request — the brief's §85: never let production boot on development config.
 */

loadDotenv();

const Environment = z.enum(["development", "test", "staging", "production"]);

/**
 * An optional value that may be present but blank.
 *
 * `.env` files carry empty keys as documentation — `RESEND_API_KEY=` says "this
 * exists, fill it in". Zod sees a present empty string and fails `.min()`,
 * so without this the documented default in .env.example refuses to boot.
 */
const optionalSecret = (minLength: number) =>
  z.preprocess(
    (value) =>
      typeof value === "string" && value.trim() === "" ? undefined : value,
    z.string().min(minLength).optional(),
  );

const schema = z
  .object({
    NODE_ENV: Environment.default("development"),
    PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    HOST: z.string().default("0.0.0.0"),

    /** Everything recurring is interpreted in this zone. Never the server's. */
    TZ: z.string().default("Asia/Karachi"),

    MONGODB_URI: z.string().min(1),
    MONGODB_DB: z.string().min(1).default("gosaath"),
    /** Pool ceiling. Sized to the deployment, not left to the driver default. */
    MONGODB_POOL_SIZE: z.coerce.number().int().min(1).max(200).default(20),

    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),
    /** Human-readable logs locally; JSON everywhere else. */
    LOG_PRETTY: z.coerce.boolean().default(false),

    /**
     * Comma-separated exact origins. Never "*" for an authenticated API —
     * the brief's §81.
     */
    CORS_ORIGINS: z.string().default(""),

    BODY_LIMIT_BYTES: z.coerce.number().int().default(256 * 1024),
    REQUEST_TIMEOUT_MS: z.coerce.number().int().default(20_000),

    /** Minimum length is a guard against a placeholder reaching production. */
    JWT_SECRET: optionalSecret(32),

    // --- Auth -------------------------------------------------------------
    /** Short. A stolen access token should stop working quickly. */
    ACCESS_TOKEN_TTL_MIN: z.coerce.number().int().min(1).max(1440).default(15),
    /** Long: this is what keeps somebody signed in between app launches. */
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(60),
    OTP_TTL_MIN: z.coerce.number().int().min(1).max(60).default(10),
    /** Wrong guesses before the challenge is burned. */
    OTP_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
    /** Codes per challenge, to bound resend abuse. */
    OTP_MAX_SENDS: z.coerce.number().int().min(1).max(20).default(5),
    OTP_RESEND_COOLDOWN_SEC: z.coerce.number().int().min(5).max(600).default(60),
    LOGIN_MAX_FAILURES: z.coerce.number().int().min(3).max(50).default(10),
    LOGIN_LOCKOUT_MIN: z.coerce.number().int().min(1).max(1440).default(15),

    /** Where admin invitation links point. The admin panel's own origin. */
    ADMIN_PANEL_URL: z.string().url().default("http://localhost:5173"),

    // --- Email ------------------------------------------------------------
    /**
     * "resend" sends real mail. "console" writes the message to the log and
     * is the default in development, so the OTP flow is fully exercisable
     * without a provider or a real inbox.
     */
    EMAIL_PROVIDER: z.enum(["resend", "console"]).default("console"),
    RESEND_API_KEY: optionalSecret(1),
    /** Must be a verified sender on the Resend domain. */
    EMAIL_FROM: z.string().default("GoSaath <onboarding@resend.dev>"),
    EMAIL_REPLY_TO: optionalSecret(1),
    /** Hard ceiling on the provider call. Registration waits on this. */
    EMAIL_TIMEOUT_MS: z.coerce.number().int().min(1000).max(30_000).default(8_000),
  })
  .superRefine((value, ctx) => {
    // A provider selected without its credential fails at the first send,
    // which in practice means the first user to register. Fail at boot.
    if (value.EMAIL_PROVIDER === "resend" && !value.RESEND_API_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["RESEND_API_KEY"],
        message: "RESEND_API_KEY is required when EMAIL_PROVIDER is resend",
      });
    }
    // Secrets are optional while the auth module does not exist yet, but must
    // never be optional once this runs anywhere real.
    if (value.NODE_ENV === "production" || value.NODE_ENV === "staging") {
      if (!value.JWT_SECRET) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["JWT_SECRET"],
          message: "JWT_SECRET is required outside development",
        });
      }
      if (value.EMAIL_PROVIDER === "console") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["EMAIL_PROVIDER"],
          message:
            "EMAIL_PROVIDER must be a real provider outside development — " +
            "console would silently swallow every verification email",
        });
      }
      if (!value.CORS_ORIGINS.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["CORS_ORIGINS"],
          message:
            "CORS_ORIGINS must list explicit origins outside development",
        });
      }
    }
  });

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const detail = parsed.error.issues
    .map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("\n");
  // Deliberately not the logger: the logger is configured from this.
  process.stderr.write(`Invalid environment configuration:\n${detail}\n`);
  process.exit(1);
}

const value = parsed.data;

// Recurring schedules are local wall-clock times in one fixed zone. Reading
// the host's zone is how a container in UTC silently shifts everyone's
// commute by five hours.
process.env.TZ = value.TZ;

export const env = {
  ...value,
  isProduction: value.NODE_ENV === "production",
  isDevelopment: value.NODE_ENV === "development",
  isTest: value.NODE_ENV === "test",
  corsOrigins: value.CORS_ORIGINS.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
} as const;

export type Env = typeof env;
