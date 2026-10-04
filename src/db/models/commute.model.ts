import { Schema, model, type InferSchemaType } from "mongoose";
import { baseOptions, daySchedule, WEEKDAY_VALUES } from "./shared.js";

/**
 * Commute → RideInstance → Attendance.
 *
 * Three collections, never collapsed into one. The shortcut is to hang riders
 * off the Commute and be done; the moment a driver says "not this Thursday"
 * that model cannot express the exception without editing the template, which
 * silently changes every other week too.
 */

// ---------------------------------------------------------------------------
// Commute — the recurring template. Has NO dates.
// ---------------------------------------------------------------------------

const commuteSchema = new Schema(
  {
    ownerId: { type: Schema.Types.ObjectId, ref: "User", required: true },

    intent: { type: String, enum: ["find", "offer", "both"], required: true },

    // Denormalised from the owner rather than joined. Matching filters on these
    // on every query, and a $lookup into users to read them would turn the hot
    // path into a join. Kept in step when a user moves institution.
    institutionId: { type: Schema.Types.ObjectId, ref: "Institution", required: true },
    campusId: { type: Schema.Types.ObjectId, ref: "Campus", required: true },
    originAreaId: { type: Schema.Types.ObjectId, ref: "Area", required: true },

    /**
     * One entry per day travelled. The days are implied by which entries
     * exist — there is deliberately no second `days` array to fall out of sync
     * with this one.
     */
    schedule: {
      type: [daySchedule],
      required: true,
      validate: {
        validator: (entries: { day: string }[]) => {
          if (entries.length === 0 || entries.length > 7) return false;
          // A duplicated weekday would make "does Monday match?" ambiguous.
          return new Set(entries.map((e) => e.day)).size === entries.length;
        },
        message: "schedule must hold 1–7 entries, one per weekday",
      },
    },

    direction: {
      type: String,
      enum: ["going", "returning", "both"],
      required: true,
    },

    // Only meaningful when intent includes offering.
    vehicleId: { type: Schema.Types.ObjectId, ref: "Vehicle", default: null },
    seatsOffered: { type: Number, min: 0, max: 8, default: null },
    /**
     * Guidance, not a limit: a hop across one area and a run in from Malir are
     * both legitimate, so any non-negative amount is accepted.
     */
    contribution: { type: Number, min: 0, max: 100000, default: null },

    womenOnly: { type: Boolean, default: false },

    status: {
      type: String,
      enum: ["active", "paused", "cancelled"],
      default: "active",
    },
  },
  baseOptions,
);

// THE match query. Order matters: institution and campus are equality filters
// and must lead so the index is selective before status narrows it.
commuteSchema.index({ institutionId: 1, campusId: 1, status: 1 });
commuteSchema.index({ ownerId: 1, status: 1 });

export type CommuteDoc = InferSchemaType<typeof commuteSchema>;
export const CommuteModel = model("Commute", commuteSchema, "commutes");

// ---------------------------------------------------------------------------
// RideInstance — one concrete calendar date, expanded from a template.
// ---------------------------------------------------------------------------

const rideInstanceSchema = new Schema(
  {
    commuteId: { type: Schema.Types.ObjectId, ref: "Commute", required: true },
    driverId: { type: Schema.Types.ObjectId, ref: "User", required: true },

    /**
     * Local midnight in Asia/Karachi, stored as UTC.
     *
     * Anchored to midnight so a date is a single value rather than a range,
     * which is what makes {commuteId, date} a usable unique key.
     */
    date: { type: Date, required: true },
    day: { type: String, enum: WEEKDAY_VALUES, required: true },

    arriveBy: { type: String, default: null },
    leaveCampusAt: { type: String, default: null },

    status: {
      type: String,
      enum: ["scheduled", "cancelled", "noDriver", "completed"],
      default: "scheduled",
    },

    /**
     * Why the driver could not make it, in their own words.
     *
     * Kept for the record and for an administrator looking at a pattern of
     * dropped rides. Deliberately NOT sent to passengers: they are told the
     * ride is off and shown cover, which is what they can act on. A reason
     * typed in a hurry is between the driver and the people who run the
     * service, not broadcast to everyone who had a seat.
     */
    unavailableReason: { type: String, default: null, maxlength: 500 },

    /**
     * Capacity, held here rather than on the Commute.
     *
     * Seats are a property of one day: a driver with a full car on Monday may
     * have space on Wednesday. Acceptance increments `seatsTaken` atomically,
     * guarded against `seatsOffered`.
     */
    seatsOffered: { type: Number, min: 0, max: 8, default: 0 },
    seatsTaken: { type: Number, min: 0, default: 0 },

    /**
     * What the scheduler has already done to this ride.
     *
     * Each marker is set in the same guarded update that performs the work,
     * with the marker's own absence as the filter. That is what makes the
     * scheduler safe to run every few minutes, twice at once, or again after
     * a restart: the second attempt matches nothing, so nobody is reminded
     * twice about the same ride.
     */
    autoConfirmedAt: { type: Date, default: null },
    orphanNotifiedAt: { type: Date, default: null },
    remindedDayBeforeAt: { type: Date, default: null },
    remindedAtDepartureAt: { type: Date, default: null },
  },
  baseOptions,
);

/**
 * The idempotency guarantee for instance generation.
 *
 * Two workers racing — a cron and a lazy read, or two PM2 processes — must
 * produce one row. Upsert plus this index is what makes the job safe to run
 * twice, rather than a hopeful "check then insert".
 */
rideInstanceSchema.index({ commuteId: 1, date: 1 }, { unique: true });
rideInstanceSchema.index({ date: 1, status: 1 });
rideInstanceSchema.index({ driverId: 1, date: 1 });

export type RideInstanceDoc = InferSchemaType<typeof rideInstanceSchema>;
export const RideInstanceModel = model("RideInstance", rideInstanceSchema, "rideInstances");

// ---------------------------------------------------------------------------
// Attendance — one person on one instance.
// ---------------------------------------------------------------------------

const attendanceSchema = new Schema(
  {
    rideInstanceId: { type: Schema.Types.ObjectId, ref: "RideInstance", required: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    role: { type: String, enum: ["driver", "passenger"], required: true },

    status: {
      type: String,
      enum: ["confirmed", "pending", "skipped", "cancelled", "noDriver"],
      default: "confirmed",
    },
  },
  baseOptions,
);

// Prevents a double seat from a retried request. The database enforces it, not
// the application — a mobile client on a flaky connection will retry.
attendanceSchema.index({ rideInstanceId: 1, userId: 1 }, { unique: true });
attendanceSchema.index({ userId: 1, status: 1 });

export type AttendanceDoc = InferSchemaType<typeof attendanceSchema>;
export const AttendanceModel = model("Attendance", attendanceSchema, "attendance");
