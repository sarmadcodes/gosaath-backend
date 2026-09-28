import { SeatRequestModel } from "../../db/models/index.js";

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
