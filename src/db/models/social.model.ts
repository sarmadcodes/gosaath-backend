import { Schema, model, type InferSchemaType } from "mongoose";
import { baseOptions } from "./shared.js";

// ---------------------------------------------------------------------------
// Seat requests
// ---------------------------------------------------------------------------

const seatRequestSchema = new Schema(
  {
    rideInstanceId: { type: Schema.Types.ObjectId, ref: "RideInstance", required: true },
    requesterId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    driverId: { type: Schema.Types.ObjectId, ref: "User", required: true },

    seats: { type: Number, min: 1, max: 4, default: 1 },

    /**
     * Transitions are enforced in the service, not here: only pending may
     * become accepted or declined. A declined request must never be revived
     * into an accepted one by a replayed request.
     */
    status: {
      type: String,
      enum: ["pending", "accepted", "declined", "cancelled"],
      default: "pending",
    },
    respondedAt: { type: Date, default: null },
  },
  baseOptions,
);

// The two lists the Rides tab shows. They are not interchangeable: one is a
// to-do list, the other a waiting list.
seatRequestSchema.index({ driverId: 1, status: 1, createdAt: -1 });
seatRequestSchema.index({ requesterId: 1, status: 1, createdAt: -1 });

// One outstanding request per person per ride. Without this, a double tap or a
// network retry queues the same person twice and the driver sees them twice.
seatRequestSchema.index({ rideInstanceId: 1, requesterId: 1 }, { unique: true });

export type SeatRequestDoc = InferSchemaType<typeof seatRequestSchema>;
export const SeatRequestModel = model("SeatRequest", seatRequestSchema, "seatRequests");

// ---------------------------------------------------------------------------
// Vehicles
// ---------------------------------------------------------------------------

const vehicleSchema = new Schema(
  {
    ownerId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    type: { type: String, enum: ["car", "bike"], required: true },
    model: { type: String, required: true, trim: true, maxlength: 120 },
    plate: { type: String, required: true, trim: true, uppercase: true, maxlength: 24 },
    colour: { type: String, required: true, trim: true, maxlength: 40 },
    /** One image showing the front of the vehicle and the plate. */
    imageUrl: { type: String, default: null },
  },
  baseOptions,
);

vehicleSchema.index({ ownerId: 1 });

export type VehicleDoc = InferSchemaType<typeof vehicleSchema>;
export const VehicleModel = model("Vehicle", vehicleSchema, "vehicles");

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

/**
 * A block. Silent, and bidirectional for discovery.
 *
 * The blocked person is never told, and cannot infer it: they simply stop
 * seeing the blocker anywhere. Both indexes exist because every match and
 * search query must exclude blocks in BOTH directions, which means looking up
 * by blocker and by blocked.
 */
const blockSchema = new Schema(
  {
    blockerId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    blockedId: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  baseOptions,
);

blockSchema.index({ blockerId: 1, blockedId: 1 }, { unique: true });
blockSchema.index({ blockedId: 1 });

export type BlockDoc = InferSchemaType<typeof blockSchema>;
export const BlockModel = model("Block", blockSchema, "blocks");

// ---------------------------------------------------------------------------
// Area match decisions
// ---------------------------------------------------------------------------

/**
 * Whether the viewer accepts the other person's area.
 *
 * Server-side rather than on the device: a rejection must survive a reinstall
 * and apply on every device, otherwise somebody the user dismissed reappears.
 */
const areaMatchSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    matchedUserId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    status: { type: String, enum: ["accepted", "rejected"], required: true },
  },
  baseOptions,
);

areaMatchSchema.index({ userId: 1, matchedUserId: 1 }, { unique: true });

export type AreaMatchDoc = InferSchemaType<typeof areaMatchSchema>;
export const AreaMatchModel = model("AreaMatch", areaMatchSchema, "areaMatches");

// ---------------------------------------------------------------------------
// Reports and support
// ---------------------------------------------------------------------------

const reportSchema = new Schema(
  {
    reporterId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    reportedUserId: { type: Schema.Types.ObjectId, ref: "User", default: null },
    /** Denormalised so moderation can be scoped without joining users. */
    institutionId: { type: Schema.Types.ObjectId, ref: "Institution", required: true },

    category: { type: String, required: true, trim: true, maxlength: 60 },
    detail: { type: String, trim: true, maxlength: 4000 },

    status: {
      type: String,
      enum: ["open", "dismissed", "warned", "suspended", "escalated"],
      default: "open",
    },
    handledBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    handledAt: { type: Date, default: null },
  },
  baseOptions,
);

reportSchema.index({ institutionId: 1, status: 1, createdAt: -1 });
// The cross-institution repeat-offender view, for Super Admin.
reportSchema.index({ reportedUserId: 1, createdAt: -1 });

export type ReportDoc = InferSchemaType<typeof reportSchema>;
export const ReportModel = model("Report", reportSchema, "reports");

/**
 * Help and complaints. Separate from reports on purpose: a genuine safety
 * report must not queue behind "I forgot my password".
 */
const supportRequestSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", default: null },
    email: { type: String, required: true, trim: true, lowercase: true },
    category: { type: String, required: true, trim: true, maxlength: 60 },
    message: { type: String, required: true, trim: true, maxlength: 8000 },
    /** Short and readable: the user quotes this when following up. */
    reference: { type: String, required: true },
    status: {
      type: String,
      enum: ["open", "answered", "closed"],
      default: "open",
    },
  },
  baseOptions,
);

supportRequestSchema.index({ reference: 1 }, { unique: true });
supportRequestSchema.index({ status: 1, createdAt: -1 });

export type SupportRequestDoc = InferSchemaType<typeof supportRequestSchema>;
export const SupportRequestModel = model(
  "SupportRequest",
  supportRequestSchema,
  "supportRequests",
);
