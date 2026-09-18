// VENDORED FROM THE MOBILE APP — DO NOT EDIT BY HAND.
// Source: GoSaath/src/data/roles.ts
// Re-copy with `npm run contract:sync`; `npm run contract:check` fails
// CI when this drifts from the app's copy. Re-declaring these types by
// hand is how response shapes silently diverge from the client.

import type { AdminScope, Role, User } from "./types.js";

/**
 * Role and scope helpers.
 *
 * The mobile app is a member surface and barely uses these — they exist so
 * that institution scoping is a property of the model rather than something
 * the future admin panels invent for themselves.
 *
 * The hierarchy is:
 *
 *   Super Admin → Institutions → University Admin → Students / Faculty
 *
 * See SYSTEM.md section 11 for what each panel owns.
 */

export function roleOf(user: Pick<User, "role">): Role {
  return user.role ?? "member";
}

/**
 * What this user may administer.
 *
 * A university admin is scoped to their own institution and nothing else.
 * Admin queries must be built from this, never from an institution id the
 * caller supplied — otherwise scoping is one tampered request away from
 * leaking another institution's students.
 */
export function scopeOf(
  user: Pick<User, "role" | "institutionId">,
): AdminScope | null {
  switch (roleOf(user)) {
    case "superAdmin":
      return { kind: "platform" };
    case "universityAdmin":
      return { kind: "institution", institutionId: user.institutionId };
    default:
      return null;
  }
}

export function isAdmin(user: Pick<User, "role">) {
  return roleOf(user) !== "member";
}

/** Whether a scope permits acting on a given institution. */
export function scopeCovers(scope: AdminScope, institutionId: string) {
  return (
    scope.kind === "platform" ||
    (scope.kind === "institution" && scope.institutionId === institutionId)
  );
}
