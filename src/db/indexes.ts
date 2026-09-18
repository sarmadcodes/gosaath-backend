import { logger } from "../utils/logger.js";
import * as models from "./models/index.js";

/**
 * Creates every declared index.
 *
 * `autoIndex` is off (see mongodb.ts), so this is the only thing that builds
 * them. Leaving it on means each process races to build indexes at boot and a
 * production deploy silently blocks on a foreground build; making it explicit
 * turns index changes into a reviewable deploy step.
 */

/**
 * Only the surface this module touches.
 *
 * Mongoose's concrete model types are not assignable to `Model<unknown>`, and
 * widening to `any` would give up checking on the very calls that matter here.
 * This describes exactly what is used and nothing else.
 */
type IndexableModel = {
  collection: {
    collectionName: string;
    indexes(): Promise<Array<{ key?: Record<string, unknown>; name?: string }>>;
  };
  schema: { indexes(): Array<[Record<string, unknown>, unknown]> };
  createCollection(): Promise<unknown>;
  createIndexes(): Promise<unknown>;
};

function registeredModels(): IndexableModel[] {
  // Through `unknown` first: the module's exports are a union of concrete
  // model types, and a predicate narrowing straight to IndexableModel is not
  // assignable to any single one of them. The runtime check below is what
  // actually establishes the type.
  return (Object.values(models) as unknown[]).filter(
    (candidate): candidate is IndexableModel =>
      typeof candidate === "function" &&
      candidate !== null &&
      "createIndexes" in candidate &&
      "collection" in candidate,
  );
}

export async function ensureIndexes(): Promise<{
  collection: string;
  indexes: string[];
}[]> {
  const results: { collection: string; indexes: string[] }[] = [];

  for (const Model of registeredModels()) {
    // Collections are not autocreated either, so an index build on a
    // never-written collection would fail without this.
    await Model.createCollection().catch(() => {
      // Already exists. Nothing to do.
    });
    await Model.createIndexes();

    const existing = await Model.collection.indexes();
    results.push({
      collection: Model.collection.collectionName,
      indexes: existing.map((index) => index.name ?? "(unnamed)"),
    });
  }

  return results;
}

/**
 * Reports indexes declared in code but missing from the database.
 *
 * Used by the Phase 1 test: a missing unique index is not a performance
 * problem, it is the difference between "one seat per person" being guaranteed
 * and merely hoped for.
 */
export async function missingIndexes(): Promise<string[]> {
  const missing: string[] = [];

  for (const Model of registeredModels()) {
    const declared = Model.schema.indexes();
    if (declared.length === 0) continue;

    let existing: Array<{ key?: Record<string, unknown> }> = [];
    try {
      existing = await Model.collection.indexes();
    } catch {
      missing.push(`${Model.collection.collectionName} (collection missing)`);
      continue;
    }

    const existingKeys = new Set(
      existing.map((index) => JSON.stringify(index.key ?? {})),
    );

    for (const [key] of declared) {
      if (!existingKeys.has(JSON.stringify(key))) {
        missing.push(
          `${Model.collection.collectionName}: ${JSON.stringify(key)}`,
        );
      }
    }
  }

  return missing;
}

export async function reportIndexes(): Promise<void> {
  const results = await ensureIndexes();
  for (const result of results) {
    logger.info(
      { collection: result.collection, count: result.indexes.length },
      "indexes ensured",
    );
  }
}
