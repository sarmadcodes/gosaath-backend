import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requestAdminCode, verifyAdminCode } from "./admin-auth.service.js";

/**
 * Administrator sign-in.
 *
 * Unauthenticated, and therefore the two most attackable routes in the system:
 * one sends mail on demand, the other guesses a six-digit code against an
 * account that can read an entire institution. Both carry their own limits,
 * far below the global floor.
 */

const emailSchema = z
  .object({
    email: z.string().trim().toLowerCase().email("That does not look like an email address.").max(200),
  })
  .strict();

const verifySchema = z
  .object({
    email: z.string().trim().toLowerCase().email().max(200),
    // Exactly six digits. A code of another shape has not been mistyped, it
    // has been generated, so it is refused before touching the challenge and
    // spending one of its attempts.
    code: z.string().regex(/^\d{6}$/, "Enter the six-digit code."),
  })
  .strict();

export async function adminAuthRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Asks for a code.
   *
   * Always 202, with the same body, whoever asked. An administrator gets an
   * email; a member, an unknown address and an address inside its resend
   * cooldown get nothing, and none of the four can be told apart. The console
   * says "if that address is an administrator, a code is on its way" because
   * that is precisely what the server is willing to state.
   *
   * Five per fifteen minutes: enough for somebody who mistyped their address
   * and did not get the mail, not enough to point at a mailbox as a nuisance.
   */
  app.post(
    "/admin/auth/code",
    { config: { rateLimit: { max: 5, timeWindow: "15 minutes" } } },
    async (request, reply) => {
      const { email } = emailSchema.parse(request.body);
      await requestAdminCode(email, { request });
      return reply.code(202).send({
        data: { sent: true, expiresInMinutes: 10 },
      });
    },
  );

  /**
   * Spends a code for a session.
   *
   * Ten per fifteen minutes per address, on top of the challenge's own attempt
   * ceiling, which burns the code after five wrong guesses. The two limits do
   * different jobs: the challenge stops a code being walked through, and this
   * stops a script cycling fresh challenges to get five guesses each.
   *
   * Returns the refresh token only. The access token comes from /auth/refresh
   * like everywhere else, so there is one place minting them.
   */
  app.post(
    "/admin/auth/verify",
    { config: { rateLimit: { max: 10, timeWindow: "15 minutes" } } },
    async (request) => {
      const { email, code } = verifySchema.parse(request.body);
      const { token, role } = await verifyAdminCode(email, code, { request });
      return { data: { token, role } };
    },
  );
}
