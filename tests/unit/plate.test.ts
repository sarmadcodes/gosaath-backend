import { describe, expect, it } from "vitest";
import { maskPlate } from "../../src/modules/users/contact.service.js";

/**
 * SYSTEM.md 4.5.4 — "Vehicle plate masked until confirmed."
 *
 * The mask has to survive being seen next to other masks: it should let a
 * passenger tell two cars apart without letting anyone assemble a register of
 * who drives what from a list of rides.
 */
describe("maskPlate", () => {
  it("keeps the letter prefix and hides the digits", () => {
    expect(maskPlate("BKT-512")).toBe("BKT-••••");
    expect(maskPlate("AXB-704")).toBe("AXB-••••");
  });

  it("handles a plate written without a separator", () => {
    expect(maskPlate("KHI8831")).toBe("KHI-••••");
  });

  it("handles a space instead of a hyphen", () => {
    expect(maskPlate("KS 1234")).toBe("KS-••••");
  });

  it("never lets more than four digits through as a length hint", () => {
    expect(maskPlate("ABC-1234567")).toBe("ABC-••••");
  });

  it("gives nothing away when the plate has no recognisable shape", () => {
    expect(maskPlate("1234")).toBe("•••");
    expect(maskPlate("")).toBe("•••");
  });

  it("uppercases the prefix, so one car is not shown two ways", () => {
    expect(maskPlate("bkt-512")).toBe("BKT-••••");
  });
});
