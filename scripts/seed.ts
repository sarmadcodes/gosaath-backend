import { connectToDatabase, disconnectFromDatabase } from "../src/db/mongodb.js";
import { ensureIndexes } from "../src/db/indexes.js";
import { KARACHI_AREAS } from "../src/data/areas.seed.js";
import {
  AreaModel,
  CampusModel,
  ConfigurationModel,
  InstitutionModel,
} from "../src/db/models/index.js";
import { env } from "../src/config/env.js";

/**
 * Reference data: Karachi areas, SZABIST, Clifton campus, configuration.
 *
 * Idempotent throughout — every write is an upsert keyed on something stable,
 * so running it twice changes nothing. A seed that duplicates on a second run
 * is a seed nobody dares run against a live database.
 *
 * It never touches user data, and refuses to run in production without an
 * explicit flag.
 */

if (env.isProduction && process.env["SEED_ALLOW_PRODUCTION"] !== "yes") {
  console.error(
    "Refusing to seed in production. Set SEED_ALLOW_PRODUCTION=yes if you mean it.",
  );
  process.exit(1);
}

await connectToDatabase();
await ensureIndexes();

// --- Areas ----------------------------------------------------------------

let areasWritten = 0;
for (const area of KARACHI_AREAS) {
  await AreaModel.updateOne(
    { city: area.city, name: area.name },
    { $set: { key: area.id, centroid: area.centroid, active: true } },
    { upsert: true },
  );
  areasWritten++;
}
console.log(`  areas           ${areasWritten}`);

// --- SZABIST --------------------------------------------------------------

/**
 * The one active institution at launch.
 *
 * `active: true` is set here because SZABIST is the agreed launch partner. Any
 * OTHER institution must go through the Super Admin activation checklist —
 * seeding one as active would bypass exactly the gate that exists to stop a
 * campus going live with no campus list and nobody to review badges.
 */
const szabist = await InstitutionModel.findOneAndUpdate(
  { name: "SZABIST University" },
  {
    $set: {
      key: "inst-szabist",
      shortName: "SZABIST",
      type: "university",
      // Superset of what the app accepts. Which of these SZABIST actually
      // issues to Karachi students is still to be confirmed with their IT —
      // it is an activation checklist item, not something to guess at.
      emailDomains: ["szabist.edu.pk", "szabist.pk", "khi.szabist.edu.pk"],
      city: "Karachi",
      active: true,
      brandColor: "#0C4DA1",
      featured: true,
      "activation.contacted": true,
      "activation.campusesConfirmed": true,
      "activation.emailDomainsConfirmed": true,
      "activation.brandColorConfirmed": true,
    },
  },
  { upsert: true, new: true, setDefaultsOnInsert: true },
);
console.log(`  institution     SZABIST (${szabist?._id.toString()})`);

const clifton = await AreaModel.findOne({ name: "Clifton", city: "Karachi" });

const campus = await CampusModel.findOneAndUpdate(
  { institutionId: szabist!._id, name: "Clifton Campus" },
  { $set: { key: "camp-szabist-clifton", areaId: clifton?._id ?? null, active: true } },
  { upsert: true, new: true, setDefaultsOnInsert: true },
);
console.log(`  campus          Clifton Campus (${campus?._id.toString()})`);

// --- Configuration --------------------------------------------------------

const CONFIG: Array<{ key: string; value: unknown; description: string }> = [
  {
    key: "NEARBY_RADIUS_KM",
    value: 3,
    description:
      "How far apart two area centroids can be and still count as nearby. Roughly a detour a driver would already make.",
  },
  {
    key: "CONTRIBUTION_BAND_PKR",
    value: { car: [200, 600], bike: [100, 300] },
    description: "Guidance shown in the UI. Not a limit — any amount is accepted.",
  },
  {
    key: "RIDE_INSTANCE_WINDOW_DAYS",
    value: 14,
    description: "Rolling window of ride instances generated ahead of today.",
  },
  {
    key: "FEATURE_ORGANISATIONS",
    value: false,
    description:
      "Employees and companies. Stays off until the organisation launch: the schema supports it, the product is not ready.",
  },
];

for (const entry of CONFIG) {
  await ConfigurationModel.updateOne(
    { key: entry.key },
    { $set: { value: entry.value, description: entry.description } },
    { upsert: true },
  );
}
console.log(`  configuration   ${CONFIG.length} keys`);

console.log("\nSeed complete. Safe to run again.");
await disconnectFromDatabase();
