import { Types } from "mongoose";
import { NotFoundError } from "../../utils/errors.js";
import { CommuteModel, VehicleModel } from "../../db/models/index.js";
import { BusinessRuleError } from "../../utils/errors.js";
import type { Vehicle, VehicleType } from "../../contract/types.js";

/**
 * Vehicles.
 *
 * Every query is scoped by `ownerId` from the session, so an id belonging to
 * somebody else simply does not match. That is deliberate: filtering by owner
 * means a wrong id is indistinguishable from a missing one, and the response
 * cannot be used to discover which vehicle ids exist.
 */

type VehicleInput = {
  id?: string | undefined;
  type: VehicleType;
  model: string;
  plate: string;
  colour: string;
  imageUri?: string | null | undefined;
};

function toVehicle(doc: {
  _id: { toString(): string };
  ownerId: { toString(): string };
  type: string;
  model: string;
  plate: string;
  colour: string;
  imageUrl?: string | null;
}): Vehicle {
  return {
    id: doc._id.toString(),
    ownerId: doc.ownerId.toString(),
    type: doc.type as VehicleType,
    model: doc.model,
    plate: doc.plate,
    colour: doc.colour,
    imageUrl: doc.imageUrl ?? null,
  };
}

export async function listVehicles(userId: string): Promise<Vehicle[]> {
  const vehicles = await VehicleModel.find({ ownerId: userId })
    .sort({ createdAt: -1 })
    .lean();
  return vehicles.map(toVehicle);
}

export async function saveVehicle(
  userId: string,
  input: VehicleInput,
): Promise<Vehicle> {
  if (input.id) {
    // Scoped by owner in the same query, not checked afterwards. A separate
    // "load then compare" leaves a window where the check can be forgotten;
    // this cannot match somebody else's row at all.
    const updated = await VehicleModel.findOneAndUpdate(
      { _id: input.id, ownerId: userId },
      {
        $set: {
          type: input.type,
          model: input.model,
          plate: input.plate,
          colour: input.colour,
          imageUrl: input.imageUri ?? null,
        },
      },
      { new: true },
    ).lean();

    // 404 whether it belongs to somebody else or does not exist. A 403 would
    // confirm the id is real and owned by a particular person.
    if (!updated) throw new NotFoundError("That vehicle was not found.");
    return toVehicle(updated);
  }

  const created = await VehicleModel.create({
    ownerId: new Types.ObjectId(userId),
    type: input.type,
    model: input.model,
    plate: input.plate,
    colour: input.colour,
    imageUrl: input.imageUri ?? null,
  });

  return toVehicle(created);
}

export async function removeVehicle(
  userId: string,
  vehicleId: string,
): Promise<void> {
  // A vehicle attached to an active commute is load-bearing: removing it would
  // leave people holding seats on a ride with no vehicle behind it.
  const inUse = await CommuteModel.countDocuments({
    ownerId: userId,
    vehicleId,
    status: "active",
  });

  if (inUse > 0) {
    throw new BusinessRuleError(
      "This vehicle is on an active commute. Change the commute first.",
    );
  }

  const result = await VehicleModel.deleteOne({
    _id: vehicleId,
    ownerId: userId,
  });

  if (result.deletedCount === 0) {
    throw new NotFoundError("That vehicle was not found.");
  }
}
