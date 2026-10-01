import { connectToDatabase, disconnectFromDatabase } from "../src/db/mongodb.js";
import { runSchedulerLocked } from "../src/modules/commutes/scheduler.service.js";

/**
 * One pass of the recurring engine, for cron or a manual run.
 *
 * Takes the scheduler lock, so running this while the app's own timer is
 * mid-pass is safe and simply does nothing. Every write underneath is
 * idempotent regardless — the lock saves duplicated work, not correctness.
 */
await connectToDatabase();
const result = await runSchedulerLocked();

if (!result) {
  console.log("\n  another process is mid-pass; nothing to do\n");
  await disconnectFromDatabase();
  process.exit(0);
}
console.log(`
  rides generated   ${result.generated.created} (from ${result.generated.commutes} commutes)
  auto-confirmed    ${result.confirmed}
  orphans flagged   ${result.orphansFlagged}
  reminders sent    ${result.remindersSent.dayBefore} day-before, ${result.remindersSent.departure} departure
`);
await disconnectFromDatabase();
