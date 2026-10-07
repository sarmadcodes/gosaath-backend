import { connectToDatabase, disconnectFromDatabase } from "../src/db/mongodb.js";
import { hashPassword } from "../src/utils/crypto.js";
import {
  AreaModel,
  AttendanceModel,
  CampusModel,
  CommuteModel,
  InstitutionModel,
  RideInstanceModel,
  SeatRequestModel,
  UserModel,
  VehicleModel,
} from "../src/db/models/index.js";
import { generateInstancesFor } from "../src/modules/commutes/instance.service.js";

/**
 * The account App Review signs in with.
 *
 * Sign-up is closed to anybody without a verified university email, and it
 * confirms the address with an emailed code — so a reviewer cannot create an
 * account, and an app they cannot get into is an app they reject. This makes
 * one for them.
 *
 * **No code is ever involved.** The one-time code belongs to registration;
 * signing in is email and password. This account is created already verified,
 * so the reviewer types the two things in the App Store Connect form and is
 * straight into the app.
 *
 * It also creates somebody for them to match with. An account with no match,
 * no request and no ride is three empty screens, and a reviewer cannot assess
 * what they cannot see — the usual outcome is "we were unable to locate the
 * features described".
 *
 * Safe to run more than once: everything is keyed on the two addresses and
 * rebuilt from scratch each time, so a half-finished run can simply be redone.
 */

const REVIEWER = {
  email: "appreview@szabist.edu.pk",
  name: "App Review",
  phone: "0300 0000001",
};

const COUNTERPART = {
  email: "appreview.driver@szabist.edu.pk",
  name: "Hamza Siddiqui",
  phone: "0300 0000002",
};

// Long enough for the password rule, and free of characters that are
// ambiguous when read off a screen or retyped by somebody else.
const PASSWORD = "GoSaathReview2026";

const SCHEDULE = [
  { day: "Mon", arriveBy: "08:00", leaveCampusAt: "17:00" },
  { day: "Tue", arriveBy: "08:00", leaveCampusAt: "17:00" },
  { day: "Wed", arriveBy: "08:00", leaveCampusAt: "17:00" },
  { day: "Thu", arriveBy: "08:00", leaveCampusAt: "17:00" },
];

await connectToDatabase();

const institution = await InstitutionModel.findOne({ key: "inst-szabist" }).lean();
const campus = await CampusModel.findOne({ key: "camp-szabist-clifton" }).lean();
const area = await AreaModel.findOne({ key: "area-gulshan" }).lean();

if (!institution || !campus || !area) {
  console.error("\n  Reference data missing. Run `npm run db:seed` first.\n");
  await disconnectFromDatabase();
  process.exit(1);
}

const emails = [REVIEWER.email, COUNTERPART.email];

// Torn down and rebuilt rather than patched. A half-created reviewer account
// from an interrupted run is worse than none: it signs in and then shows
// nothing, which looks like a broken app rather than a broken script.
const previous = await UserModel.find({ email: { $in: emails } }).select("_id").lean();
const previousIds = previous.map((row) => row._id);

if (previousIds.length > 0) {
  const commutes = await CommuteModel.find({ ownerId: { $in: previousIds } })
    .select("_id")
    .lean();
  const commuteIds = commutes.map((row) => row._id);
  const rides = await RideInstanceModel.find({ commuteId: { $in: commuteIds } })
    .select("_id")
    .lean();
  const rideIds = rides.map((row) => row._id);

  await AttendanceModel.deleteMany({ rideInstanceId: { $in: rideIds } });
  await SeatRequestModel.deleteMany({ rideInstanceId: { $in: rideIds } });
  await RideInstanceModel.deleteMany({ _id: { $in: rideIds } });
  await CommuteModel.deleteMany({ _id: { $in: commuteIds } });
  await VehicleModel.deleteMany({ ownerId: { $in: previousIds } });
  await UserModel.deleteMany({ _id: { $in: previousIds } });
}

const passwordHash = await hashPassword(PASSWORD);

async function account(person: typeof REVIEWER) {
  return UserModel.create({
    name: person.name,
    email: person.email,
    passwordHash,
    phone: person.phone,
    userType: "student",
    institutionId: institution!._id,
    campusId: campus!._id,
    areaId: area!._id,
    // Already confirmed, so no code is ever requested. This is the whole
    // point of the script.
    emailVerifiedAt: new Date(),
    badgeStatus: "approved",
    badgeReviewedAt: new Date(),
  });
}

const reviewer = await account(REVIEWER);
const driver = await account(COUNTERPART);

// The counterpart drives, so the reviewer has something to find.
const car = await VehicleModel.create({
  ownerId: driver._id,
  type: "car",
  model: "Toyota Corolla",
  plate: "BKT-512",
  colour: "White",
});

const offered = await CommuteModel.create({
  ownerId: driver._id,
  intent: "offer",
  institutionId: institution._id,
  campusId: campus._id,
  originAreaId: area._id,
  schedule: SCHEDULE,
  direction: "both",
  vehicleId: car._id,
  seatsOffered: 3,
  contribution: 300,
  womenOnly: false,
  status: "active",
});

const wanted = await CommuteModel.create({
  ownerId: reviewer._id,
  intent: "find",
  institutionId: institution._id,
  campusId: campus._id,
  originAreaId: area._id,
  schedule: SCHEDULE,
  direction: "both",
  womenOnly: false,
  status: "active",
});

// Rides to look at. Without these the week is empty and so is every screen
// that reads from it.
await generateInstancesFor(offered._id);
await generateInstancesFor(wanted._id);

console.log(
  `
  App Review account ready.

      email     ${REVIEWER.email}
      password  ${PASSWORD}

  No code is needed: the account is already verified, and signing in is
  email and password. Codes only ever appear during registration.

  ${COUNTERPART.name} (${COUNTERPART.email}) exists alongside it, offering
  three seats on the same four days, so the reviewer sees a real match rather
  than an empty screen. Same password.

  Both are ordinary member accounts and will appear to other SZABIST members
  as matches. Delete them once the app is approved:

      npm run db:review:remove
`,
);

await disconnectFromDatabase();
