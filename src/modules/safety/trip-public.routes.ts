import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { readSharedTrip } from "./trip-share.service.js";

/**
 * The one public, unauthenticated read in the product.
 *
 * Registered as its own plugin precisely so that is visible. Everything else
 * member-facing sits behind an `authenticate` hook; putting this route in the
 * same file would mean exempting it from that hook, and an exemption is the
 * kind of thing that gets copied by the next route added below it.
 *
 * The token is the authorisation. What it unlocks is deliberately small — see
 * `readSharedTrip` — and it expires with the journey it describes.
 */
export async function publicTripRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/t/:token",
    {
      /**
       * Tight, and keyed on the caller's address.
       *
       * A 43-character token is not guessable in any practical sense, but this
       * endpoint answers "is this token real" to anybody on the internet, so
       * it should not also be a fast oracle for asking it repeatedly.
       */
      config: { rateLimit: { max: 30, timeWindow: "5 minutes" } },
    },
    async (request, reply) => {
      const { token } = z
        .object({ token: z.string().min(20).max(200) })
        .parse(request.params);

      const trip = await readSharedTrip(token);

      // Never cached by anything in between. A shared trip is revocable, and a
      // CDN or proxy holding a copy would keep answering after it was revoked.
      return reply
        .header("Cache-Control", "no-store, private")
        // Not indexed. A link sent to one person should not become a search
        // result about where somebody travels.
        .header("X-Robots-Tag", "noindex, nofollow, noarchive")
        .send({ data: trip });
    },
  );
}
