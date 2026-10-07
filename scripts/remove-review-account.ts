import { connectToDatabase, disconnectFromDatabase } from "../src/db/mongodb.js";
import {
  AttendanceModel,
  CommuteModel,
  RideInstanceModel,
  SeatRequestModel,
  UserModel,
  VehicleModel,
} from "../src/db/models/index.js";

/**
 * Removes the App Review accounts once the app is approved.
 *
 * They are ordinary member accounts, so until they are gone they show up as
 * matches to real students — somebody at SZABIST would see "App Review" on
 * their matches screen and quite reasonably wonder what it is.
 *
 * Scoped to exactly two addresses and nothing else. It deletes rather than
 * anonymises because these are not people: there is no record worth keeping
 * and nobody whose history would be erased.
 */

const EMAILS = ["appreview@szabist.edu.pk", "appreview.driver@szabist.edu.pk"];

await connectToDatabase();

const users = await UserModel.find({ email: { $in: EMAILS } }).select("_id email").lean();

if (users.length === 0) {
  console.log("\n  Nothing to remove.\n");
  await disconnectFromDatabase();
  process.exit(0);
}

const ids = users.map((row) => row._id);
const commutes = await CommuteModel.find({ ownerId: { $in: ids } }).select("_id").lean();
const commuteIds = commutes.map((row) => row._id);
const rides = await RideInstanceModel.find({ commuteId: { $in: commuteIds } })
  .select("_id")
  .lean();
const rideIds = rides.map((row) => row._id);

// Also any seat the reviewer took on somebody else's ride, which would
// otherwise leave a passenger row pointing at an account that no longer exists.
await AttendanceModel.deleteMany({ userId: { $in: ids } });
await SeatRequestModel.deleteMany({
  $or: [{ requesterId: { $in: ids } }, { driverId: { $in: ids } }],
});
await AttendanceModel.deleteMany({ rideInstanceId: { $in: rideIds } });
await RideInstanceModel.deleteMany({ _id: { $in: rideIds } });
await CommuteModel.deleteMany({ _id: { $in: commuteIds } });
await VehicleModel.deleteMany({ ownerId: { $in: ids } });
await UserModel.deleteMany({ _id: { $in: ids } });

console.log(`\n  Removed: ${users.map((u) => u.email).join(", ")}\n`);

await disconnectFromDatabase();
