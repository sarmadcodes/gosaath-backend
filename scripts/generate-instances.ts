import { connectToDatabase, disconnectFromDatabase } from "../src/db/mongodb.js";
import { generateAllInstances } from "../src/modules/commutes/instance.service.js";

/**
 * The scheduled job. Idempotent: safe to run repeatedly, and safe to run while
 * another copy of it is running.
 */
await connectToDatabase();
const result = await generateAllInstances();
console.log(`  commutes ${result.commutes}, instances created ${result.created}`);
await disconnectFromDatabase();
