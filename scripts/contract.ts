import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Keeps the vendored contract identical to the mobile app's copy.
 *
 * The backend must serve exactly the shapes the client expects. Re-declaring
 * those types here by hand is how a field quietly becomes optional on one side
 * and required on the other, and nothing catches it until a screen renders
 * blank in production.
 *
 *   npm run contract:check   verify — non-zero exit on drift, for CI
 *   npm run contract:sync    re-copy from the app
 */

const here = dirname(fileURLToPath(import.meta.url));
const backendRoot = resolve(here, "..");
const appRoot = resolve(backendRoot, "..", "GoSaath", "src");

const FILES = [
  { from: "data/types.ts", to: "types.ts" },
  { from: "services/api.ts", to: "api.ts" },
  { from: "data/roles.ts", to: "roles.ts" },
] as const;

const HEADER = (source: string) =>
  `// VENDORED FROM THE MOBILE APP — DO NOT EDIT BY HAND.
// Source: GoSaath/src/${source}
// Re-copy with \`npm run contract:sync\`; \`npm run contract:check\` fails
// CI when this drifts from the app's copy. Re-declaring these types by
// hand is how response shapes silently diverge from the client.

`;

/** The app resolves "@/..."; the backend has no such alias. */
function rewriteImports(source: string): string {
  return source
    .replace(/from "@\/data\/types"/g, 'from "./types.js"')
    .replace(/from "@\/services\/api"/g, 'from "./api.js"');
}

function expected(from: string): string | null {
  const path = resolve(appRoot, from);
  if (!existsSync(path)) return null;
  return HEADER(from) + rewriteImports(readFileSync(path, "utf8"));
}

const mode = process.argv[2] === "sync" ? "sync" : "check";
let drifted = 0;
let missing = 0;

for (const file of FILES) {
  const target = resolve(backendRoot, "src", "contract", file.to);
  const want = expected(file.from);

  if (want === null) {
    process.stderr.write(
      `  MISSING SOURCE  GoSaath/src/${file.from} not found\n`,
    );
    missing++;
    continue;
  }

  const have = existsSync(target) ? readFileSync(target, "utf8") : "";

  if (have === want) {
    process.stdout.write(`  ok              ${file.to}\n`);
    continue;
  }

  if (mode === "sync") {
    writeFileSync(target, want, "utf8");
    process.stdout.write(`  synced          ${file.to}\n`);
  } else {
    process.stderr.write(`  DRIFT           ${file.to}\n`);
    drifted++;
  }
}

if (missing > 0) {
  process.stderr.write(
    "\nThe mobile app was not found beside this repo. Expected it at " +
      `${appRoot}\n`,
  );
  process.exit(1);
}

if (drifted > 0) {
  process.stderr.write(
    `\n${drifted} contract file(s) differ from the app.\n` +
      "Run `npm run contract:sync`, then fix whatever no longer compiles.\n",
  );
  process.exit(1);
}

process.stdout.write(
  mode === "sync" ? "\nContract synced.\n" : "\nContract is in sync.\n",
);
