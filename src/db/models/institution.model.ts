import { Schema, model, type InferSchemaType } from "mongoose";
import { baseOptions, centroid } from "./shared.js";

const INSTITUTION_TYPES = ["university", "college", "school", "organisation"];

/**
 * A tenant. Everything a member sees is scoped to one of these.
 *
 * `active` is the launch gate and is owned by the server. The mobile client's
 * ACTIVE_INSTITUTION_IDS constant becomes a read of this field once the Super
 * Admin panel exists — no screen changes required, since the signup flow
 * already derives its single-institution behaviour from the active list.
 */
const institutionSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 200 },
    shortName: { type: String, trim: true, maxlength: 40 },
    type: { type: String, enum: INSTITUTION_TYPES, required: true },

    /**
     * Validates institution email at registration. Stored lowercase so the
     * check is a plain comparison rather than a per-request normalisation.
     */
    emailDomains: {
      type: [String],
      default: [],
      set: (domains: string[]) =>
        domains.map((d) => d.trim().toLowerCase().replace(/^@/, "")),
    },

    city: { type: String, required: true, trim: true, maxlength: 80 },

    /** Never set directly by a route. Activation runs a checklist. */
    active: { type: Boolean, default: false, index: true },

    /**
     * Drives the entire app accent for this institution's members, so it is
     * validated rather than trusted: an invalid value would theme the app to
     * nothing.
     */
    brandColor: {
      type: String,
      required: true,
      match: /^#[0-9a-fA-F]{6}$/,
    },

    featured: { type: Boolean, default: false },

    logoMarkUrl: { type: String, default: null },
    logoWideUrl: { type: String, default: null },

    /**
     * Activation checklist. Stored rather than computed so the Super Admin
     * panel can show progress, and so "who ticked this and when" survives.
     */
    activation: {
      contacted: { type: Boolean, default: false },
      campusesConfirmed: { type: Boolean, default: false },
      emailDomainsConfirmed: { type: Boolean, default: false },
      brandColorConfirmed: { type: Boolean, default: false },
      logosUploaded: { type: Boolean, default: false },
      adminAssigned: { type: Boolean, default: false },
      enoughSignups: { type: Boolean, default: false },
      activatedAt: { type: Date, default: null },
      activatedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    },
  },
  baseOptions,
);

// Registration resolves an email domain to an institution on every signup.
institutionSchema.index({ emailDomains: 1 });
// The picker: active first, featured pinned to the top.
institutionSchema.index({ active: 1, featured: -1, name: 1 });

export type InstitutionDoc = InferSchemaType<typeof institutionSchema>;
export const InstitutionModel = model("Institution", institutionSchema, "institutions");

const campusSchema = new Schema(
  {
    institutionId: {
      type: Schema.Types.ObjectId,
      ref: "Institution",
      required: true,
    },
    name: { type: String, required: true, trim: true, maxlength: 160 },
    /** Approximate area the campus sits in. Never a precise address. */
    areaId: { type: Schema.Types.ObjectId, ref: "Area", default: null },
    active: { type: Boolean, default: true },
  },
  baseOptions,
);

campusSchema.index({ institutionId: 1, active: 1 });
// One campus name per institution; two "Main Campus" rows help nobody.
campusSchema.index({ institutionId: 1, name: 1 }, { unique: true });

export type CampusDoc = InferSchemaType<typeof campusSchema>;
export const CampusModel = model("Campus", campusSchema, "campuses");

/**
 * A user-submitted institution awaiting review.
 *
 * Deliberately a separate collection from `institutions`. Requests must never
 * be able to become live rows by a status flip — creating the institution is
 * an explicit Super Admin action.
 */
const institutionRequestSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 200 },
    type: { type: String, enum: INSTITUTION_TYPES, required: true },
    website: { type: String, trim: true, maxlength: 300 },
    campusName: { type: String, trim: true, maxlength: 160 },
    requestedByEmail: { type: String, required: true, trim: true, lowercase: true },
    status: {
      type: String,
      enum: ["pending", "approved", "rejected"],
      default: "pending",
    },
    reviewedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    reviewedAt: { type: Date, default: null },
  },
  baseOptions,
);

// The review queue, and the count of how many people asked for each.
institutionRequestSchema.index({ status: 1, createdAt: -1 });
institutionRequestSchema.index({ name: 1, status: 1 });

export type InstitutionRequestDoc = InferSchemaType<typeof institutionRequestSchema>;
export const InstitutionRequestModel = model(
  "InstitutionRequest",
  institutionRequestSchema,
  "institutionRequests",
);

/**
 * A Karachi area.
 *
 * `centroid` is geography about a neighbourhood, used only to decide what
 * counts as nearby. It is never returned to a client.
 */
const areaSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    city: { type: String, required: true, trim: true, maxlength: 80 },
    centroid: { type: centroid, required: true },
    active: { type: Boolean, default: true },
  },
  baseOptions,
);

areaSchema.index({ city: 1, active: 1 });
areaSchema.index({ city: 1, name: 1 }, { unique: true });

export type AreaDoc = InferSchemaType<typeof areaSchema>;
export const AreaModel = model("Area", areaSchema, "areas");
