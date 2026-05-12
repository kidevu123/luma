// QC-2 — server-action behavior tests.
//
// These exercise the wiring of each of the five QC actions through
// mocked db / auth / projectEvent / accountability layers. The pure
// payload-validation rules already have coverage in qc-events.test.ts;
// these tests focus on action-layer behavior:
//
//   - the right event type and payload shape reach projectEvent
//   - accountability fields propagate (employee_id, user_id, source,
//     name snapshot) — no anonymous QC events leave the action
//   - damage refuses when no operator session and no override resolve
//   - scrap refuses without an affected scope OR a workflow_bag_id
//   - correction preserves the linked event's accountable employee
//     and records the supervisor as entered_by_user_id
//   - duplicate scrap/rework conversion is detected and rejected via
//     the in-tx conflict guard (the DB partial-unique is the backstop)

import { describe, expect, it, vi, beforeEach } from "vitest";

// ─── Module mocks (must precede any import that pulls them in) ─────────

type Captured = {
  /** Latest projectEvent call's second argument. */
  lastEvent: Record<string, unknown> | null;
  /** All projectEvent calls in order. */
  events: Array<Record<string, unknown>>;
  /** Latest audit row. */
  lastAudit: Record<string, unknown> | null;
  /** Queue of execute() results to dispense in FIFO order. */
  execQueue: Array<Array<unknown>>;
};

const captured: Captured = {
  lastEvent: null,
  events: [],
  lastAudit: null,
  execQueue: [],
};

function buildTx() {
  return {
    execute: async (..._args: unknown[]) => {
      const next = captured.execQueue.shift();
      return next ?? [];
    },
    select: () => ({
      from: () => ({
        where: () => Promise.resolve([]),
      }),
    }),
  } as unknown as Parameters<typeof projectEventModule.projectEvent>[0];
}

vi.mock("@/lib/db", () => ({
  db: {
    transaction: async (cb: (tx: unknown) => Promise<unknown>) => cb(buildTx()),
    select: () => ({
      from: () => ({
        where: () => Promise.resolve([fakeStation]),
      }),
    }),
  },
}));

vi.mock("@/lib/db/audit", () => ({
  writeAudit: async (row: Record<string, unknown>) => {
    captured.lastAudit = row;
  },
}));

vi.mock("@/lib/projector", () => ({
  projectEvent: vi.fn(async (_tx: unknown, ev: Record<string, unknown>) => {
    captured.events.push(ev);
    captured.lastEvent = ev;
  }),
}));

vi.mock("@/lib/auth-guards", () => ({
  requireAdmin: async () => fakeAdmin,
}));

vi.mock("@/lib/production/station-operator-session", () => ({
  resolveStationAccountability: vi.fn(async () => stationAccountability),
  resolveAdminAccountability: vi.fn(async () => adminAccountability),
  withAccountabilityPayload: (p: Record<string, unknown>) => p,
}));

vi.mock("next/cache", () => ({
  revalidatePath: () => {},
}));

// Import AFTER the mocks above are registered.
import * as projectEventModule from "@/lib/projector";
import {
  reportPackagingDamageAction,
  reworkSentAction,
  reworkReceivedAction,
} from "@/app/(floor)/floor/[token]/qc-actions";
import {
  scrapRecordedAction,
  submissionCorrectedAction,
} from "@/app/(admin)/qc-review/actions";

// ─── Test fixtures ─────────────────────────────────────────────────────

const STATION_TOKEN = "11111111-1111-4111-8111-111111111111";
const STATION_ID = "22222222-2222-4222-8222-222222222222";
const BAG_ID = "33333333-3333-4333-8333-333333333333";
const PRODUCT_ID = "44444444-4444-4444-8444-444444444444";
const MACHINE_ID = "55555555-5555-4555-8555-555555555555";
const PKG_LOT_ID = "66666666-6666-4666-8666-666666666666";
const EMPLOYEE_ID = "77777777-7777-4777-8777-777777777777";
const ADMIN_USER_ID = "88888888-8888-4888-8888-888888888888";
const LINKED_EVENT_ID = "99999999-9999-4999-8999-999999999999";
const CORRECTED_EVENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CLIENT_EVENT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const fakeStation = {
  id: STATION_ID,
  scanToken: STATION_TOKEN,
  label: "P-1",
  kind: "PACKAGING",
  machineId: null,
  isActive: true,
  createdAt: new Date(),
} as unknown as Record<string, unknown>;

const fakeAdmin = {
  id: ADMIN_USER_ID,
  email: "admin@luma",
  role: "OWNER" as const,
  // Supervisor's own employee_id. Lives on the payload as
  // correction_actor_employee_id; never as the accountable_employee_id
  // on a linked-event scrap/correction.
  employeeId: "ccccccc1-cccc-4ccc-8ccc-cccccccccccc",
};

type AccountabilityForEvent = {
  enteredByUserId: string | null;
  accountableEmployeeId: string | null;
  accountabilitySource: string | null;
  accountableEmployeeNameSnapshot: string | null;
  isStable: boolean;
};

let stationAccountability: AccountabilityForEvent = {
  enteredByUserId: null,
  accountableEmployeeId: EMPLOYEE_ID,
  accountabilitySource: "STATION_OPERATOR_SESSION",
  accountableEmployeeNameSnapshot: "Alice Operator",
  isStable: true,
};

let adminAccountability: AccountabilityForEvent = {
  enteredByUserId: ADMIN_USER_ID,
  accountableEmployeeId: EMPLOYEE_ID,
  accountabilitySource: "SUPERVISOR_OVERRIDE",
  accountableEmployeeNameSnapshot: "Alice Operator",
  isStable: true,
};

function fd(record: Record<string, string | null>): FormData {
  const data = new FormData();
  for (const [k, v] of Object.entries(record)) {
    if (v !== null) data.set(k, v);
  }
  return data;
}

beforeEach(() => {
  captured.lastEvent = null;
  captured.events = [];
  captured.lastAudit = null;
  captured.execQueue = [];
  stationAccountability = {
    enteredByUserId: null,
    accountableEmployeeId: EMPLOYEE_ID,
    accountabilitySource: "STATION_OPERATOR_SESSION",
    accountableEmployeeNameSnapshot: "Alice Operator",
    isStable: true,
  };
  adminAccountability = {
    enteredByUserId: ADMIN_USER_ID,
    accountableEmployeeId: EMPLOYEE_ID,
    accountabilitySource: "SUPERVISOR_OVERRIDE",
    accountableEmployeeNameSnapshot: "Alice Operator",
    isStable: true,
  };
});

// ─── 1. reportPackagingDamageAction ────────────────────────────────────

describe("reportPackagingDamageAction", () => {
  it("emits PACKAGING_DAMAGE_RETURN with full OP-1 accountability", async () => {
    const r = await reportPackagingDamageAction(
      fd({
        token: STATION_TOKEN,
        stationId: STATION_ID,
        clientEventId: CLIENT_EVENT_ID,
        bagId: BAG_ID,
        quantity: "3",
        unit: "cards",
        reasonCode: "BAD_SEAL",
        productId: PRODUCT_ID,
        machineId: MACHINE_ID,
        packagingLotId: PKG_LOT_ID,
        dispositionSuggestion: "REWORK",
      }),
    );
    expect(r).toEqual({ ok: true });
    expect(captured.events).toHaveLength(1);
    const ev = captured.lastEvent!;
    expect(ev.eventType).toBe("PACKAGING_DAMAGE_RETURN");
    expect(ev.workflowBagId).toBe(BAG_ID);
    expect(ev.stationId).toBe(STATION_ID);
    expect(ev.clientEventId).toBe(CLIENT_EVENT_ID);
    expect(ev.accountableEmployeeId).toBe(EMPLOYEE_ID);
    expect(ev.accountabilitySource).toBe("STATION_OPERATOR_SESSION");
    expect(ev.accountableEmployeeNameSnapshot).toBe("Alice Operator");
    expect(ev.enteredByUserId).toBe(null);
    const p = ev.payload as Record<string, unknown>;
    expect(p.bag_id).toBe(BAG_ID);
    expect(p.quantity).toBe(3);
    expect(p.unit).toBe("cards");
    expect(p.reason_code).toBe("BAD_SEAL");
    expect(p.damage_type).toBe("BAD_SEAL");
    expect(p.disposition_suggestion).toBe("REWORK");
    expect(p.packaging_lot_id).toBe(PKG_LOT_ID);
    expect(p.accountability_source).toBe("STATION_OPERATOR_SESSION");
    expect(p.accountable_employee_name_snapshot).toBe("Alice Operator");
  });

  it("refuses to fire when no operator session and no override resolves", async () => {
    stationAccountability = {
      enteredByUserId: null,
      accountableEmployeeId: null,
      accountabilitySource: null,
      accountableEmployeeNameSnapshot: null,
      isStable: false,
    };
    const r = await reportPackagingDamageAction(
      fd({
        token: STATION_TOKEN,
        stationId: STATION_ID,
        clientEventId: CLIENT_EVENT_ID,
        bagId: BAG_ID,
        quantity: "3",
        unit: "cards",
        reasonCode: "BAD_SEAL",
      }),
    );
    expect(r.error).toMatch(/no operator on shift/i);
    expect(captured.events).toHaveLength(0);
  });

  it("rejects zero quantity at the action's Zod boundary", async () => {
    const r = await reportPackagingDamageAction(
      fd({
        token: STATION_TOKEN,
        stationId: STATION_ID,
        clientEventId: CLIENT_EVENT_ID,
        bagId: BAG_ID,
        quantity: "0",
        unit: "cards",
        reasonCode: "BAD_SEAL",
      }),
    );
    expect(r.error).toBeDefined();
    expect(captured.events).toHaveLength(0);
  });
});

// ─── 2. reworkSentAction ───────────────────────────────────────────────

describe("reworkSentAction", () => {
  it("emits REWORK_SENT with linked source, locks source, no duplicate", async () => {
    // First execute() = source row exists; second = no existing resolution.
    captured.execQueue.push([{ id: LINKED_EVENT_ID }], []);
    const r = await reworkSentAction(
      fd({
        token: STATION_TOKEN,
        stationId: STATION_ID,
        clientEventId: CLIENT_EVENT_ID,
        bagId: BAG_ID,
        quantity: "5",
        unit: "cards",
        reasonCode: "BAD_SEAL",
        linkedEventId: LINKED_EVENT_ID,
      }),
    );
    expect(r).toEqual({ ok: true });
    const ev = captured.lastEvent!;
    expect(ev.eventType).toBe("REWORK_SENT");
    const p = ev.payload as Record<string, unknown>;
    expect(p.linked_event_id).toBe(LINKED_EVENT_ID);
    expect(p.rework_reason).toBe("BAD_SEAL");
    expect(ev.accountableEmployeeId).toBe(EMPLOYEE_ID);
  });

  it("returns a conflict when source already has a REWORK_SENT resolution", async () => {
    // Source exists; existing resolution row exists.
    captured.execQueue.push([{ id: LINKED_EVENT_ID }], [{ "?column?": 1 }]);
    const r = await reworkSentAction(
      fd({
        token: STATION_TOKEN,
        stationId: STATION_ID,
        clientEventId: CLIENT_EVENT_ID,
        bagId: BAG_ID,
        quantity: "5",
        unit: "cards",
        reasonCode: "BAD_SEAL",
        linkedEventId: LINKED_EVENT_ID,
      }),
    );
    expect(r.conflict).toBe(true);
    expect(r.error).toMatch(/already has a rework_sent/i);
    expect(captured.events).toHaveLength(0);
  });

  it("allows unlinked rework with no conflict check", async () => {
    const r = await reworkSentAction(
      fd({
        token: STATION_TOKEN,
        stationId: STATION_ID,
        clientEventId: CLIENT_EVENT_ID,
        bagId: BAG_ID,
        quantity: "5",
        unit: "cards",
        reasonCode: "BAD_SEAL",
      }),
    );
    expect(r).toEqual({ ok: true });
    expect(captured.lastEvent!.eventType).toBe("REWORK_SENT");
    const p = captured.lastEvent!.payload as Record<string, unknown>;
    expect(p.linked_event_id).toBeNull();
  });
});

// ─── 3. reworkReceivedAction ───────────────────────────────────────────

describe("reworkReceivedAction", () => {
  it("emits REWORK_RECEIVED when linked REWORK_SENT exists (full receive)", async () => {
    captured.execQueue.push([{ id: LINKED_EVENT_ID }]); // linked exists
    const r = await reworkReceivedAction(
      fd({
        token: STATION_TOKEN,
        stationId: STATION_ID,
        clientEventId: CLIENT_EVENT_ID,
        bagId: BAG_ID,
        quantity: "5",
        unit: "cards",
        reasonCode: "BAD_SEAL",
        linkedEventId: LINKED_EVENT_ID,
        receivedQuantity: "5",
        partial: "false",
      }),
    );
    expect(r).toEqual({ ok: true });
    const ev = captured.lastEvent!;
    expect(ev.eventType).toBe("REWORK_RECEIVED");
    const p = ev.payload as Record<string, unknown>;
    expect(p.received_quantity).toBe(5);
    expect(p.partial).toBe(false);
    expect(p.linked_event_id).toBe(LINKED_EVENT_ID);
  });

  it("allows partial receive (received_quantity<quantity, partial=true)", async () => {
    captured.execQueue.push([{ id: LINKED_EVENT_ID }]);
    const r = await reworkReceivedAction(
      fd({
        token: STATION_TOKEN,
        stationId: STATION_ID,
        clientEventId: CLIENT_EVENT_ID,
        bagId: BAG_ID,
        quantity: "5",
        unit: "cards",
        reasonCode: "BAD_SEAL",
        linkedEventId: LINKED_EVENT_ID,
        receivedQuantity: "3",
        partial: "true",
      }),
    );
    expect(r).toEqual({ ok: true });
    const p = captured.lastEvent!.payload as Record<string, unknown>;
    expect(p.partial).toBe(true);
    expect(p.received_quantity).toBe(3);
  });

  it("refuses when linked REWORK_SENT not found", async () => {
    captured.execQueue.push([]); // linked missing
    const r = await reworkReceivedAction(
      fd({
        token: STATION_TOKEN,
        stationId: STATION_ID,
        clientEventId: CLIENT_EVENT_ID,
        bagId: BAG_ID,
        quantity: "5",
        unit: "cards",
        reasonCode: "BAD_SEAL",
        linkedEventId: LINKED_EVENT_ID,
        receivedQuantity: "5",
        partial: "false",
      }),
    );
    expect(r.error).toMatch(/linked rework_sent event not found/i);
    expect(captured.events).toHaveLength(0);
  });
});

// ─── 4. scrapRecordedAction ────────────────────────────────────────────

describe("scrapRecordedAction", () => {
  it("preserves linked event's accountable employee; supervisor is entered_by", async () => {
    // 1) loadLinkedEventAccountability returns the linked row.
    captured.execQueue.push([
      {
        workflowBagId: BAG_ID,
        employeeId: EMPLOYEE_ID,
        eventType: "PACKAGING_DAMAGE_RETURN",
        source: "STATION_OPERATOR_SESSION",
        nameSnapshot: "Alice Operator",
      },
    ]);
    // 2) hasExistingResolution returns empty (no dup).
    captured.execQueue.push([]);

    const r = await scrapRecordedAction(
      fd({
        clientEventId: CLIENT_EVENT_ID,
        workflowBagId: BAG_ID,
        linkedEventId: LINKED_EVENT_ID,
        quantity: "2",
        unit: "cards",
        reasonCode: "SCRAP_APPROVED",
        scrapQuantity: "2",
        scrapUnit: "cards",
        affectsRawProduct: "false",
        affectsPackagingMaterial: "true",
        materialLotId: PKG_LOT_ID,
      }),
    );
    expect(r).toEqual({ ok: true });
    const ev = captured.lastEvent!;
    expect(ev.eventType).toBe("SCRAP_RECORDED");
    // CRITICAL: accountable employee is preserved from linked event,
    // not flipped to the supervisor.
    expect(ev.accountableEmployeeId).toBe(EMPLOYEE_ID);
    expect(ev.enteredByUserId).toBe(ADMIN_USER_ID);
    const p = ev.payload as Record<string, unknown>;
    expect(p.accountable_employee_id).toBe(EMPLOYEE_ID);
    expect(p.correction_actor_user_id).toBe(ADMIN_USER_ID);
    expect(p.entered_by_user_id).toBe(ADMIN_USER_ID);
    expect(p.linked_event_id).toBe(LINKED_EVENT_ID);
    expect(p.affects_packaging_material).toBe(true);
    expect(p.affects_raw_product).toBe(false);
  });

  it("rejects duplicate conversion of the same damage return", async () => {
    // linked exists with the same shape, then duplicate row found.
    captured.execQueue.push([
      {
        workflowBagId: BAG_ID,
        employeeId: EMPLOYEE_ID,
        eventType: "PACKAGING_DAMAGE_RETURN",
        source: "STATION_OPERATOR_SESSION",
        nameSnapshot: "Alice Operator",
      },
    ]);
    captured.execQueue.push([{ "?column?": 1 }]);

    const r = await scrapRecordedAction(
      fd({
        clientEventId: CLIENT_EVENT_ID,
        workflowBagId: BAG_ID,
        linkedEventId: LINKED_EVENT_ID,
        quantity: "2",
        unit: "cards",
        reasonCode: "SCRAP_APPROVED",
        scrapQuantity: "2",
        scrapUnit: "cards",
        affectsRawProduct: "false",
        affectsPackagingMaterial: "true",
        materialLotId: PKG_LOT_ID,
      }),
    );
    expect(r.conflict).toBe(true);
    expect(r.error).toMatch(/already has a scrap_recorded/i);
    expect(captured.events).toHaveLength(0);
  });

  it("rejects when no affected scope is set (neither raw nor packaging)", async () => {
    const r = await scrapRecordedAction(
      fd({
        clientEventId: CLIENT_EVENT_ID,
        workflowBagId: BAG_ID,
        quantity: "2",
        unit: "cards",
        reasonCode: "SCRAP_APPROVED",
        scrapQuantity: "2",
        scrapUnit: "cards",
        affectsRawProduct: "false",
        affectsPackagingMaterial: "false",
        overrideEmployeeId: EMPLOYEE_ID,
      }),
    );
    expect(r.error).toMatch(/must affect raw product, packaging material/i);
    expect(captured.events).toHaveLength(0);
  });

  it("rejects ad-hoc scrap without an explicit accountable employee", async () => {
    const r = await scrapRecordedAction(
      fd({
        clientEventId: CLIENT_EVENT_ID,
        workflowBagId: BAG_ID,
        quantity: "2",
        unit: "cards",
        reasonCode: "SCRAP_APPROVED",
        scrapQuantity: "2",
        scrapUnit: "cards",
        affectsRawProduct: "false",
        affectsPackagingMaterial: "true",
        materialLotId: PKG_LOT_ID,
      }),
    );
    expect(r.error).toMatch(
      /ad-hoc scrap requires the accountable operator to be selected explicitly/i,
    );
    expect(captured.events).toHaveLength(0);
  });
});

// ─── 5. submissionCorrectedAction ──────────────────────────────────────

describe("submissionCorrectedAction", () => {
  it("preserves original accountable employee, supervisor is entered_by", async () => {
    captured.execQueue.push([
      {
        workflowBagId: BAG_ID,
        employeeId: EMPLOYEE_ID,
        eventType: "PACKAGING_COMPLETE",
        source: "STATION_OPERATOR_SESSION",
        nameSnapshot: "Alice Operator",
      },
    ]);

    const r = await submissionCorrectedAction(
      fd({
        clientEventId: CLIENT_EVENT_ID,
        correctedEventId: CORRECTED_EVENT_ID,
        correctedEventType: "PACKAGING_COMPLETE",
        correctionReason: "SUPERVISOR_CORRECTION",
        originalValueJson: JSON.stringify({ master_cases: 10 }),
        correctedValueJson: JSON.stringify({ master_cases: 11 }),
        notes: "miscount on third stack",
      }),
    );
    expect(r).toEqual({ ok: true });
    const ev = captured.lastEvent!;
    expect(ev.eventType).toBe("SUBMISSION_CORRECTED");
    expect(ev.accountableEmployeeId).toBe(EMPLOYEE_ID);
    expect(ev.enteredByUserId).toBe(ADMIN_USER_ID);
    const p = ev.payload as Record<string, unknown>;
    expect(p.corrected_event_id).toBe(CORRECTED_EVENT_ID);
    expect(p.preserves_original_accountable_employee).toBe(true);
    expect(p.entered_by_user_id).toBe(ADMIN_USER_ID);
    expect(p.original_value).toEqual({ master_cases: 10 });
    expect(p.corrected_value).toEqual({ master_cases: 11 });
  });

  it("rejects when corrected_event_id resolves to no row", async () => {
    captured.execQueue.push([]); // linked event not found
    const r = await submissionCorrectedAction(
      fd({
        clientEventId: CLIENT_EVENT_ID,
        correctedEventId: CORRECTED_EVENT_ID,
        correctedEventType: "PACKAGING_COMPLETE",
        correctionReason: "SUPERVISOR_CORRECTION",
        originalValueJson: JSON.stringify({ master_cases: 10 }),
        correctedValueJson: JSON.stringify({ master_cases: 11 }),
      }),
    );
    expect(r.error).toMatch(/linked event not found/i);
    expect(captured.events).toHaveLength(0);
  });

  it("rejects invalid JSON in original/corrected value", async () => {
    const r = await submissionCorrectedAction(
      fd({
        clientEventId: CLIENT_EVENT_ID,
        correctedEventId: CORRECTED_EVENT_ID,
        correctedEventType: "PACKAGING_COMPLETE",
        correctionReason: "SUPERVISOR_CORRECTION",
        originalValueJson: "not-json",
        correctedValueJson: JSON.stringify({ master_cases: 11 }),
      }),
    );
    expect(r.error).toMatch(/must be valid json/i);
    expect(captured.events).toHaveLength(0);
  });
});
