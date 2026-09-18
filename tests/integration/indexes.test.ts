import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectToDatabase, disconnectFromDatabase } from "../../src/db/mongodb.js";
import { ensureIndexes, missingIndexes } from "../../src/db/indexes.js";
import {
  AreaModel,
  BlockModel,
  CampusModel,
  ConfigurationModel,
  InstitutionModel,
  UserModel,
} from "../../src/db/models/index.js";

/**
 * Phase 1 gate.
 *
 * The point is not that indexes are *declared* — that is just a schema file.
 * It is that they exist in the database and actually reject the writes they
 * are there to reject. A unique index that was never built is the difference
 * between "one account per email" being guaranteed and merely hoped for.
 */
describe("indexes", () => {
  beforeAll(async () => {
    await connectToDatabase();
    await ensureIndexes();
  }, 60_000);

  afterAll(async () => {
    await disconnectFromDatabase();
  });

  it("has every declared index present in the database", async () => {
    expect(await missingIndexes()).toEqual([]);
  });

  it("enforces one account per email address", async () => {
    // The real guarantee, tested by trying to break it. Two documents that
    // differ only in case must not both survive.
    const email = `index-check-${Date.now()}@example.test`;
    const base = {
      name: "Index Check",
      passwordHash: "x",
      phone: "0300 0000000",
      userType: "student" as const,
      institutionId: new AreaModel()._id,
      campusId: new AreaModel()._id,
      areaId: new AreaModel()._id,
    };

    await UserModel.create({ ...base, email });
    try {
      await expect(
        UserModel.create({ ...base, email: email.toUpperCase() }),
      ).rejects.toThrow();
    } finally {
      await UserModel.deleteMany({ email });
    }
  });

  it("enforces one block per pair", async () => {
    const blockerId = new AreaModel()._id;
    const blockedId = new AreaModel()._id;
    await BlockModel.create({ blockerId, blockedId });
    try {
      await expect(BlockModel.create({ blockerId, blockedId })).rejects.toThrow();
    } finally {
      await BlockModel.deleteMany({ blockerId });
    }
  });

  it("enforces one campus name per institution", async () => {
    const institutionId = new AreaModel()._id;
    const name = `Index Check Campus ${Date.now()}`;
    await CampusModel.create({ institutionId, name });
    try {
      await expect(CampusModel.create({ institutionId, name })).rejects.toThrow();
    } finally {
      await CampusModel.deleteMany({ institutionId });
    }
  });
});

describe("seed", () => {
  beforeAll(async () => {
    await connectToDatabase();
  }, 60_000);

  afterAll(async () => {
    await disconnectFromDatabase();
  });

  it("has all sixteen Karachi areas, each with a centroid", async () => {
    const areas = await AreaModel.find({ city: "Karachi" }).lean();
    expect(areas.length).toBeGreaterThanOrEqual(16);
    for (const area of areas) {
      expect(area.centroid?.lat, area.name).toBeGreaterThan(24.6);
      expect(area.centroid?.lng, area.name).toBeGreaterThan(66.8);
    }
  });

  it("has SZABIST active, with Clifton Campus", async () => {
    const szabist = await InstitutionModel.findOne({ name: "SZABIST University" }).lean();
    expect(szabist).toBeTruthy();
    expect(szabist!.active).toBe(true);
    expect(szabist!.brandColor).toBe("#0C4DA1");
    expect(szabist!.emailDomains).toContain("szabist.edu.pk");

    const campus = await CampusModel.findOne({
      institutionId: szabist!._id,
      name: "Clifton Campus",
    }).lean();
    expect(campus).toBeTruthy();
  });

  it("is the ONLY active institution", async () => {
    // Rule 7: SZABIST only, for now. An institution going active without the
    // Super Admin checklist is exactly what this catches.
    const active = await InstitutionModel.find({ active: true }).lean();
    expect(active.map((i) => i.name)).toEqual(["SZABIST University"]);
  });

  it("keeps organisations switched off", async () => {
    const flag = await ConfigurationModel.findOne({ key: "FEATURE_ORGANISATIONS" }).lean();
    expect(flag?.value).toBe(false);
  });

  it("carries the nearby radius as configuration, not a constant", async () => {
    const radius = await ConfigurationModel.findOne({ key: "NEARBY_RADIUS_KM" }).lean();
    expect(radius?.value).toBe(3);
  });
});

describe("privacy", () => {
  it("has no coordinate field anywhere on a user", () => {
    // Rule 4: area only. If somebody adds lat/lng to the user schema, this
    // fails before it can reach a migration.
    const paths = Object.keys(UserModel.schema.paths);
    for (const forbidden of ["lat", "lng", "latitude", "longitude", "location", "coordinates", "address"]) {
      expect(paths.some((p) => p.toLowerCase().includes(forbidden))).toBe(false);
    }
  });

  it("never selects the password hash by default", () => {
    const path = UserModel.schema.path("passwordHash");
    expect((path as unknown as { options: { select?: boolean } }).options.select).toBe(false);
  });

  it("has no rating field on any model", async () => {
    const models = [UserModel, InstitutionModel, CampusModel, AreaModel];
    for (const Model of models) {
      const paths = Object.keys(Model.schema.paths).join(" ").toLowerCase();
      for (const forbidden of ["rating", "stars", "review", "reputation", "score"]) {
        expect(paths.includes(forbidden), `${Model.modelName}.${forbidden}`).toBe(false);
      }
    }
  });
});
