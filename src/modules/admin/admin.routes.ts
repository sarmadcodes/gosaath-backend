import { InstitutionModel, UserModel } from "../../db/models/index.js";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  requireAdmin,
  requireAdminContext,
  requireSuperAdmin,
} from "../../middleware/admin.js";
import { listAudit } from "../audit/audit.service.js";

/**
 * Admin foundation.
 *
 * Only two routes so far, deliberately: who am I as an admin, and the audit
 * log. The University Admin and Super Admin surfaces build on these guards;
 * nothing admin-facing exists that does not go through them.
 */

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, "Not a valid id");

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  /**
   * The caller's role and scope, as the server sees them.
   *
   * The admin panels render from this rather than from the token claims, so a
   * demoted admin's panel reflects it on the next load.
   */
  app.get("/admin/me", { preHandler: requireAdmin }, async (request) => {
    const admin = requireAdminContext(request);

    // Who the panel says you are, and which institution you are acting
    // inside. Both are read here rather than held in the client, so a panel
    // left open overnight cannot keep showing a scope that has since changed.
    const user = await UserModel.findById(admin.userId)
      .select("name email institutionId")
      .lean();

    const institution =
      admin.scope.kind === "institution"
        ? await InstitutionModel.findById(admin.scope.institutionId)
            .select("name shortName")
            .lean()
        : null;

    return {
      data: {
        userId: admin.userId,
        role: admin.role,
        scope: admin.scope,
        name: user?.name ?? "Administrator",
        email: user?.email ?? "",
        institutionName: institution?.shortName ?? institution?.name ?? "GoSaath platform",
      },
    };
  });

  /**
   * The full audit log. Platform administrators only.
   *
   * A university admin does not see this — it spans every institution, and
   * their own actions are recorded in it rather than reviewed through it.
   */
  app.get("/admin/audit", { preHandler: requireSuperAdmin }, async (request) => {
    const query = z
      .object({
        action: z.string().max(80).optional(),
        actorUserId: objectId.optional(),
        institutionId: objectId.optional(),
        before: objectId.optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      })
      .strict()
      .parse(request.query);

    const page = await listAudit(query);
    return { data: page.entries, meta: { nextCursor: page.nextCursor } };
  });
}
