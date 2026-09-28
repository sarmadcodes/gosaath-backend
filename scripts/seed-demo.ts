import { connectToDatabase, disconnectFromDatabase } from "../src/db/mongodb.js";
import { env } from "../src/config/env.js";
import { hashPassword } from "../src/utils/crypto.js";
import {
  AreaModel,
  AttendanceModel,
  CampusModel,
  CommuteModel,
  InstitutionModel,
  NotificationModel,
  RideInstanceModel,
  SeatRequestModel,
  SessionModel,
  UserModel,
  VehicleModel,
} from "../src/db/models/index.js";
import { generateInstancesFor } from "../src/modules/commutes/instance.service.js";

/**
 * Two demo accounts that match each other on exactly two days.
 *
 *   Ayesha — looking for a ride
 *   Bilal  — offering three seats
 *
 * Same institution (SZABIST), same campus (Clifton), same area
 * (Gulshan-e-Iqbal). Their timetables share Mon, Tue and Wed, but Tuesday is
 * four hours apart, so only Monday and Wednesday fall inside the 30-minute
 * matching window.
 *
 * Running it again RESETS both accounts — commutes, rides, requests,
 * notifications — so a test can always start from the same place. It never
 * touches any other account, and refuses to run in production.
 */

if (env.isProduction) {
  console.error("Refusing to create demo accounts in production.");
  process.exit(1);
}

export const DEMO_PASSWORD = "GoSaathDemo2026";

const DEMO = {
  finder: {
    name: "Ayesha Khan",
    email: "ayesha.demo@szabist.pk",
    phone: "0300 1112233",
    schedule: [
      { day: "Mon", arriveBy: "08:00", leaveCampusAt: "17:00" },
      { day: "Tue", arriveBy: "10:00", leaveCampusAt: "16:00" },
      { day: "Wed", arriveBy: "08:00", leaveCampusAt: "17:00" },
      { day: "Thu", arriveBy: "12:00", leaveCampusAt: "18:00" },
    ],
  },
  offerer: {
    name: "Bilal Ahmed",
    email: "bilal.demo@szabist.pk",
    phone: "0321 4445566",
    schedule: [
      { day: "Mon", arriveBy: "08:00", leaveCampusAt: "17:00" },
      { day: "Tue", arriveBy: "14:00", leaveCampusAt: "19:00" },
      { day: "Wed", arriveBy: "08:15", leaveCampusAt: "17:00" },
      { day: "Fri", arriveBy: "09:00", leaveCampusAt: "15:00" },
    ],
  },
} as const;

await connectToDatabase();

const institution = await InstitutionModel.findOne({ key: "inst-szabist" }).lean();
const campus = await CampusModel.findOne({ key: "camp-szabist-clifton" }).lean();
const area = await AreaModel.findOne({ key: "area-gulshan" }).lean();

if (!institution || !campus || !area) {
  console.error("Reference data missing. Run `npm run db:seed` first.");
  await disconnectFromDatabase();
  process.exit(1);
}

const passwordHash = await hashPassword(DEMO_PASSWORD);

// --- Reset anything left from a previous run ------------------------------

const existing = await UserModel.find({
  email: { $in: [DEMO.finder.email, DEMO.offerer.email] },
})
  .select("_id")
  .lean();
const ids = existing.map((u) => u._id);

if (ids.length > 0) {
  const commutes = await CommuteModel.find({ ownerId: { $in: ids } }).select("_id").lean();
  const instances = await RideInstanceModel.find({
    commuteId: { $in: commutes.map((c) => c._id) },
  })
    .select("_id")
    .lean();

  await Promise.all([
    AttendanceModel.deleteMany({ $or: [{ userId: { $in: ids } }, { rideInstanceId: { $in: instances.map((i) => i._id) } }] }),
    SeatRequestModel.deleteMany({ $or: [{ requesterId: { $in: ids } }, { driverId: { $in: ids } }] }),
    NotificationModel.deleteMany({ userId: { $in: ids } }),
    SessionModel.deleteMany({ userId: { $in: ids } }),
    VehicleModel.deleteMany({ ownerId: { $in: ids } }),
  ]);
  await RideInstanceModel.deleteMany({ _id: { $in: instances.map((i) => i._id) } });
  await CommuteModel.deleteMany({ ownerId: { $in: ids } });
  await UserModel.deleteMany({ _id: { $in: ids } });
}

// --- Create both accounts ---------------------------------------------------

async function createAccount(person: { name: string; email: string; phone: string }) {
  return UserModel.create({
    name: person.name,
    email: person.email,
    passwordHash,
    phone: person.phone,
    userType: "student",
    institutionId: institution!._id,
    campusId: campus!._id,
    areaId: area!._id,
    badgeStatus: "none",
    role: "member",
    emailVerifiedAt: new Date(),
  });
}

const ayesha = await createAccount(DEMO.finder);
const bilal = await createAccount(DEMO.offerer);

const car = await VehicleModel.create({
  ownerId: bilal._id,
  type: "car",
  model: "Toyota Corolla GLi",
  plate: "BKT-512",
  colour: "White",
});

await CommuteModel.create({
  ownerId: ayesha._id,
  intent: "find",
  institutionId: institution._id,
  campusId: campus._id,
  originAreaId: area._id,
  schedule: DEMO.finder.schedule,
  direction: "both",
  womenOnly: false,
  status: "active",
});

const offer = await CommuteModel.create({
  ownerId: bilal._id,
  intent: "offer",
  institutionId: institution._id,
  campusId: campus._id,
  originAreaId: area._id,
  schedule: DEMO.offerer.schedule,
  direction: "both",
  vehicleId: car._id,
  seatsOffered: 3,
  contribution: 300,
  womenOnly: false,
  status: "active",
});

// Bilal's rides for the next two weeks, so Ayesha has something to request.
const generated = await generateInstancesFor(offer._id);

console.log(`
  Demo accounts ready (${env.MONGODB_DB})

  Password for both:  ${DEMO_PASSWORD}

  Ayesha Khan  ${DEMO.finder.email}   looking for a ride
  Bilal Ahmed  ${DEMO.offerer.email}    offering 3 seats · Rs 300 · Toyota Corolla

  Both: SZABIST · Clifton Campus · Gulshan-e-Iqbal
  They match on Mon and Wed. Tue is shared but 4 hours apart.
  Bilal has ${generated.created} upcoming rides.

  Run this again at any time to reset both accounts.
`);

await disconnectFromDatabase();
