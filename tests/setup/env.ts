import { readFileSync } from "node:fs";
import { URI_HANDOFF } from "./global.js";

/**
 * Points this worker at the database the global setup started.
 *
 * Runs before any test file is imported, and therefore before `src/config/env`
 * reads the environment — which it does once, at import.
 */
const uri = readFileSync(URI_HANDOFF, "utf8").trim();
process.env["MONGODB_URI"] = uri;
