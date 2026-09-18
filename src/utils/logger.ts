import { pino } from "pino";
import { env } from "../config/env.js";

/**
 * Structured logging.
 *
 * Redaction is declared here rather than left to each call site, because a
 * secret only has to be logged once. The paths below cover every shape a
 * credential arrives in: headers, bodies, and the fields our own handlers
 * attach.
 */
const redact = [
  // Credentials in transit.
  "req.headers.authorization",
  "req.headers.cookie",
  'req.headers["x-api-key"]',
  "res.headers['set-cookie']",

  // Secrets, wherever they are nested. These words never name anything worth
  // keeping in a log, so the wildcard is safe.
  "*.password",
  "*.passwordHash",
  "*.otp",
  "*.accessToken",
  "*.refreshToken",
  "*.resetToken",
  "*.pushToken",
  "password",
  "passwordHash",
  "otp",

  // Scoped to the request body on purpose. `code` and `token` are wildcarded
  // nowhere: `code` is overwhelmingly a Mongo or HTTP error code, and blanket
  // redaction of it turns every database failure into "[redacted]" — blind
  // exactly when the log matters most. The OTP and any bearer token only ever
  // arrive from the client, so covering the body covers the real exposure.
  "req.body.code",
  "req.body.token",
  "req.body.secret",
];

export const logger = pino({
  level: env.LOG_LEVEL,
  redact: { paths: redact, censor: "[redacted]" },
  base: { service: "gosaath-backend", env: env.NODE_ENV },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    // Ship the level as a word. Numeric levels are unreadable in a log search
    // at the moment somebody actually needs them.
    level: (label) => ({ level: label }),
  },
  ...(env.LOG_PRETTY
    ? {
        transport: {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "HH:MM:ss.l" },
        },
      }
    : {}),
});

export type Logger = typeof logger;
