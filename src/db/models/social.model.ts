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

// ---------------------------------------------------------------------------
// Trip shares
// ---------------------------------------------------------------------------

/**
 * A link that lets somebody outside GoSaath see one ride.
 *
 * The point is accountability: a passenger tells a parent or a friend which
 * car they are in and when they should be somewhere, so that somebody would
 * notice if they were not.
 *
 * **It is not tracking, and it cannot become tracking.** There is no position
 * in this document and none in the response it drives — the viewer sees the
 * facts of a scheduled journey, which are the same facts the passenger could
 * have typed into a message themselves. GoSaath holds no live location for
 * anybody, so there is nothing here for a link to leak.
 *
 * The token is stored hashed. A link is a bearer credential handed to somebody
 * with no account, so a database dump must not be a stack of working links —
 * exactly the reasoning applied to session refresh tokens.
 */
const tripShareSchema = new Schema(
  {
    rideInstanceId: { type: Schema.Types.ObjectId, ref: "RideInstance", required: true },
    /** The passenger or driver who shared it, and who alone may revoke it. */
    sharedByUserId: { type: Schema.Types.ObjectId, ref: "User", required: true },

    /** SHA-256 of the token. The token itself is returned once and never stored. */
    tokenHash: { type: String, required: true, select: false },

    /**
     * When the link stops working.
     *
     * Always set, and never far out: a share is for one journey. A link that
     * outlives the ride is a link somebody forgot about, still answering
     * questions about where a person goes on a Monday morning.
     */
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date, default: null },

    /** So the sharer can see whether anybody actually opened it. */
    viewCount: { type: Number, default: 0 },
    lastViewedAt: { type: Date, default: null },
  },
  baseOptions,
);

tripShareSchema.index({ tokenHash: 1 }, { unique: true });
tripShareSchema.index({ sharedByUserId: 1, createdAt: -1 });
/**
 * Removed by Mongo once expired, a day after the fact.
 *
 * The row has no further purpose, and a table of who told whom about which
 * journey is not something to keep for its own sake.
 */
tripShareSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 24 * 60 * 60 });

export type TripShareDoc = InferSchemaType<typeof tripShareSchema>;
export const TripShareModel = model("TripShare", tripShareSchema, "tripShares");

// ---------------------------------------------------------------------------
// Safety alerts
// ---------------------------------------------------------------------------

/**
 * Somebody pressed the help button.
 *
 * Deliberately a record and a notification, not a dispatch. GoSaath cannot
 * send anybody help: it has no control room, no phone line and no position for
 * the person who pressed it. What it can honestly do is tell the institution's
 * administrators immediately, keep an auditable record, and put the real
 * emergency numbers one tap from the dialer — which the phone, not the app,
 * then calls.
 *
 * Pretending to do more than that would be the most dangerous feature in the
 * product: somebody in trouble deciding not to call 15 because an app told
 * them help was coming.
 */
const safetyAlertSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    institutionId: { type: Schema.Types.ObjectId, ref: "Institution", required: true },
    /** The ride it was raised during, when there was one. */
    rideInstanceId: {
      type: Schema.Types.ObjectId,
      ref: "RideInstance",
      default: null,
    },

    kind: {
      type: String,
      enum: ["sos", "feelingUnsafe"],
      required: true,
    },
    /** What the person typed, if anything. Never required: typing takes time. */
    note: { type: String, default: null, maxlength: 2000 },

    status: {
      type: String,
      enum: ["open", "acknowledged", "closed"],
      default: "open",
    },
    acknowledgedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    acknowledgedAt: { type: Date, default: null },
    closedAt: { type: Date, default: null },
    /** What an administrator did about it. Read by nobody but administrators. */
    resolution: { type: String, default: null, maxlength: 2000 },
  },
  baseOptions,
);

/** The admin safety queue: open first, newest first. */
safetyAlertSchema.index({ institutionId: 1, status: 1, createdAt: -1 });
safetyAlertSchema.index({ userId: 1, createdAt: -1 });

export type SafetyAlertDoc = InferSchemaType<typeof safetyAlertSchema>;
export const SafetyAlertModel = model("SafetyAlert", safetyAlertSchema, "safetyAlerts");
