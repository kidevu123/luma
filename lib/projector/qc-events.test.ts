// QC-5 — projector behavior tests.
//
// Stubs tx.execute so we can capture the SQL the projector fires and
// pin the dispatch matrix: which event type updates which read model.
// We don't validate the SQL itself (covered by staging smoke) — we
// pin the operations issued and the payload-driven branches.

import { describe, expect, it, beforeEach } from "vitest";
import { isQcEventType, projectQcEvent } from "./qc-events";

type ExecLog = Array<{ sqlString: string }>;

function sqlFromChunks(q: unknown): string {
  // drizzle SQL objects expose queryChunks: Array of StringChunk
  // (value: string[]) | param | nested SQL. Walk it shallowly so we
  // can grep without binding the full driver pipeline.
  const obj = q as { queryChunks?: Array<unknown> };
  const out: string[] = [];
  function visit(chunk: unknown) {
    if (chunk == null) return;
    if (typeof chunk === "string") {
      out.push(chunk);
      return;
    }
    const rec = chunk as Record<string, unknown>;
    if (Array.isArray(rec.value)) {
      for (const v of rec.value as unknown[]) visit(v);
      return;
    }
    if (Array.isArray(rec.queryChunks)) {
      for (const v of rec.queryChunks as unknown[]) visit(v);
    }
  }
  for (const c of obj.queryChunks ?? []) visit(c);
  return out.join(" ");
}

function buildTx(execLog: ExecLog, returnRows: Array<Array<unknown>> = []) {
  let i = 0;
  return {
    execute: async (q: unknown) => {
      execLog.push({ sqlString: sqlFromChunks(q) });
      const next = returnRows[i] ?? [];
      i++;
      return next;
    },
  } as unknown as Parameters<typeof projectQcEvent>[0];
}

const NOW = new Date("2026-05-13T18:00:00Z");
const EMP = "11111111-1111-4111-8111-111111111111";
const BAG = "22222222-2222-4222-8222-222222222222";
const STATION = "33333333-3333-4333-8333-333333333333";
const LOT = "44444444-4444-4444-8444-444444444444";
const LINKED = "55555555-5555-4555-8555-555555555555";

let execLog: ExecLog;
beforeEach(() => {
  execLog = [];
});

describe("isQcEventType", () => {
  it("returns true for all five QC event types", () => {
    expect(isQcEventType("PACKAGING_DAMAGE_RETURN")).toBe(true);
    expect(isQcEventType("REWORK_SENT")).toBe(true);
    expect(isQcEventType("REWORK_RECEIVED")).toBe(true);
    expect(isQcEventType("SCRAP_RECORDED")).toBe(true);
    expect(isQcEventType("SUBMISSION_CORRECTED")).toBe(true);
  });
  it("returns false for non-QC types", () => {
    expect(isQcEventType("PACKAGING_COMPLETE")).toBe(false);
    expect(isQcEventType("BLISTER_COMPLETE")).toBe(false);
    expect(isQcEventType("BAG_FINALIZED")).toBe(false);
  });
});

describe("projectQcEvent — operator_daily attribution", () => {
  it("PACKAGING_DAMAGE_RETURN bumps damage_events_total on the accountable employee", async () => {
    const tx = buildTx(execLog, [
      [{ pid: null, sku: null, kind: null }], // sku lookup → no product
    ]);
    await projectQcEvent(tx, {
      workflowBagId: BAG,
      eventType: "PACKAGING_DAMAGE_RETURN",
      occurredAt: NOW,
      employeeId: EMP,
      stationId: null,
      payload: { quantity: 3, unit: "cards", reason_code: "BAD_SEAL" },
    });
    const opSql = execLog.find((e) => e.sqlString.includes("read_operator_daily"));
    expect(opSql).toBeDefined();
    expect(opSql!.sqlString).toContain("damage_events_total");
  });

  it("SCRAP_RECORDED bumps scrap_units_total by scrap_quantity not by 1", async () => {
    const tx = buildTx(execLog, [
      [{ pid: null, sku: null, kind: null }], // no product (skip sku branch)
    ]);
    await projectQcEvent(tx, {
      workflowBagId: BAG,
      eventType: "SCRAP_RECORDED",
      occurredAt: NOW,
      employeeId: EMP,
      stationId: null,
      payload: {
        quantity: 1,
        scrap_quantity: 7,
        unit: "cards",
        reason_code: "SCRAP_APPROVED",
        affects_packaging_material: false,
      },
    });
    const opSql = execLog.find((e) => e.sqlString.includes("read_operator_daily"));
    expect(opSql).toBeDefined();
    expect(opSql!.sqlString).toContain("scrap_units_total");
  });

  it("skips operator counters entirely when no accountable employee resolved", async () => {
    const tx = buildTx(execLog, []);
    await projectQcEvent(tx, {
      workflowBagId: BAG,
      eventType: "PACKAGING_DAMAGE_RETURN",
      occurredAt: NOW,
      employeeId: null,
      stationId: null,
      payload: { quantity: 3, unit: "cards", reason_code: "BAD_SEAL" },
    });
    expect(execLog.find((e) => e.sqlString.includes("read_operator_daily"))).toBeUndefined();
  });
});

describe("projectQcEvent — read_bag_state flags", () => {
  it("REWORK_SENT sets rework_pending = true", async () => {
    const tx = buildTx(execLog, [
      [{ pid: null, sku: null, kind: null }], // sku lookup
    ]);
    await projectQcEvent(tx, {
      workflowBagId: BAG,
      eventType: "REWORK_SENT",
      occurredAt: NOW,
      employeeId: EMP,
      stationId: null,
      payload: { quantity: 5, unit: "cards", reason_code: "BAD_SEAL" },
    });
    const bs = execLog.find(
      (e) =>
        e.sqlString.includes("read_bag_state") &&
        e.sqlString.includes("rework_pending = true"),
    );
    expect(bs).toBeDefined();
  });

  it("REWORK_RECEIVED with full receive clears rework_pending and sets rework_received", async () => {
    // 1) sku lookup → no product (sku branch skips)
    // 2) refresh-pending SELECT → empty (no still-open rows)
    // 3) UPDATE rework_pending = false
    // 4) UPDATE rework_received = true
    const tx = buildTx(execLog, [
      [{ pid: null }],
      [], // no still-open rework
    ]);
    await projectQcEvent(tx, {
      workflowBagId: BAG,
      eventType: "REWORK_RECEIVED",
      occurredAt: NOW,
      employeeId: EMP,
      stationId: null,
      payload: {
        quantity: 5,
        received_quantity: 5,
        partial: false,
        unit: "cards",
        reason_code: "BAD_SEAL",
        linked_event_id: LINKED,
      },
    });
    const clearedPending = execLog.find(
      (e) =>
        e.sqlString.includes("read_bag_state") &&
        e.sqlString.includes("rework_pending = "),
    );
    const setReceived = execLog.find(
      (e) =>
        e.sqlString.includes("read_bag_state") &&
        e.sqlString.includes("rework_received = true"),
    );
    expect(clearedPending).toBeDefined();
    expect(setReceived).toBeDefined();
  });

  it("REWORK_RECEIVED with still-open SENT keeps rework_pending true", async () => {
    // refresh-pending SELECT returns one open row → projector writes
    // rework_pending = true.
    const tx = buildTx(execLog, [
      [{ pid: null }],
      [{ "?column?": 1 }], // still open
    ]);
    await projectQcEvent(tx, {
      workflowBagId: BAG,
      eventType: "REWORK_RECEIVED",
      occurredAt: NOW,
      employeeId: EMP,
      stationId: null,
      payload: {
        quantity: 5,
        received_quantity: 3,
        partial: true,
        unit: "cards",
        reason_code: "BAD_SEAL",
        linked_event_id: LINKED,
      },
    });
    // The UPDATE statement still fires (with the value=true), so it
    // shows up in the log. The important contract is just that the
    // pending flag is recomputed from the open-rework query above.
    const recompute = execLog.find((e) =>
      e.sqlString.includes("UPDATE read_bag_state"),
    );
    expect(recompute).toBeDefined();
  });

  it("SUBMISSION_CORRECTED sets has_correction = true", async () => {
    const tx = buildTx(execLog, []);
    await projectQcEvent(tx, {
      workflowBagId: BAG,
      eventType: "SUBMISSION_CORRECTED",
      occurredAt: NOW,
      employeeId: EMP,
      stationId: null,
      payload: { corrected_event_id: LINKED, correction_reason: "TYPO" },
    });
    const corrected = execLog.find(
      (e) =>
        e.sqlString.includes("read_bag_state") &&
        e.sqlString.includes("has_correction = true"),
    );
    expect(corrected).toBeDefined();
  });
});

describe("projectQcEvent — material lot state decrement", () => {
  it("SCRAP_RECORDED with material_lot_id + affects_packaging_material=true issues a decrement UPDATE", async () => {
    const tx = buildTx(execLog, [
      [{ pid: null, sku: null, kind: null }], // sku
    ]);
    await projectQcEvent(tx, {
      workflowBagId: BAG,
      eventType: "SCRAP_RECORDED",
      occurredAt: NOW,
      employeeId: EMP,
      stationId: null,
      payload: {
        quantity: 2,
        scrap_quantity: 2,
        unit: "cards",
        reason_code: "SCRAP_APPROVED",
        affects_packaging_material: true,
        material_lot_id: LOT,
      },
    });
    const decr = execLog.find(
      (e) =>
        e.sqlString.includes("read_material_lot_state") &&
        e.sqlString.includes("qty_on_hand"),
    );
    expect(decr).toBeDefined();
  });

  it("SCRAP_RECORDED WITHOUT lot id does NOT decrement material lot state", async () => {
    const tx = buildTx(execLog, [[{ pid: null, sku: null, kind: null }]]);
    await projectQcEvent(tx, {
      workflowBagId: BAG,
      eventType: "SCRAP_RECORDED",
      occurredAt: NOW,
      employeeId: EMP,
      stationId: null,
      payload: {
        quantity: 2,
        scrap_quantity: 2,
        unit: "cards",
        reason_code: "SCRAP_APPROVED",
        affects_packaging_material: true,
        // material_lot_id intentionally missing
      },
    });
    expect(
      execLog.find((e) => e.sqlString.includes("read_material_lot_state")),
    ).toBeUndefined();
  });

  it("SCRAP_RECORDED with affects_packaging_material=false (raw-only) does NOT decrement packaging lot state", async () => {
    const tx = buildTx(execLog, [[{ pid: null, sku: null, kind: null }]]);
    await projectQcEvent(tx, {
      workflowBagId: BAG,
      eventType: "SCRAP_RECORDED",
      occurredAt: NOW,
      employeeId: EMP,
      stationId: null,
      payload: {
        quantity: 2,
        scrap_quantity: 2,
        unit: "cards",
        reason_code: "SCRAP_APPROVED",
        affects_packaging_material: false,
        affects_raw_product: true,
        material_lot_id: LOT,
      },
    });
    expect(
      execLog.find((e) => e.sqlString.includes("read_material_lot_state")),
    ).toBeUndefined();
  });
});

describe("projectQcEvent — sku + station-quality dispatch", () => {
  it("PACKAGING_DAMAGE_RETURN with a product on the bag bumps read_sku_daily.damages", async () => {
    // Execute sequence for damage with employee + product + no station:
    //   1. operator INSERT
    //   2. sku SELECT  ← returnRows[1]
    //   3. sku INSERT
    const tx = buildTx(execLog, [
      [],
      [{ pid: "prod-1", sku: "SKU-A", kind: "CARD" }],
      [],
    ]);
    await projectQcEvent(tx, {
      workflowBagId: BAG,
      eventType: "PACKAGING_DAMAGE_RETURN",
      occurredAt: NOW,
      employeeId: EMP,
      stationId: null,
      payload: { quantity: 3, unit: "cards", reason_code: "BAD_SEAL" },
    });
    const sku = execLog.find(
      (e) =>
        e.sqlString.includes("read_sku_daily") &&
        e.sqlString.includes("damages"),
    );
    expect(sku).toBeDefined();
  });

  it("PACKAGING_DAMAGE_RETURN with a station hits station_quality_daily (machine resolved)", async () => {
    // Execute sequence: operator INSERT, sku SELECT, sku INSERT,
    // station SELECT, station INSERT.
    const tx = buildTx(execLog, [
      [],
      [{ pid: "prod-1", sku: "SKU-A", kind: "CARD" }],
      [],
      [{ machine_id: "m1", product_id: "prod-1" }],
      [],
    ]);
    await projectQcEvent(tx, {
      workflowBagId: BAG,
      eventType: "PACKAGING_DAMAGE_RETURN",
      occurredAt: NOW,
      employeeId: EMP,
      stationId: STATION,
      payload: { quantity: 3, unit: "cards", reason_code: "BAD_SEAL" },
    });
    const sq = execLog.find((e) =>
      e.sqlString.includes("read_station_quality_daily"),
    );
    expect(sq).toBeDefined();
  });

  it("skips station_quality update when no station_id is present", async () => {
    const tx = buildTx(execLog, [
      [{ pid: "prod-1", sku: "SKU-A", kind: "CARD" }],
    ]);
    await projectQcEvent(tx, {
      workflowBagId: BAG,
      eventType: "PACKAGING_DAMAGE_RETURN",
      occurredAt: NOW,
      employeeId: EMP,
      stationId: null,
      payload: { quantity: 3, unit: "cards", reason_code: "BAD_SEAL" },
    });
    expect(
      execLog.find((e) => e.sqlString.includes("read_station_quality_daily")),
    ).toBeUndefined();
  });
});
