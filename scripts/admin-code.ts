import { connectToDatabase, disconnectFromDatabase } from "../src/db/mongodb.js";
import { UserModel } from "../src/db/models/index.js";
import { issueOtp } from "../src/modules/auth/otp.service.js";
import { roleOf } from "../src/contract/roles.js";

/**
 * Issues an administrator sign-in code and prints it here.
 *
 * For when email cannot deliver — a provider outage, a daily quota, a domain
 * mid-verification — and somebody still has to get into the console. Without
 * this, an email problem locks every administrator out of the system entirely,
 * which during an incident is exactly when the console matters most.
 *
 * **It grants nothing that shell access did not already grant.** Running this
 * requires the ability to execute code on the server as the application user,
 * and that user can read .env — which holds JWT_SECRET, and therefore the
 * ability to mint an access token for anybody directly. A printed code is a
 * strictly weaker capability than the one required to print it.
 *
 * What it deliberately does NOT do:
 *
 *   it is not an HTTP endpoint, so the attack surface is unchanged
 *   it issues a real challenge, so expiry, single use and the attempt ceiling
 *   all still apply
 *   it refuses for anybody who is not already an administrator, so it cannot
 *   be used to promote
 *
 * Every use is visible: the sign-in it leads to is recorded in the audit log
 * like any other, and this script's own run is logged below.
 */

const [emailArg] = process.argv.slice(2);

if (!emailArg) {
  console.error("\n  Usage: npm run admin:code -- <email>\n");
  process.exit(1);
}

const email = emailArg.trim().toLowerCase();

await connectToDatabase();

const user = await UserModel.findOne({ email })
  .select("name email role suspendedAt deletedAt emailVerifiedAt")
  .lean();

if (!user) {
  console.error(`\n  No account for ${email}.\n`);
  await disconnectFromDatabase();
  process.exit(1);
}

const role = roleOf(user);

if (role !== "universityAdmin" && role !== "superAdmin") {
  // This is a convenience for administrators, not a way to become one.
  console.error(
    `\n  ${email} is not an administrator (role: ${role}).\n\n` +
      "  Promote them from the admin console, where the action is recorded\n" +
      "  against whoever took it.\n",
  );
  await disconnectFromDatabase();
  process.exit(1);
}

if (user.suspendedAt || user.deletedAt || !user.emailVerifiedAt) {
  console.error(`\n  ${email} cannot sign in: the account is not active.\n`);
  await disconnectFromDatabase();
  process.exit(1);
}

const { code, expiresInMinutes } = await issueOtp({ email, purpose: "adminSignIn" });

console.log(
  `\n  Sign-in code for ${email} (${role})\n\n` +
    `      ${code}\n\n` +
    `  Valid for ${expiresInMinutes} minutes, once. Enter it at the admin panel,\n` +
    `  or spend it directly:\n\n` +
    `      POST /api/v1/admin/auth/verify  { "email": "${email}", "code": "${code}" }\n\n` +
    `  No email was sent. This code exists only in this terminal.\n`,
);

await disconnectFromDatabase();
