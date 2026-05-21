// LOT-1C — pure-helper tests for the finished-lot-passport projector.
//
// The DB-touching projection functions are exercised live during the
// staging-verification phase (rebuilder against real data). Here we
// pin down the deterministic transforms: trace-code preservation,
// output-row derivation, contributing-bag confidence ladder,
// print_payload shape.

import { describe, expect, it } from "vitest";
import {
  buildPrintPayload,
  deriveContributingBags,
  deriveOutputRows,
  deriveTraceCodeForLot,
  summarizePassportConfidence,
} from "./finished-lot-passport";

describe("deriveTraceCodeForLot", () => {
  it("preserves an existing trace_code unchanged", () => {
    expect(
      deriveTraceCodeForLot({
        existingTraceCode: "FL-CUSTOM-1",
        finishedLotNumber: "2026-001",
      }),
    ).toBe("FL-CUSTOM-1");
  });

  it("preserves trace codes that don't follow the FL- prefix (operator override)", () => {
    // The projector trusts a hand-set trace_code even if it doesn't
    // match the validator — operators can fix typos there.
    expect(
      deriveTraceCodeForLot({
        existingTraceCode: "LEGACY-2024-001",
        finishedLotNumber: "2026-001",
      }),
    ).toBe("LEGACY-2024-001");
  });

  it("treats whitespace-only existing trace_code as missing", () => {
    expect(
      deriveTraceCodeForLot({
        existingTraceCode: "   ",
        finishedLotNumber: "2026-001",
      }),
    ).toBe("FL-2026-001");
  });

  it("builds FL- prefixed trace from finishedLotNumber when null", () => {
    expect(
      deriveTraceCodeForLot({
        existingTraceCode: null,
        finishedLotNumber: "2026-001",
      }),
    ).toBe("FL-2026-001");
  });
});

describe("buildPrintPayload", () => {
  it("includes trace_code, product, packed_at, expires_at, source marker", () => {
    const payload = buildPrintPayload({
      traceCode: "FL-2026-001",
      productName: "Mango Peach 30",
      productSku: "MP-30",
      packedAt: new Date("2026-05-14T10:00:00Z"),
      expiresAt: new Date("2027-05-14T10:00:00Z"),
      finishedLotCodeAlias: null,
    });
    expect(payload.source).toBe("PROJECTOR");
    expect(payload.schema_version).toBe("1.0");
    expect(payload.trace_code).toBe("FL-2026-001");
    expect(payload.product_name).toBe("Mango Peach 30");
    expect(payload.product_sku).toBe("MP-30");
    expect(payload.packed_at).toBe("2026-05-14T10:00:00.000Z");
    expect(payload.expires_at).toBe("2027-05-14T10:00:00.000Z");
  });

  it("omits customer_alias when finished_lot_code_alias is null", () => {
    const payload = buildPrintPayload({
      traceCode: "FL-2026-001",
      productName: null,
      productSku: null,
      packedAt: null,
      expiresAt: null,
      finishedLotCodeAlias: null,
    });
    expect("customer_alias" in payload).toBe(false);
  });

  it("includes customer_alias when set", () => {
    const payload = buildPrintPayload({
      traceCode: "FL-2026-001",
      productName: null,
      productSku: null,
      packedAt: null,
      expiresAt: null,
      finishedLotCodeAlias: "ACME-INTERNAL-5",
    });
    expect(payload.customer_alias).toBe("ACME-INTERNAL-5");
  });

  it("never embeds supplier_lot_number", () => {
    const payload = buildPrintPayload({
      traceCode: "FL-2026-001",
      productName: "Mango Peach 30",
      productSku: "MP-30",
      packedAt: new Date(),
      expiresAt: null,
      finishedLotCodeAlias: null,
    });
    expect(JSON.stringify(payload)).not.toMatch(/supplier_lot/i);
  });
});

describe("deriveOutputRows", () => {
  it("emits LOOSE / DISPLAY / MASTER_CASE for each non-zero count", () => {
    const rows = deriveOutputRows({
      unitsProduced: 12000,
      displaysProduced: 100,
      casesProduced: 10,
      traceCode: "FL-2026-001",
      printPayload: { source: "PROJECTOR" },
    });
    expect(rows.map((r) => r.outputType)).toEqual([
      "LOOSE_UNIT",
      "DISPLAY",
      "MASTER_CASE",
    ]);
    expect(rows.find((r) => r.outputType === "LOOSE_UNIT")!.quantity).toBe(12000);
    expect(rows.find((r) => r.outputType === "DISPLAY")!.quantity).toBe(100);
    expect(rows.find((r) => r.outputType === "MASTER_CASE")!.quantity).toBe(10);
  });

  it("skips zero counts — never fabricates rows", () => {
    const rows = deriveOutputRows({
      unitsProduced: 12000,
      displaysProduced: 0,
      casesProduced: 0,
      traceCode: "FL-2026-001",
      printPayload: { source: "PROJECTOR" },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.outputType).toBe("LOOSE_UNIT");
  });

  it("skips null counts", () => {
    const rows = deriveOutputRows({
      unitsProduced: 12000,
      displaysProduced: null,
      casesProduced: null,
      traceCode: "FL-2026-001",
      printPayload: { source: "PROJECTOR" },
    });
    expect(rows).toHaveLength(1);
  });

  it("returns empty when every count is zero / null (incomplete lot)", () => {
    const rows = deriveOutputRows({
      unitsProduced: 0,
      displaysProduced: null,
      casesProduced: null,
      traceCode: "FL-INCOMPLETE",
      printPayload: { source: "PROJECTOR" },
    });
    expect(rows).toEqual([]);
  });

  it("stamps trace_code_printed on every row and re-uses the print_payload", () => {
    const printPayload = {
      source: "PROJECTOR",
      schema_version: "1.0",
      trace_code: "FL-2026-001",
    };
    const rows = deriveOutputRows({
      unitsProduced: 100,
      displaysProduced: 10,
      casesProduced: 1,
      traceCode: "FL-2026-001",
      printPayload,
    });
    for (const r of rows) {
      expect(r.traceCodePrinted).toBe("FL-2026-001");
      expect(r.printPayload).toBe(printPayload);
    }
  });
});

describe("deriveContributingBags", () => {
  it("HIGH confidence link from workflow_bag.inventory_bag_id", () => {
    const links = deriveContributingBags({
      workflowBagId: "wf-1",
      workflowBagInventoryBagId: "bag-1",
      workflowBagPillCount: 20000,
      batchInputs: [],
      bagsByBatch: {},
    });
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      inventoryBagId: "bag-1",
      workflowBagId: "wf-1",
      quantityConsumedPills: 20000,
      confidence: "HIGH",
      source: "PROJECTOR",
    });
  });

  it("LOW confidence fan-out from batch-level inputs", () => {
    const links = deriveContributingBags({
      workflowBagId: "wf-1",
      workflowBagInventoryBagId: null,
      workflowBagPillCount: null,
      batchInputs: [
        { batchId: "batch-1", qtyConsumed: 40000, derivedFromEventId: "ev-1" },
      ],
      bagsByBatch: {
        "batch-1": [
          { id: "bag-1", pillCount: 20000 },
          { id: "bag-2", pillCount: 20000 },
        ],
      },
    });
    expect(links).toHaveLength(2);
    for (const l of links) {
      expect(l.confidence).toBe("LOW");
      expect(l.source).toBe("LEGACY_IMPORT");
      // We intentionally don't split qty across bags; leave null.
      expect(l.quantityConsumedPills).toBeNull();
      expect(l.derivedFromEventId).toBe("ev-1");
    }
  });

  it("never downgrades a HIGH link to LOW even if the same bag is in the batch", () => {
    const links = deriveContributingBags({
      workflowBagId: "wf-1",
      workflowBagInventoryBagId: "bag-1",
      workflowBagPillCount: 20000,
      batchInputs: [
        { batchId: "batch-1", qtyConsumed: 20000, derivedFromEventId: null },
      ],
      bagsByBatch: {
        "batch-1": [{ id: "bag-1", pillCount: 20000 }],
      },
    });
    // Same (bag-1, wf-1) shouldn't be emitted twice.
    expect(links).toHaveLength(1);
    expect(links[0]!.confidence).toBe("HIGH");
  });

  it("MISSING / empty input set returns no links — never guesses", () => {
    expect(
      deriveContributingBags({
        workflowBagId: null,
        workflowBagInventoryBagId: null,
        workflowBagPillCount: null,
        batchInputs: [],
        bagsByBatch: {},
      }),
    ).toEqual([]);
  });

  it("one finished lot can link to multiple raw bags (HIGH + fan-out)", () => {
    const links = deriveContributingBags({
      workflowBagId: "wf-1",
      workflowBagInventoryBagId: "bag-1",
      workflowBagPillCount: 20000,
      batchInputs: [
        { batchId: "batch-X", qtyConsumed: 10000, derivedFromEventId: null },
      ],
      bagsByBatch: {
        "batch-X": [
          { id: "bag-X1", pillCount: 5000 },
          { id: "bag-X2", pillCount: 5000 },
        ],
      },
    });
    // HIGH bag-1 + LOW bag-X1 + LOW bag-X2.
    expect(links.map((l) => l.inventoryBagId).sort()).toEqual(
      ["bag-1", "bag-X1", "bag-X2"].sort(),
    );
  });
});

describe("summarizePassportConfidence", () => {
  it("MIN across all links", () => {
    expect(
      summarizePassportConfidence([
        {
          inventoryBagId: "a",
          workflowBagId: null,
          quantityConsumedPills: null,
          confidence: "HIGH",
          source: "PROJECTOR",
          derivedFromEventId: null,
        },
        {
          inventoryBagId: "b",
          workflowBagId: null,
          quantityConsumedPills: null,
          confidence: "LOW",
          source: "LEGACY_IMPORT",
          derivedFromEventId: null,
        },
      ]),
    ).toBe("LOW");
  });

  it("empty link set → MISSING", () => {
    expect(summarizePassportConfidence([])).toBe("MISSING");
  });
});

describe("partial-bag / multi-lot relationships (schema invariants)", () => {
  // One raw bag can contribute to multiple finished lots — the
  // projector never enforces uniqueness on inventory_bag_id alone.
  // Two separate runs (one per lot) each produce their own link to
  // the same bag id; the triple-unique on (lot, bag, workflow_bag)
  // is what prevents duplicates within a single lot.
  it("two separate projection runs each emit links for the same bag", () => {
    const linksA = deriveContributingBags({
      workflowBagId: "wf-A",
      workflowBagInventoryBagId: "bag-1",
      workflowBagPillCount: 10000,
      batchInputs: [],
      bagsByBatch: {},
    });
    const linksB = deriveContributingBags({
      workflowBagId: "wf-B",
      workflowBagInventoryBagId: "bag-1",
      workflowBagPillCount: 10000,
      batchInputs: [],
      bagsByBatch: {},
    });
    expect(linksA[0]!.inventoryBagId).toBe("bag-1");
    expect(linksB[0]!.inventoryBagId).toBe("bag-1");
    // Different workflow_bag means the unique key (lot, bag, wf) is
    // different — both rows persist.
    expect(linksA[0]!.workflowBagId).toBe("wf-A");
    expect(linksB[0]!.workflowBagId).toBe("wf-B");
  });
});
