import { connectToDatabase, disconnectFromDatabase } from "../src/db/mongodb.js";
import { runScheduler } from "../src/modules/commutes/scheduler.service.js";

/**
 * One pass of the recurring engine, for cron or a manual run.
 *
 * Idempotent by construction, so running it twice by accident — or while
 * another copy is running — costs nothing.
 */
await connectToDatabase();
const result = await runScheduler();
console.log(`
  rides generated   ${result.generated.created} (from ${result.generated.commutes} commutes)
  auto-confirmed    ${result.confirmed}
  orphans flagged   ${result.orphansFlagged}
  reminders sent    ${result.remindersSent.dayBefore} day-before, ${result.remindersSent.departure} departure
`);
await disconnectFromDatabase();
