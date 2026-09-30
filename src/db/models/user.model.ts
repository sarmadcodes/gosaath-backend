import { Schema, model, type InferSchemaType } from "mongoose";
import { baseOptions } from "./shared.js";

/**
 * A person. The only document that holds credentials.
 *
 * `passwordHash` carries `select: false`, so it is excluded from every query
 * unless explicitly asked for. That makes leaking it require a deliberate act
 * rather than a forgotten projection.
 */
const userSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },

    // Normalised on write. Without this, "User@szabist.edu.pk" and
    // "user@szabist.edu.pk" become two accounts and the unique index
    // cheerfully allows it.
    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      maxlength: 254,
    },
    emailVerifiedAt: { type: Date, default: null },

    passwordHash: { type: String, required: true, select: false },

    phone: { type: String, required: true, trim: true, maxlength: 24 },

    photoUrl: { type: String, default: null },

    userType: {
      type: String,
      enum: ["student", "teacher", "employee"],
      required: true,
    },

    institutionId: { type: Schema.Types.ObjectId, ref: "Institution", required: true },
    campusId: { type: Schema.Types.ObjectId, ref: "Campus", required: true },

    /**
     * Approximate home area. The ONLY location this product stores for a
     * person — no address, no coordinates, at any time.
     */
    areaId: { type: Schema.Types.ObjectId, ref: "Area", required: true },

    badgeStatus: {
      type: String,
      enum: ["none", "pending", "approved", "rejected"],
      default: "none",
    },

    /**
     * Proof submitted for the optional badge.
     *
     * select:false — it is an identity document, and it has no business
     * appearing in any response that merely happens to load a user. Only the
     * verification queue asks for it, explicitly.
     */
    badgeDocumentUrl: { type: String, default: null, select: false },
    badgeRequestedAt: { type: Date, default: null },
    badgeReviewedAt: { type: Date, default: null },
    badgeReviewedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    badgeRejectionReason: { type: String, default: null },

    additionalInstitutionIds: {
      type: [{ type: Schema.Types.ObjectId, ref: "Institution" }],
      default: [],
    },

    /**
     * Platform role, separate from `userType`.
     *
     * `userType` is what someone is at their institution; `role` is what they
     * may administer. A university admin is still a commuter, and this field
     * must never affect matching.
     */
    role: {
      type: String,
      enum: ["member", "universityAdmin", "superAdmin"],
      default: "member",
      // Indexed: admin listings filter on it, members never do.
      index: true,
    },

    suspendedAt: { type: Date, default: null },
    suspendedReason: { type: String, default: null },

    /**
     * When the person closed their account.
     *
     * The row survives deletion, emptied of anything personal. Reports,
     * blocks and audit entries point at a user id, and a hard delete would
     * either break those or erase a safety record — which would make deleting
     * your account the way to erase what you did. `suspendedAt` is set at the
     * same time, which is what actually locks the account out, through the
     * same check a suspension uses.
     */
    deletedAt: { type: Date, default: null },
  },
  baseOptions,
);

// One account per address. The application also normalises, but the database
// is what actually guarantees it under concurrent registration.
userSchema.index({ email: 1 }, { unique: true });

// The matching hot path and every admin member listing.
userSchema.index({ institutionId: 1, campusId: 1 });
userSchema.index({ institutionId: 1, createdAt: -1 });

// The verification queue.
userSchema.index({ institutionId: 1, badgeStatus: 1 });

/**
 * The admin directory's own query.
 *
 * It filters on verified-and-not-deleted and pages backwards through _id.
 * Without this, listing members at a hundred thousand accounts is a
 * collection scan per page — fine against a seeded database of three, and
 * not fine in production.
 */
userSchema.index({ deletedAt: 1, emailVerifiedAt: 1, _id: -1 });
userSchema.index({ badgeStatus: 1, badgeRequestedAt: 1 });

export type UserDoc = InferSchemaType<typeof userSchema>;
export const UserModel = model("User", userSchema, "users");
