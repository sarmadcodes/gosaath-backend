import { connectToDatabase, disconnectFromDatabase } from "../src/db/mongodb.js";
import { env } from "../src/config/env.js";
import { hashPassword } from "../src/utils/crypto.js";
import {
  AreaModel,
  CampusModel,
  InstitutionModel,
  UserModel,
} from "../src/db/models/index.js";

/**
 * A university admin for the SZABIST pilot, for development.
 *
 * In production an admin arrives by invitation from a platform admin, which
 * is the only path into an institution. This exists so the panel can be run
 * and tested locally without standing up that flow first, and it refuses to
 * run in production for exactly that reason.
 */

if (env.isProduction) {
  console.error("Refusing to create an admin account in production.");
  process.exit(1);
}

const EMAIL = "admin.demo@szabist.pk";
const PASSWORD = "GoSaathAdmin2026";

await connectToDatabase();

const institution = await InstitutionModel.findOne({ key: "inst-szabist" }).lean();
const campus = await CampusModel.findOne({ key: "camp-szabist-clifton" }).lean();
const area = await AreaModel.findOne({ key: "area-gulshan" }).lean();

if (!institution || !campus || !area) {
  console.error("Reference data missing. Run `npm run db:seed` first.");
  await disconnectFromDatabase();
  process.exit(1);
}

await UserModel.deleteOne({ email: EMAIL });

await UserModel.create({
  name: "Sana Rehman",
  email: EMAIL,
  passwordHash: await hashPassword(PASSWORD),
  phone: "0300 9998877",
  userType: "employee",
  institutionId: institution._id,
  campusId: campus._id,
  areaId: area._id,
  badgeStatus: "approved",
  role: "universityAdmin",
  emailVerifiedAt: new Date(),
});

console.log(`
  University admin ready (${env.MONGODB_DB})

  ${EMAIL}
  ${PASSWORD}

  Scope: ${institution.name} only. Sign in at the admin panel.
`);

await disconnectFromDatabase();
