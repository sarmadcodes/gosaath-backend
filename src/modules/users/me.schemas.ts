import { z } from "zod";

/**
 * Request validation for the authenticated user's own record.
 *
 * The contract types `me.update` as `Partial<User>`, which includes `role`,
 * `institutionId`, `campusId` and `badgeStatus`. Taken literally that is a
 * privilege-escalation endpoint, so the server decides what is writable here
 * rather than trusting the shape.
 */

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, "Not a valid id");

/**
 * The only fields a member may change about themselves.
 *
 * Everything else on the record is set at registration or by an admin.
 * `.strict()` means an unknown or forbidden key is a 400 rather than something
 * quietly dropped — silent dropping hides the attempt, and an attacker probing
 * for what sticks learns nothing from a 200 that ignored them.
 */
export const updateMeSchema = z
  .object({
    name: z.string().trim().min(2).max(120).optional(),
    phone: z
      .string()
      .trim()
      .min(10)
      .max(20)
      .regex(/^(\+?92|0)?[\s-]?3\d{2}[\s-]?\d{7}$/, "Enter a valid mobile number")
      .optional(),
    /** Area only. There is no address, latitude or longitude to change. */
    areaId: objectId.optional(),
    photoUrl: z.string().url().max(2000).nullish(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "Nothing to update",
  });

/**
 * A storage key, not a URL.
 *
 * The client uploads first and hands back the key it was given. Accepting a
 * URL would let anyone point their profile photo at any address on the
 * internet, which is both an outbound request we make on their behalf and a
 * way to serve something we never saw.
 */
const storageKey = z
  .string()
  .min(3)
  .max(300)
  .regex(/^[a-z]+s\/[0-9a-f]{24}\/[A-Za-z0-9._-]+$/, "Not a valid upload");

export const setPhotoSchema = z.object({ key: storageKey.nullable() }).strict();

export const requestBadgeSchema = z.object({ key: storageKey }).strict();

export const institutionIdSchema = z
  .object({ institutionId: objectId })
  .strict();

export type UpdateMeBody = z.infer<typeof updateMeSchema>;

/**
 * Closing the account.
 *
 * The password is re-checked rather than trusted from the session: the
 * session proves the phone was unlocked at some point, not that the person
 * holding it now means to delete the account.
 */
export const deleteAccountSchema = z
  .object({ password: z.string().min(1, "Enter your password") })
  .strict();
