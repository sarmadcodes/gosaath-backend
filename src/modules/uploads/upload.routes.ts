import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { authenticate, requireUser } from "../../middleware/authenticate.js";
import { readUrlFor, signUpload, storageProvider } from "../../services/storage/index.js";
import { UserModel } from "../../db/models/index.js";
import { LocalStorageProvider } from "../../services/storage/local.provider.js";
import { NotFoundError } from "../../utils/errors.js";

/**
 * Uploads.
 *
 * The client asks for permission, uploads straight to storage, then tells us
 * the key. Bytes never pass through this server in production — a 2 MB photo
 * relayed through the API is a memory spike and an event-loop stall per
 * upload, to reach the same bucket.
 *
 * The exception is the local-disk provider used in development, which has to
 * receive the bytes somewhere. That route verifies the same signature the
 * provider issued, so it is not an open upload endpoint even locally.
 */

const signSchema = z
  .object({
    kind: z.enum(["photo", "badge"]),
    contentType: z.string().min(3).max(100),
    bytes: z.number().int().positive(),
  })
  .strict();

export async function uploadRoutes(app: FastifyInstance): Promise<void> {
  app.register(async (authed) => {
    authed.addHook("preHandler", authenticate);

    authed.post(
      "/uploads/sign",
      {
        // Each call reserves a key and costs a signature. Generous enough for
        // a retry or two, tight enough that nobody scripts it.
        config: { rateLimit: { max: 30, timeWindow: "10 minutes" } },
      },
      async (request) => {
        const body = signSchema.parse(request.body);
        const target = await signUpload({
          kind: body.kind,
          userId: requireUser(request).id,
          contentType: body.contentType,
          bytes: body.bytes,
        });
        return { data: target };
      },
    );

    /**
     * A member's photo.
     *
     * Behind authentication, and redirected to a short-lived signed URL
     * rather than proxied: the bytes still come from storage, and the link
     * the browser follows expires. A stable address here is what lets a
     * serialised user carry a photo URL with no deadline attached.
     *
     * Any signed-in member may fetch any member's photo, which is what a
     * photo shown on a match card already means. Nothing else about the
     * person is returned.
     */
    authed.get("/photos/:userId", async (request, reply) => {
      const { userId } = z
        .object({ userId: z.string().regex(/^[0-9a-fA-F]{24}$/) })
        .parse(request.params);

      const user = await UserModel.findById(userId).select("photoUrl deletedAt").lean();
      if (!user?.photoUrl || user.deletedAt) {
        throw new NotFoundError("No photo.");
      }

      const url = await readUrlFor(user.photoUrl);
      if (!url) throw new NotFoundError("No photo.");

      // Not cached by anything shared: the URL behind it is per-request and
      // the photo is not public.
      return reply.header("Cache-Control", "private, max-age=300").redirect(url, 302);
    });
  });

  /**
   * Development only: receives and serves the bytes for the local provider.
   *
   * Unauthenticated by design — the signature in the query string is the
   * authorisation, exactly as it would be with a presigned S3 URL. It is
   * scoped to one key, one purpose and a few minutes.
   */
  const provider = storageProvider();
  if (!(provider instanceof LocalStorageProvider)) return;

  const querySchema = z.object({ exp: z.coerce.number(), sig: z.string() });

  // The bytes arrive as themselves, not JSON. Capped at the largest thing any
  // kind allows, so this route cannot be used to post something enormous.
  app.addContentTypeParser("*", { parseAs: "buffer", bodyLimit: 12 * 1024 * 1024 },
    (_request, body, done) => {
      done(null, body);
    },
  );

  app.put("/files/*", async (request, reply) => {
    const key = (request.params as { "*": string })["*"];
    const { exp, sig } = querySchema.parse(request.query);

    if (!provider.verify(key, exp, "put", sig)) {
      // Deliberately a 404: an expired or forged signature should not confirm
      // that the key exists.
      throw new NotFoundError("That upload link is no longer valid.");
    }

    const body = request.body;
    if (!Buffer.isBuffer(body)) {
      throw new NotFoundError("That upload link is no longer valid.");
    }

    await provider.put(key, body, request.headers["content-type"] ?? "application/octet-stream");
    return reply.code(200).send({ data: { key } });
  });

  app.get("/files/*", async (request, reply) => {
    const key = (request.params as { "*": string })["*"];
    const { exp, sig } = querySchema.parse(request.query);

    if (!provider.verify(key, exp, "get", sig)) {
      throw new NotFoundError("That link is no longer valid.");
    }

    const file = await provider.read(key).catch(() => null);
    if (!file) throw new NotFoundError("That file was not found.");

    return reply.type(file.contentType).send(file.body);
  });
}
