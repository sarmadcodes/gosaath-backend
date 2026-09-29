import { AttendanceModel, SeatRequestModel } from "../../db/models/index.js";

/**
 * Who may see whose phone number.
 *
 * SYSTEM.md §4.5.3: "Phone numbers exchanged only after a request is
 * accepted." Being matched is not enough — a match is the system's guess that
 * two timetables line up, made without either person agreeing to anything.
 * Handing over a number at that point gives every student at the campus the
 * phone number of every other student whose hours overlap theirs.
 *
 * Acceptance is what both sides consented to, so acceptance is the gate.
 * Either direction counts: the person who asked and the person who said yes
 * both need to be able to reach each other.
 *
 * Kept in its own module rather than inside the seat-request service so that
 * matching can ask the question without importing the request machinery.
 */
export async function acceptedContactIds(
  userId: string,
  candidateIds: readonly { toString(): string }[],
): Promise<Set<string>> {
  if (candidateIds.length === 0) return new Set();

  const ids = candidateIds.map((id) => id.toString());

  const accepted = await SeatRequestModel.find({
    status: "accepted",
    $or: [
      { requesterId: userId, driverId: { $in: ids } },
      { driverId: userId, requesterId: { $in: ids } },
    ],
  })
    .select("requesterId driverId")
    .lean();

  const allowed = new Set<string>();
  for (const request of accepted) {
    const requester = request.requesterId.toString();
    const driver = request.driverId.toString();
    allowed.add(requester === userId ? driver : requester);
  }
  return allowed;
}

/**
 * A number plate, shown only as far as the viewer has earned it.
 *
 * SYSTEM.md 4.5.4: "Vehicle plate masked until confirmed." Browsing a list of
 * rides must not hand over the plate of every car at a campus — that is a
 * register of who drives what, assembled by anyone with an account.
 *
 * Once a seat is confirmed the full plate is exactly what the passenger
 * needs: identifying the right car at the kerb, in the dark, is the entire
 * safety value of a plate. Withholding it there would be privacy theatre at
 * the passenger's expense.
 */
export function maskPlate(plate: string): string {
  const trimmed = plate.trim();
  // Keep the alphabetical prefix ("BKT-512" → "BKT-••••"): enough to tell two
  // cars apart at a glance, not enough to identify one from a list.
  //
  // The mask is a fixed four characters whatever the plate's real length.
  // Varying it would publish how many digits each plate has, which narrows a
  // guess for no benefit to anyone looking at a car.
  const match = /^([A-Za-z]{1,3})[\s-]?(.*)$/.exec(trimmed);
  if (!match || !match[2]) return "•••";
  return `${match[1]!.toUpperCase()}-••••`;
}

/**
 * Which ride instances the caller has a confirmed seat on.
 *
 * Attendance rather than the seat request: attendance is what accepting a
 * request writes, and it is also how a driver's own ride is recorded.
 */
export async function confirmedRideIds(
  userId: string,
  rideInstanceIds: readonly { toString(): string }[],
): Promise<Set<string>> {
  if (rideInstanceIds.length === 0) return new Set();

  const rows = await AttendanceModel.find({
    userId,
    rideInstanceId: { $in: rideInstanceIds.map((id) => id.toString()) },
    status: { $in: ["confirmed", "pending"] },
  })
    .select("rideInstanceId")
    .lean();

  return new Set(rows.map((row) => row.rideInstanceId.toString()));
}
