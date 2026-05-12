// QC-1 — payload contract tests.
//
// Pure-helper tests. No DB, no projector — these validate the Zod
// schemas at the module's API boundary. The point is to lock the
// contract so QC-2's emit-side helpers can rely on these shapes.

import { describe, expect, it } from "vitest";
import {
  QC_EVENT_TYPES,
  QC_REASON_CODES,
  qcPayloadSchemas,
  payloadHasAccountability,
  validatePackagingDamageReturnPayload,
  validateReworkSentPayload,
  validateReworkReceivedPayload,
  validateScrapRecordedPayload,
  validateSubmissionCorrectedPayload,
  validateQcPayload,
} from "./qc-events";
import * as schemaModule from "@/lib/db/schema";

// Fixed UUIDs — reused across builders so tests stay readable.
const U = {
  client: "11111111-1111-4111-8111-111111111111",
  bag: "22222222-2222-4222-8222-222222222222",
  product: "33333333-3333-4333-8333-333333333333",
  station: "44444444-4444-4444-8444-444444444444",
  station2: "55555555-5555-4555-8555-555555555555",
  machine: "66666666-6666-4666-8666-666666666666",
  matLot: "77777777-7777-4777-8777-777777777777",
  pkgLot: "88888888-8888-4888-8888-888888888888",
  employee: "99999999-9999-4999-8999-999999999999",
  user: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  linked: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  correctedEvent: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
};

function baseAccountability() {
  return {
    accountable_employee_id: U.employee,
    accountability_source: "STATION_OPERATOR_SESSION" as const,
    accountable_employee_name_snapshot: "Alice Operator",
    entered_by_user_id: null as string | null,
  };
}

// Builders — each returns a minimally-valid payload. Tests mutate
// returned objects to exercise specific failure modes.

function buildDamage() {
  return {
    client_event_id: U.client,
    quantity: 3,
    unit: "cards" as const,
    reason_code: "BAD_SEAL" as const,
    notes: null,
    photo_keys: null,
    bag_id: U.bag,
    product_id: U.product,
    station_id: U.station,
    machine_id: U.machine,
    material_lot_id: null,
    packaging_lot_id: U.pkgLot,
    damage_type: "BAD_SEAL" as const,
    disposition_suggestion: "REWORK" as const,
    ...baseAccountability(),
  };
}

function buildReworkSent() {
  return {
    client_event_id: U.client,
    quantity: 5,
    unit: "cards" as const,
    reason_code: "BAD_SEAL" as const,
    notes: null,
    photo_keys: null,
    bag_id: U.bag,
    from_station_id: U.station,
    to_station_id: U.station2,
    linked_event_id: U.linked,
    rework_reason: "BAD_SEAL" as const,
    expected_return_quantity: 5,
    ...baseAccountability(),
  };
}

function buildReworkReceivedFull() {
  return {
    client_event_id: U.client,
    quantity: 5,
    unit: "cards" as const,
    reason_code: "BAD_SEAL" as const,
    notes: null,
    photo_keys: null,
    bag_id: U.bag,
    from_station_id: U.station,
    to_station_id: U.station2,
    linked_event_id: U.linked,
    received_quantity: 5,
    partial: false,
    ...baseAccountability(),
  };
}

function buildReworkReceivedPartial() {
  return {
    ...buildReworkReceivedFull(),
    received_quantity: 3,
    partial: true,
  };
}

function buildScrap() {
  return {
    client_event_id: U.client,
    quantity: 2,
    unit: "cards" as const,
    reason_code: "SCRAP_APPROVED" as const,
    notes: null,
    photo_keys: null,
    bag_id: U.bag,
    material_lot_id: U.matLot,
    packaging_lot_id: null,
    linked_event_id: U.linked,
    scrap_quantity: 2,
    scrap_unit: "cards" as const,
    scrap_reason: "SCRAP_APPROVED" as const,
    correction_actor_user_id: U.user,
    correction_actor_employee_id: U.employee,
    ...baseAccountability(),
    // Supervisor scrap path: entered_by_user_id is the supervisor.
    entered_by_user_id: U.user,
    accountability_source: "SUPERVISOR_OVERRIDE" as const,
  };
}

function buildCorrection() {
  return {
    client_event_id: U.client,
    corrected_event_id: U.correctedEvent,
    corrected_event_type: "PACKAGING_COMPLETE",
    original_value: { master_cases: 10 },
    corrected_value: { master_cases: 11 },
    correction_reason: "SUPERVISOR_CORRECTION" as const,
    preserves_original_accountable_employee: true as const,
    notes: null,
    photo_keys: null,
    accountable_employee_id: U.employee,
    accountability_source: "SUPERVISOR_OVERRIDE" as const,
    accountable_employee_name_snapshot: "Alice Operator",
    entered_by_user_id: U.user,
  };
}

// ─── PACKAGING_DAMAGE_RETURN ───────────────────────────────────────────

describe("validatePackagingDamageReturnPayload", () => {
  it("accepts a minimal valid payload", () => {
    const r = validatePackagingDamageReturnPayload(buildDamage());
    expect(r.ok).toBe(true);
  });

  it("rejects missing accountability source", () => {
    const p: Record<string, unknown> = { ...buildDamage() };
    delete p.accountability_source;
    const r = validatePackagingDamageReturnPayload(p);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.issues.some((i) => i.path.includes("accountability_source"))).toBe(true);
    }
  });

  it("rejects missing accountable_employee_name_snapshot", () => {
    const p: Record<string, unknown> = { ...buildDamage() };
    delete p.accountable_employee_name_snapshot;
    const r = validatePackagingDamageReturnPayload(p);
    expect(r.ok).toBe(false);
  });

  it("rejects zero quantity", () => {
    const r = validatePackagingDamageReturnPayload({ ...buildDamage(), quantity: 0 });
    expect(r.ok).toBe(false);
  });

  it("rejects negative quantity", () => {
    const r = validatePackagingDamageReturnPayload({ ...buildDamage(), quantity: -1 });
    expect(r.ok).toBe(false);
  });

  it("rejects non-integer quantity", () => {
    const r = validatePackagingDamageReturnPayload({ ...buildDamage(), quantity: 1.5 });
    expect(r.ok).toBe(false);
  });

  it("rejects when damage_type disagrees with reason_code", () => {
    const r = validatePackagingDamageReturnPayload({
      ...buildDamage(),
      damage_type: "RIPPED_CARD",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.issues.some((i) => i.path.includes("damage_type"))).toBe(true);
    }
  });

  it("rejects unknown reason_code", () => {
    const r = validatePackagingDamageReturnPayload({
      ...buildDamage(),
      reason_code: "MADE_UP_CODE",
      damage_type: "MADE_UP_CODE",
    });
    expect(r.ok).toBe(false);
  });

  it("allows OTHER when notes are present", () => {
    const r = validatePackagingDamageReturnPayload({
      ...buildDamage(),
      reason_code: "OTHER",
      damage_type: "OTHER",
      notes: "carton split on third pass",
    });
    expect(r.ok).toBe(true);
  });

  it("rejects OTHER without notes", () => {
    const r = validatePackagingDamageReturnPayload({
      ...buildDamage(),
      reason_code: "OTHER",
      damage_type: "OTHER",
      notes: null,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.issues.some((i) => i.path.includes("notes"))).toBe(true);
    }
  });

  it("rejects OTHER with empty/whitespace notes", () => {
    const r = validatePackagingDamageReturnPayload({
      ...buildDamage(),
      reason_code: "OTHER",
      damage_type: "OTHER",
      notes: "   ",
    });
    expect(r.ok).toBe(false);
  });
});

// ─── REWORK_SENT ───────────────────────────────────────────────────────

describe("validateReworkSentPayload", () => {
  it("accepts a minimal valid payload", () => {
    expect(validateReworkSentPayload(buildReworkSent()).ok).toBe(true);
  });

  it("rejects rework_reason mismatch with reason_code", () => {
    const r = validateReworkSentPayload({
      ...buildReworkSent(),
      rework_reason: "MACHINE_SETUP",
    });
    expect(r.ok).toBe(false);
  });

  it("rejects missing accountability_source", () => {
    const p: Record<string, unknown> = { ...buildReworkSent() };
    delete p.accountability_source;
    expect(validateReworkSentPayload(p).ok).toBe(false);
  });

  it("rejects zero quantity", () => {
    expect(
      validateReworkSentPayload({ ...buildReworkSent(), quantity: 0 }).ok,
    ).toBe(false);
  });

  it("allows null linked_event_id (direct rework with no preceding damage row)", () => {
    expect(
      validateReworkSentPayload({
        ...buildReworkSent(),
        linked_event_id: null,
      }).ok,
    ).toBe(true);
  });
});

// ─── REWORK_RECEIVED ───────────────────────────────────────────────────

describe("validateReworkReceivedPayload", () => {
  it("accepts a full receive (partial=false, received_quantity==quantity)", () => {
    expect(validateReworkReceivedPayload(buildReworkReceivedFull()).ok).toBe(true);
  });

  it("accepts a partial receive (partial=true, received_quantity<quantity)", () => {
    expect(validateReworkReceivedPayload(buildReworkReceivedPartial()).ok).toBe(true);
  });

  it("rejects zero received_quantity", () => {
    expect(
      validateReworkReceivedPayload({
        ...buildReworkReceivedFull(),
        received_quantity: 0,
      }).ok,
    ).toBe(false);
  });

  it("rejects partial=false when received_quantity<quantity", () => {
    const r = validateReworkReceivedPayload({
      ...buildReworkReceivedFull(),
      received_quantity: 3,
      partial: false,
    });
    expect(r.ok).toBe(false);
  });

  it("rejects partial=true when received_quantity==quantity (should be a full receive)", () => {
    const r = validateReworkReceivedPayload({
      ...buildReworkReceivedFull(),
      partial: true,
    });
    expect(r.ok).toBe(false);
  });

  it("rejects missing accountability_source", () => {
    const p: Record<string, unknown> = { ...buildReworkReceivedFull() };
    delete p.accountability_source;
    expect(validateReworkReceivedPayload(p).ok).toBe(false);
  });
});

// ─── SCRAP_RECORDED ────────────────────────────────────────────────────

describe("validateScrapRecordedPayload", () => {
  it("accepts scrap with material_lot_id", () => {
    expect(validateScrapRecordedPayload(buildScrap()).ok).toBe(true);
  });

  it("accepts scrap with bag_id only", () => {
    const p: Record<string, unknown> = { ...buildScrap() };
    p.material_lot_id = null;
    p.packaging_lot_id = null;
    expect(validateScrapRecordedPayload(p).ok).toBe(true);
  });

  it("accepts scrap with packaging_lot_id only", () => {
    const p: Record<string, unknown> = { ...buildScrap() };
    p.bag_id = null;
    p.material_lot_id = null;
    p.packaging_lot_id = U.pkgLot;
    expect(validateScrapRecordedPayload(p).ok).toBe(true);
  });

  it("rejects scrap with no affected scope (bag, mat-lot, pkg-lot all null)", () => {
    const p: Record<string, unknown> = { ...buildScrap() };
    p.bag_id = null;
    p.material_lot_id = null;
    p.packaging_lot_id = null;
    const r = validateScrapRecordedPayload(p);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(
        r.issues.some((i) =>
          (i.message ?? "").toLowerCase().includes("scope") ||
          (i.message ?? "").toLowerCase().includes("at least one"),
        ),
      ).toBe(true);
    }
  });

  it("rejects scrap_reason mismatch with reason_code", () => {
    expect(
      validateScrapRecordedPayload({
        ...buildScrap(),
        scrap_reason: "MACHINE_SETUP",
      }).ok,
    ).toBe(false);
  });

  it("rejects zero scrap_quantity", () => {
    expect(
      validateScrapRecordedPayload({ ...buildScrap(), scrap_quantity: 0 }).ok,
    ).toBe(false);
  });
});

// ─── SUBMISSION_CORRECTED ──────────────────────────────────────────────

describe("validateSubmissionCorrectedPayload", () => {
  it("accepts a minimal valid correction", () => {
    expect(validateSubmissionCorrectedPayload(buildCorrection()).ok).toBe(true);
  });

  it("rejects missing corrected_event_id", () => {
    const p: Record<string, unknown> = { ...buildCorrection() };
    delete p.corrected_event_id;
    expect(validateSubmissionCorrectedPayload(p).ok).toBe(false);
  });

  it("rejects preserves_original_accountable_employee=false (literal-true contract)", () => {
    expect(
      validateSubmissionCorrectedPayload({
        ...buildCorrection(),
        preserves_original_accountable_employee: false,
      }).ok,
    ).toBe(false);
  });

  it("rejects missing entered_by_user_id (correction always requires a supervisor)", () => {
    expect(
      validateSubmissionCorrectedPayload({
        ...buildCorrection(),
        entered_by_user_id: null,
      }).ok,
    ).toBe(false);
  });

  it("rejects unknown correction_reason", () => {
    expect(
      validateSubmissionCorrectedPayload({
        ...buildCorrection(),
        correction_reason: "MADE_UP",
      }).ok,
    ).toBe(false);
  });

  it("allows OTHER correction_reason when notes present", () => {
    expect(
      validateSubmissionCorrectedPayload({
        ...buildCorrection(),
        correction_reason: "OTHER",
        notes: "manual correction per supervisor John on 2026-05-12",
      }).ok,
    ).toBe(true);
  });

  it("rejects OTHER correction_reason without notes", () => {
    expect(
      validateSubmissionCorrectedPayload({
        ...buildCorrection(),
        correction_reason: "OTHER",
        notes: null,
      }).ok,
    ).toBe(false);
  });
});

// ─── Dispatch / metadata ───────────────────────────────────────────────

describe("validateQcPayload dispatch", () => {
  it("routes each event type to its schema", () => {
    expect(validateQcPayload("PACKAGING_DAMAGE_RETURN", buildDamage()).ok).toBe(true);
    expect(validateQcPayload("REWORK_SENT", buildReworkSent()).ok).toBe(true);
    expect(validateQcPayload("REWORK_RECEIVED", buildReworkReceivedFull()).ok).toBe(true);
    expect(validateQcPayload("SCRAP_RECORDED", buildScrap()).ok).toBe(true);
    expect(validateQcPayload("SUBMISSION_CORRECTED", buildCorrection()).ok).toBe(true);
  });
});

describe("module metadata", () => {
  it("declares all five QC event types", () => {
    expect(QC_EVENT_TYPES).toEqual([
      "PACKAGING_DAMAGE_RETURN",
      "REWORK_SENT",
      "REWORK_RECEIVED",
      "SCRAP_RECORDED",
      "SUBMISSION_CORRECTED",
    ]);
  });

  it("ships a schema for every event type", () => {
    for (const t of QC_EVENT_TYPES) {
      expect(qcPayloadSchemas[t]).toBeDefined();
    }
  });

  it("includes all required reason codes", () => {
    const required = [
      "DAMAGED_PACKAGING",
      "RIPPED_CARD",
      "BAD_SEAL",
      "LABEL_ISSUE",
      "COUNT_VARIANCE",
      "WRONG_MATERIAL",
      "MACHINE_SETUP",
      "OPERATOR_ERROR",
      "SUPPLIER_DEFECT",
      "CONTAMINATION_RISK",
      "REWORK_NEEDED",
      "SCRAP_APPROVED",
      "SUPERVISOR_CORRECTION",
      "OTHER",
    ];
    for (const code of required) {
      expect((QC_REASON_CODES as ReadonlyArray<string>).includes(code)).toBe(true);
    }
  });

  it("the five QC types are present in the workflow_event enum on schema.ts", () => {
    // schema.ts pgEnum stores values on .enumValues
    const enumValues = (schemaModule.workflowEventTypeEnum as unknown as {
      enumValues: readonly string[];
    }).enumValues;
    for (const t of QC_EVENT_TYPES) {
      expect(enumValues).toContain(t);
    }
  });
});

describe("payloadHasAccountability", () => {
  it("returns true for a payload carrying valid source + non-empty name snapshot", () => {
    expect(
      payloadHasAccountability({
        accountability_source: "STATION_OPERATOR_SESSION",
        accountable_employee_name_snapshot: "Alice Operator",
      }),
    ).toBe(true);
  });

  it("returns false when source is missing", () => {
    expect(
      payloadHasAccountability({
        accountable_employee_name_snapshot: "Alice Operator",
      }),
    ).toBe(false);
  });

  it("returns false when source is not in the enum", () => {
    expect(
      payloadHasAccountability({
        accountability_source: "NOT_A_SOURCE",
        accountable_employee_name_snapshot: "Alice Operator",
      }),
    ).toBe(false);
  });

  it("returns false when name snapshot is empty/whitespace", () => {
    expect(
      payloadHasAccountability({
        accountability_source: "STATION_OPERATOR_SESSION",
        accountable_employee_name_snapshot: "   ",
      }),
    ).toBe(false);
  });

  it("returns false on null/undefined input", () => {
    expect(payloadHasAccountability(null)).toBe(false);
    expect(payloadHasAccountability(undefined)).toBe(false);
  });
});

describe("schema.ts mirrors migration 0026", () => {
  it("read_operator_daily exposes the five QC counter columns as Drizzle columns", () => {
    // Drizzle pgTable attaches each column object as a property on the
    // table at runtime. We don't introspect column metadata directly
    // (its API has shifted across drizzle versions); we only assert the
    // canonical TS-side property exists.
    const t = schemaModule.readOperatorDaily as unknown as Record<
      string,
      unknown
    >;
    for (const expected of [
      "damageEventsTotal",
      "reworkSentTotal",
      "reworkReceivedTotal",
      "scrapUnitsTotal",
      "correctionsTotal",
    ]) {
      expect(t[expected]).toBeDefined();
    }
  });

  it("migration 0026 SQL is registered in the journal", async () => {
    // Read the journal at runtime; avoids relying on resolveJsonModule
    // and survives whatever the next migration tag turns out to be — we
    // just need 0026_qc_subsystem_foundation to be present.
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const url = await import("node:url");
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const journalPath = path.resolve(here, "../../drizzle/meta/_journal.json");
    const raw = await fs.readFile(journalPath, "utf8");
    const journal = JSON.parse(raw) as {
      entries: Array<{ idx: number; tag: string; when: number }>;
    };
    const qc = journal.entries.find(
      (e) => e.tag === "0026_qc_subsystem_foundation",
    );
    expect(qc).toBeDefined();
    expect(qc?.idx).toBe(26);
    // QC-1 invariant: our new entry's `when` strictly exceeds the
    // immediately-preceding entry's `when`. Drizzle's pg migrator
    // compares each entry's `when` against the latest applied
    // `created_at`; a non-increasing step at the tail would let the
    // new migration silently skip on populated DBs.
    //
    // The journal as a whole is NOT strictly monotonic (entries at
    // idx 9↔10 are inverted from a prior phase); we only assert that
    // QC-1's tail is well-formed against the previous entry.
    const byIdx = [...journal.entries].sort((a, b) => a.idx - b.idx);
    const qcAt = byIdx.findIndex((e) => e.idx === 26);
    expect(qcAt).toBeGreaterThan(0);
    expect(byIdx[qcAt]!.when).toBeGreaterThan(byIdx[qcAt - 1]!.when);
  });

  it("migration 0026 SQL file declares the expected DDL", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const url = await import("node:url");
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const sqlPath = path.resolve(
      here,
      "../../drizzle/0026_qc_subsystem_foundation.sql",
    );
    const sql = await fs.readFile(sqlPath, "utf8");
    // Five new counter columns on read_operator_daily.
    expect(sql).toContain("damage_events_total");
    expect(sql).toContain("rework_sent_total");
    expect(sql).toContain("rework_received_total");
    expect(sql).toContain("scrap_units_total");
    expect(sql).toContain("corrections_total");
    // Linked-event lookup index + partial-unique resolution guard.
    expect(sql).toContain("workflow_events_linked_event_idx");
    expect(sql).toContain("workflow_events_linked_event_resolution_unique");
    expect(sql).toContain("SCRAP_RECORDED");
    expect(sql).toContain("REWORK_SENT");
  });
});
