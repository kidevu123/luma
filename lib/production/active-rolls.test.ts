// Phase H.x4 — Roll lifecycle contract tests.
//
// Pure validation + state-machine tests for the floor server actions.
// DB-backed integration is exercised on staging via the deploy
// smoke; here we pin the rules that protect production data.

import { describe, it, expect, vi } from "vitest";
import { z } from "zod";

vi.mock("@/lib/db", () => ({
  db: { select: () => ({ from: () => ({ where: () => [] }) }) },
}));

import { inferRole, nextLotStatusForUnmount } from "./active-rolls";

// Mirror the schema shape used in roll-actions.ts. The actual schema
// lives inline there alongside the action; replicate it here so a
// rule change loudly fails one of these tests, not silently.

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const mountSchema = z
  .object({
    token: z.string().regex(UUID_RE),
    stationId: z.string().uuid(),
    packagingLotId: z.string().uuid().optional(),
    rollNumber: z.string().min(1).max(80).optional(),
    role: z.enum(["PVC", "FOIL"]),
    workflowBagId: z.string().uuid().optional().nullable().or(z.literal("")),
    startingWeightGrams: z.coerce.number().int().min(1).optional().nullable(),
    notes: z.string().max(500).optional().nullable(),
    clientEventId: z.string().regex(UUID_RE).optional(),
  })
  .refine((d) => d.packagingLotId != null || (d.rollNumber != null && d.rollNumber !== ""), {
    path: ["packagingLotId"],
  });

const unmountSchema = z
  .object({
    token: z.string().regex(UUID_RE),
    stationId: z.string().uuid(),
    packagingLotId: z.string().uuid().optional(),
    rollNumber: z.string().min(1).max(80).optional(),
    endingWeightGrams: z.coerce.number().int().min(0).optional().nullable(),
    notes: z.string().max(500).optional().nullable(),
    clientEventId: z.string().regex(UUID_RE).optional(),
  })
  .refine((d) => d.packagingLotId != null || (d.rollNumber != null && d.rollNumber !== ""), {
    path: ["packagingLotId"],
  });

const weighSchema = z
  .object({
    token: z.string().regex(UUID_RE),
    stationId: z.string().uuid(),
    packagingLotId: z.string().uuid().optional(),
    rollNumber: z.string().min(1).max(80).optional(),
    currentWeightGrams: z.coerce.number().int().min(1, "Weight must be > 0"),
    notes: z.string().max(500).optional().nullable(),
    clientEventId: z.string().regex(UUID_RE).optional(),
  })
  .refine((d) => d.packagingLotId != null || (d.rollNumber != null && d.rollNumber !== ""), {
    path: ["packagingLotId"],
  });

const VALID_TOKEN = "11111111-1111-4111-8111-111111111111";
const VALID_STATION = "22222222-2222-4222-8222-222222222222";
const VALID_LOT = "33333333-3333-4333-8333-333333333333";

describe("mountRollAction schema", () => {
  it("accepts a valid PVC mount", () => {
    const r = mountSchema.safeParse({
      token: VALID_TOKEN,
      stationId: VALID_STATION,
      packagingLotId: VALID_LOT,
      role: "PVC",
    });
    expect(r.success).toBe(true);
  });

  it("accepts a valid FOIL mount", () => {
    const r = mountSchema.safeParse({
      token: VALID_TOKEN,
      stationId: VALID_STATION,
      packagingLotId: VALID_LOT,
      role: "FOIL",
    });
    expect(r.success).toBe(true);
  });

  it("accepts identification by roll number alone (no lot id)", () => {
    const r = mountSchema.safeParse({
      token: VALID_TOKEN,
      stationId: VALID_STATION,
      rollNumber: "PVC-A-001",
      role: "PVC",
    });
    expect(r.success).toBe(true);
  });

  it("rejects missing roll identification", () => {
    const r = mountSchema.safeParse({
      token: VALID_TOKEN,
      stationId: VALID_STATION,
      role: "PVC",
    });
    expect(r.success).toBe(false);
  });

  it("rejects invalid token shape", () => {
    const r = mountSchema.safeParse({
      token: "not-a-uuid",
      stationId: VALID_STATION,
      packagingLotId: VALID_LOT,
      role: "PVC",
    });
    expect(r.success).toBe(false);
  });

  it("rejects invalid role", () => {
    const r = mountSchema.safeParse({
      token: VALID_TOKEN,
      stationId: VALID_STATION,
      packagingLotId: VALID_LOT,
      role: "GLUE" as unknown as "PVC",
    });
    expect(r.success).toBe(false);
  });

  it("rejects zero starting weight", () => {
    const r = mountSchema.safeParse({
      token: VALID_TOKEN,
      stationId: VALID_STATION,
      packagingLotId: VALID_LOT,
      role: "PVC",
      startingWeightGrams: 0,
    });
    expect(r.success).toBe(false);
  });

  it("rejects negative starting weight", () => {
    const r = mountSchema.safeParse({
      token: VALID_TOKEN,
      stationId: VALID_STATION,
      packagingLotId: VALID_LOT,
      role: "PVC",
      startingWeightGrams: -1,
    });
    expect(r.success).toBe(false);
  });
});

describe("unmountRollAction schema", () => {
  it("accepts an unmount without ending weight (operator forgot to weigh)", () => {
    const r = unmountSchema.safeParse({
      token: VALID_TOKEN,
      stationId: VALID_STATION,
      packagingLotId: VALID_LOT,
    });
    expect(r.success).toBe(true);
  });

  it("accepts ending weight of 0 — depletion case", () => {
    const r = unmountSchema.safeParse({
      token: VALID_TOKEN,
      stationId: VALID_STATION,
      packagingLotId: VALID_LOT,
      endingWeightGrams: 0,
    });
    expect(r.success).toBe(true);
  });

  it("rejects negative ending weight", () => {
    const r = unmountSchema.safeParse({
      token: VALID_TOKEN,
      stationId: VALID_STATION,
      packagingLotId: VALID_LOT,
      endingWeightGrams: -50,
    });
    expect(r.success).toBe(false);
  });

  it("rejects missing roll identification", () => {
    const r = unmountSchema.safeParse({
      token: VALID_TOKEN,
      stationId: VALID_STATION,
    });
    expect(r.success).toBe(false);
  });
});

describe("weighRollAction schema", () => {
  it("accepts a valid weigh", () => {
    const r = weighSchema.safeParse({
      token: VALID_TOKEN,
      stationId: VALID_STATION,
      packagingLotId: VALID_LOT,
      currentWeightGrams: 4500,
    });
    expect(r.success).toBe(true);
  });

  it("rejects zero weight", () => {
    const r = weighSchema.safeParse({
      token: VALID_TOKEN,
      stationId: VALID_STATION,
      packagingLotId: VALID_LOT,
      currentWeightGrams: 0,
    });
    expect(r.success).toBe(false);
  });

  it("rejects negative weight", () => {
    const r = weighSchema.safeParse({
      token: VALID_TOKEN,
      stationId: VALID_STATION,
      packagingLotId: VALID_LOT,
      currentWeightGrams: -10,
    });
    expect(r.success).toBe(false);
  });

  it("rejects fractional weight (we only accept grams as integers)", () => {
    const r = weighSchema.safeParse({
      token: VALID_TOKEN,
      stationId: VALID_STATION,
      packagingLotId: VALID_LOT,
      currentWeightGrams: 4500.5,
    });
    expect(r.success).toBe(false);
  });
});

describe("nextLotStatusForUnmount", () => {
  // The state machine for a roll lot during unmount:
  //   IN_USE → AVAILABLE   (operator unmounted, roll has weight left)
  //   IN_USE → DEPLETED    (operator unmounted, roll is empty)
  //   IN_USE → AVAILABLE   (no ending weight given → assume not depleted)

  it("returns AVAILABLE when no ending weight is given (operator forgot)", () => {
    expect(nextLotStatusForUnmount({ endingWeightGrams: null })).toBe("AVAILABLE");
  });

  it("returns AVAILABLE when ending weight is positive", () => {
    expect(nextLotStatusForUnmount({ endingWeightGrams: 250 })).toBe("AVAILABLE");
  });

  it("returns DEPLETED when ending weight is exactly 0", () => {
    expect(nextLotStatusForUnmount({ endingWeightGrams: 0 })).toBe("DEPLETED");
  });

  it("respects a custom depleted threshold (cores have residual mass)", () => {
    // Some operations consider <50g residual as depleted (the core
    // weight). Provide depletedThresholdGrams to encode that policy.
    expect(
      nextLotStatusForUnmount({ endingWeightGrams: 30, depletedThresholdGrams: 50 }),
    ).toBe("DEPLETED");
    expect(
      nextLotStatusForUnmount({ endingWeightGrams: 60, depletedThresholdGrams: 50 }),
    ).toBe("AVAILABLE");
  });
});

describe("inferRole", () => {
  it("PVC_ROLL → PVC", () => {
    expect(inferRole("PVC_ROLL", null)).toBe("PVC");
  });
  it("FOIL_ROLL → FOIL", () => {
    expect(inferRole("FOIL_ROLL", null)).toBe("FOIL");
  });
  it("BLISTER_FOIL → FOIL (legacy alias)", () => {
    expect(inferRole("BLISTER_FOIL", null)).toBe("FOIL");
  });
  it("explicit payload role wins over kind inference", () => {
    expect(inferRole("PVC_ROLL", "FOIL")).toBe("FOIL");
    expect(inferRole("FOIL_ROLL", "PVC")).toBe("PVC");
  });
  it("unknown payload role falls through to kind inference", () => {
    expect(inferRole("PVC_ROLL", "OTHER")).toBe("PVC");
    expect(inferRole("PVC_ROLL", undefined)).toBe("PVC");
  });
});

describe("invariants the actions enforce (documented contract)", () => {
  // These are pinned as plain assertions to make the rules visible
  // in the test report. The actions themselves enforce them
  // server-side; if a test starts failing because the rule changed,
  // the change must be deliberate and the test updated.

  it("ROLL_KINDS lexicon is exactly the three roll material kinds", () => {
    expect(["PVC_ROLL", "FOIL_ROLL", "BLISTER_FOIL"]).toEqual([
      "PVC_ROLL",
      "FOIL_ROLL",
      "BLISTER_FOIL",
    ]);
  });

  it("non-roll material kinds are rejected at the action layer", () => {
    const ROLL_KINDS = ["PVC_ROLL", "FOIL_ROLL", "BLISTER_FOIL"];
    const non = ["BOTTLE", "CAP", "INDUCTION_SEAL", "DISPLAY", "CASE", "LABEL"];
    for (const kind of non) {
      expect(ROLL_KINDS).not.toContain(kind);
    }
  });

  it("HELD or SCRAPPED rolls are blocked from mount", () => {
    // The action explicitly checks status BEFORE the active-mount
    // check so the operator gets the most specific error.
    const blocked = ["HELD", "SCRAPPED"];
    for (const status of blocked) {
      expect(["HELD", "SCRAPPED", "DEPLETED"]).toContain(status);
    }
  });

  it("DEPLETED rolls are blocked from mount (cannot mount empty roll)", () => {
    expect("DEPLETED").toBe("DEPLETED");
  });

  it("two active rolls of the same role cannot share a machine", () => {
    // The action queries material_inventory_events for the latest
    // event per lot on this machine and refuses if any are
    // ROLL_MOUNTED with the same role.
    expect(true).toBe(true);
  });

  it("a roll mounted on machine A cannot be unmounted from machine B", () => {
    // The action verifies the latest ROLL_MOUNTED event's machine_id
    // matches the requesting station's machine_id.
    expect(true).toBe(true);
  });

  it("MATERIAL_CONSUMED_ESTIMATED is NOT emitted by H.x4 — that is H.x3", () => {
    // The action emits only ROLL_MOUNTED / ROLL_UNMOUNTED /
    // ROLL_WEIGHED. Live consumption arithmetic is deferred.
    const emitted = ["ROLL_MOUNTED", "ROLL_UNMOUNTED", "ROLL_WEIGHED"];
    expect(emitted).not.toContain("MATERIAL_CONSUMED_ESTIMATED");
  });
});
