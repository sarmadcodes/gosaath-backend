import { connectToDatabase, disconnectFromDatabase } from "../src/db/mongodb.js";
import { removeFile } from "../src/services/storage/index.js";
import { cancelFutureInstances } from "../src/modules/commutes/instance.service.js";
import {
  AreaMatchModel,
  AttendanceModel,
  CommuteModel,
  NotificationModel,
  PreferencesModel,
  PushTokenModel,
  RideInstanceModel,
  SeatRequestModel,
  SessionModel,
  UserModel,
  VehicleModel,
} from "../src/db/models/index.js";

/**
 * Removes one account completely, by email.
 *
 * For development and test accounts. A member closing their own account goes
 * through Settings, which anonymises rather than deletes — that path keeps a
 * row so blocks and safety decisions still mean something. This is the other
 * thing: the row itself goes, because a test account has no history anybody
 * needs.
 *
 * It does the same care the in-app deletion does, and for the same reasons.
 * A bare `deleteOne` on the user would leave their rides scheduled with
 * nobody driving, their seats counted against other people's cars, and their
 * photo sitting in Cloudinary — so the order below is not incidental.
 *
 *   npx tsx scripts/remove-account.ts someone@example.edu.pk
 *   npx tsx scripts/remove-account.ts someone@example.edu.pk --confirm
 *
 * Without --confirm it only reports. Running it by accident has to be
 * harmless, because this cannot be undone.
 */

const email = process.argv[2];
const confirmed = process.argv.includes("--confirm");

if (!email || email.startsWith("--")) {
  console.error("\n  Usage: tsx scripts/remove-account.ts <email> [--confirm]\n");
  process.exit(1);
}

await connectToDatabase();

const user = await UserModel.findOne({ email }).lean();

if (!user) {
  console.log(`\n  No account found for ${email}.\n`);
  await disconnectFromDatabase();
  process.exit(0);
}

const userId = user._id;

const commutes = await CommuteModel.find({ ownerId: userId }).select("_id").lean();
const commuteIds = commutes.map((c) => c._id);

const [
  drivingRides,
  seatsHeld,
  attendance,
  requestsSent,
  requestsReceived,
  vehicles,
  notifications,
  sessions,
  pushTokens,
] = await Promise.all([
  RideInstanceModel.countDocuments({ commuteId: { $in: commuteIds } }),
  AttendanceModel.countDocuments({
    userId,
    role: "passenger",
    status: { $in: ["confirmed", "pending"] },
  }),
  AttendanceModel.countDocuments({ userId }),
  SeatRequestModel.countDocuments({ requesterId: userId }),
  SeatRequestModel.countDocuments({ driverId: userId }),
  VehicleModel.countDocuments({ ownerId: userId }),
  NotificationModel.countDocuments({ userId }),
  SessionModel.countDocuments({ userId }),
  PushTokenModel.countDocuments({ userId }),
]);

// Who else is affected. The number that matters: these are real people with
// a seat on a ride that is about to stop existing.
const passengerIds = await AttendanceModel.distinct("userId", {
  rideInstanceId: {
    $in: await RideInstanceModel.distinct("_id", { commuteId: { $in: commuteIds } }),
  },
  role: "passenger",
  userId: { $ne: userId },
});

console.log(`
  Account        ${user.email}
  Name           ${user.name}
  Id             ${userId.toString()}
  Role           ${user.role ?? "member"}
  Photo          ${user.photoUrl ? "yes" : "none"}
  Badge document ${user.badgeDocumentUrl ? "yes" : "none"}

  Would remove
    commutes               ${commutes.length}
    ride instances         ${drivingRides}
    attendance rows        ${attendance}
    seat requests sent     ${requestsSent}
    seat requests received ${requestsReceived}
    vehicles               ${vehicles}
    notifications          ${notifications}
    sessions               ${sessions}
    push tokens            ${pushTokens}

  Seats this account holds on OTHER people's rides: ${seatsHeld}
  Other people riding on THIS account's rides:      ${passengerIds.length}
`);

if (passengerIds.length > 0) {
  console.log(
    `  Those ${passengerIds.length} passenger(s) will be told their ride is cancelled,\n` +
      `  exactly as they would be if the account were closed from Settings.\n`,
  );
}

if (!confirmed) {
  console.log("  Nothing was changed. Re-run with --confirm to remove it.\n");
  await disconnectFromDatabase();
  process.exit(0);
}

// Rides first, so passengers are told and released before the rows they
// point at disappear. Doing this after the delete would notify nobody.
for (const commuteId of commuteIds) {
  await cancelFutureInstances(commuteId, "commuteCancelled");
}

// Seats held on other people's rides go back, or those rides stay full
// forever against a passenger who no longer exists.
const held = await AttendanceModel.find({
  userId,
  role: "passenger",
  status: { $in: ["confirmed", "pending"] },
})
  .select("rideInstanceId")
  .lean();

for (const row of held) {
  await RideInstanceModel.updateOne(
    { _id: row.rideInstanceId, seatsTaken: { $gt: 0 } },
    { $inc: { seatsTaken: -1 } },
  );
}

// The files go too. Removing the account while a student card sits in a
// bucket is not removing the account.
await Promise.all([removeFile(user.photoUrl), removeFile(user.badgeDocumentUrl)]);

const rideIds = await RideInstanceModel.distinct("_id", {
  commuteId: { $in: commuteIds },
});

await AttendanceModel.deleteMany({
  $or: [{ userId }, { rideInstanceId: { $in: rideIds } }],
});
await SeatRequestModel.deleteMany({
  $or: [{ requesterId: userId }, { driverId: userId }],
});
await RideInstanceModel.deleteMany({ _id: { $in: rideIds } });
await CommuteModel.deleteMany({ _id: { $in: commuteIds } });

await Promise.all([
  VehicleModel.deleteMany({ ownerId: userId }),
  SessionModel.deleteMany({ userId }),
  PushTokenModel.deleteMany({ userId }),
  NotificationModel.deleteMany({ userId }),
  PreferencesModel.deleteMany({ userId }),
  AreaMatchModel.deleteMany({
    $or: [{ userId }, { matchedUserId: userId }],
  }),
]);

// Blocks are deliberately NOT removed, matching the in-app deletion: a block
// is a safety decision somebody else made, and clearing it because the other
// account went away hands exactly the wrong person a way around it.

await UserModel.deleteOne({ _id: userId });

console.log(`  Removed ${email}. The address is free to register again.\n`);

await disconnectFromDatabase();
