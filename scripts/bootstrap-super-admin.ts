import { randomBytes } from "node:crypto";
import { connectToDatabase, disconnectFromDatabase } from "../src/db/mongodb.js";
import { hashPassword } from "../src/utils/crypto.js";
import {
  AreaModel,
  AuditLogModel,
  CampusModel,
  InstitutionModel,
  UserModel,
} from "../src/db/models/index.js";

/**
 * Creates the first platform administrator.
 *
 * Every other admin arrives by invitation from a platform admin, which leaves
 * an obvious hole: the first one has nobody to be invited by. `seed-admin`
 * fills it in development and refuses to run in production, correctly — so
 * without this there is no way to reach the console on a real deployment at
 * all.
 *
 * Run once:
 *
 *     npm run db:bootstrap -- gosaathapp@gmail.com "Sarmad Abbasi"
 *
 * **It refuses if a platform administrator already exists.** That is the whole
 * safety property. A bootstrap script that could be re-run is a script that
 * grants platform access to any address, and it would sit in the repository of
 * a deployed system with a shell on the box being the only thing standing in
 * the way. Promoting somebody later is the console's own job, where it is
 * audited and done by a named person.
 *
 * No password is set, deliberately. Administrators sign in with an emailed
 * code, so a password would be an unused second way in — and an unused
 * credential is one nobody rotates. The hash below is random bytes that are
 * never printed and that nothing can match.
 */

const [emailArg, nameArg] = process.argv.slice(2);

if (!emailArg) {
  console.error(
    "\n  Usage: npm run db:bootstrap -- <email> [name]\n\n" +
      "  The address receives a sign-in code, so it must be a real mailbox\n" +
      "  you control.\n",
  );
  process.exit(1);
}

const email = emailArg.trim().toLowerCase();
const name = nameArg?.trim() || "Platform administrator";

if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
  console.error(`\n  "${email}" does not look like an email address.\n`);
  process.exit(1);
}

await connectToDatabase();

const existing = await UserModel.findOne({ role: "superAdmin", deletedAt: null })
  .select("email")
  .lean();

if (existing) {
  console.error(
    `\n  A platform administrator already exists: ${existing.email}\n\n` +
      "  Refusing to create another. Use the admin console to add one, where\n" +
      "  the action is recorded against whoever took it.\n",
  );
  await disconnectFromDatabase();
  process.exit(1);
}

// A platform admin belongs to no institution in any meaningful sense — their
// scope is every institution, including ones added later. But the model
// requires these, so they are filled from whatever exists and never used for
// scoping: `scopeOf` returns platform scope for this role and ignores them.
const institution = await InstitutionModel.findOne().sort({ createdAt: 1 }).lean();
const campus = institution
  ? await CampusModel.findOne({ institutionId: institution._id }).lean()
  : null;
const area = await AreaModel.findOne().lean();

if (!institution || !campus || !area) {
  console.error(
    "\n  Reference data missing. Run `npm run db:seed` first — an institution,\n" +
      "  a campus and an area have to exist before any account can.\n",
  );
  await disconnectFromDatabase();
  process.exit(1);
}

const user = await UserModel.findOne({ email });

if (user) {
  // An existing account is promoted rather than replaced: it may already have
  // a commute, and deleting it to make an admin would take that with it.
  user.role = "superAdmin";
  user.emailVerifiedAt = user.emailVerifiedAt ?? new Date();
  user.suspendedAt = null;
  await user.save();
  console.log(`\n  Promoted the existing account ${email} to platform administrator.`);
} else {
  await UserModel.create({
    name,
    email,
    // Random, never printed, never used. Admin sign-in is by emailed code.
    passwordHash: await hashPassword(randomBytes(32).toString("base64url")),
    phone: "not provided",
    userType: "employee",
    institutionId: institution._id,
    campusId: campus._id,
    areaId: area._id,
    badgeStatus: "approved",
    role: "superAdmin",
    emailVerifiedAt: new Date(),
  });
  console.log(`\n  Created ${email} as platform administrator.`);
}

const created = await UserModel.findOne({ email }).select("_id").lean();

// Written straight to the collection: `recordAudit` expects an acting admin,
// and there is none — that is what makes this a bootstrap. The entry exists so
// the first account's origin is as traceable as every later one.
await AuditLogModel.create({
  actorUserId: created!._id,
  actorRole: "superAdmin",
  action: "admin.invited",
  targetType: "user",
  targetId: created!._id.toString(),
  institutionId: null,
  metadata: { bootstrap: true, via: "scripts/bootstrap-super-admin.ts" },
});

console.log(
  "\n  Sign in at the admin panel with this address. No password is set —\n" +
    "  enter the address, and a six-digit code is emailed to it.\n",
);

await disconnectFromDatabase();
