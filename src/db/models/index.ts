/**
 * Every model, in one import.
 *
 * Also the list `ensureIndexes` walks — registering a model here is what makes
 * its indexes part of the deploy, so a new collection cannot ship without them.
 */
export * from "./user.model.js";
export * from "./auth.model.js";
export * from "./institution.model.js";
export * from "./commute.model.js";
export * from "./social.model.js";
export * from "./platform.model.js";
