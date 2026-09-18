import type { FastifyInstance, FastifyRequest } from "fastify";
import * as auth from "./auth.service.js";
import {
  loginSchema,
  passwordResetRequestSchema,
  passwordResetSchema,
  refreshSchema,
  registerSchema,
  resendOtpSchema,
  verifyOtpSchema,
} from "./auth.schemas.js";

/**
 * Auth endpoints.
 *
 * Every route here carries its own rate limit, far tighter than the global
 * floor. These are the endpoints worth attacking: they are where passwords are
 * guessed, codes are brute-forced and addresses are enumerated.
 */

function context(request: FastifyRequest) {
  const userAgent = request.headers["user-agent"];
  return {
    userAgent: typeof userAgent === "string" ? userAgent.slice(0, 300) : undefined,
    ip: request.ip,
  };
}

/** Per-IP, since none of these routes has an authenticated caller yet. */
const limit = (max: number, timeWindow: string) => ({
  config: { rateLimit: { max, timeWindow } },
});

export async function authRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Creating an account sends an email, so the limit is low: without one this
   * is a free mail cannon pointed at any address an attacker chooses.
   */
  app.post("/register", limit(5, "10 minutes"), async (request) => {
    const body = registerSchema.parse(request.body);
    const result = await auth.register(body);
    return { data: result };
  });

  /**
   * Tighter than the OTP attempt limit itself, so the network is exhausted
   * before the challenge is. Guessing six digits needs volume, and this is
   * where volume is stopped.
   */
  app.post("/verify-otp", limit(10, "10 minutes"), async (request) => {
    const body = verifyOtpSchema.parse(request.body);
    const session = await auth.verifyEmailOtp(
      body.email,
      body.code,
      context(request),
    );
    return { data: session };
  });

  app.post("/resend-otp", limit(5, "10 minutes"), async (request, reply) => {
    const body = resendOtpSchema.parse(request.body);
    await auth.resendOtp(body.email);
    // 204 whatever happened. A different response for an unknown address
    // would turn this into an account-discovery endpoint.
    return reply.code(204).send();
  });

  app.post("/login", limit(10, "5 minutes"), async (request) => {
    const body = loginSchema.parse(request.body);
    const session = await auth.login(
      body.email,
      body.password,
      context(request),
    );
    return { data: session };
  });

  app.post("/password-reset/request", limit(5, "15 minutes"), async (request, reply) => {
    const body = passwordResetRequestSchema.parse(request.body);
    await auth.requestPasswordReset(body.email);
    return reply.code(204).send();
  });

  app.post("/password-reset", limit(10, "15 minutes"), async (request, reply) => {
    const body = passwordResetSchema.parse(request.body);
    await auth.resetPassword(body);
    return reply.code(204).send();
  });

  /**
   * Exchanges the stored refresh token for a short-lived access token.
   *
   * Not in the client contract: the HTTP client calls it internally and keeps
   * the access token in memory, so no screen ever handles one. Called on every
   * cold start and whenever an access token expires, hence the higher ceiling.
   */
  app.post("/refresh", limit(60, "5 minutes"), async (request) => {
    const body = refreshSchema.parse(request.body);
    const result = await auth.accessTokenFor(body.token);
    return { data: result };
  });

  /**
   * Revalidates a stored session on launch.
   *
   * Returns `{ data: null }` rather than 401 when the session is gone: to the
   * app that is simply "signed out", and an error would surface as a failure
   * screen on an entirely ordinary expiry.
   */
  app.post("/restore", limit(60, "5 minutes"), async (request) => {
    const body = refreshSchema.parse(request.body);
    const session = await auth.restore(body.token);
    return { data: session };
  });

  app.post("/logout", limit(30, "5 minutes"), async (request, reply) => {
    const body = refreshSchema.parse(request.body);
    await auth.logout(body.token);
    // Idempotent: logging out twice, or with a token already revoked, is a
    // no-op rather than an error the client has to special-case.
    return reply.code(204).send();
  });
}
