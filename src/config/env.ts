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
    JWT_SECRET: z.string().min(32).optional(),
  })
  .superRefine((value, ctx) => {
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
