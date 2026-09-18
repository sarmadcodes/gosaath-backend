import { connectToDatabase, disconnectFromDatabase } from "../src/db/mongodb.js";
import { ensureIndexes, missingIndexes } from "../src/db/indexes.js";

/**
 * Deploy step. Run before starting the new version, not from inside it.
 */
await connectToDatabase();

const results = await ensureIndexes();
for (const result of results) {
  console.log(`  ${result.collection.padEnd(22)} ${result.indexes.length} indexes`);
  for (const name of result.indexes) console.log(`      ${name}`);
}

const missing = await missingIndexes();
if (missing.length > 0) {
  console.error("\nMISSING after create:");
  for (const entry of missing) console.error(`  ${entry}`);
  await disconnectFromDatabase();
  process.exit(1);
}

console.log("\nAll declared indexes present.");
await disconnectFromDatabase();
