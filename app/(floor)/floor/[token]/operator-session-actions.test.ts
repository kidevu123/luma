import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const actionsSrc = readFileSync(
  join(__dirname, "operator-session-actions.ts"),
  "utf8",
);
const formSrc = readFileSync(
  join(__dirname, "operator-session-form.tsx"),
  "utf8",
);

describe("OPERATOR-SHIFT-SUBMIT-BLOCK-1 · open session action schema", () => {
  it("accepts employeeId for picker path", () => {
    expect(actionsSrc).toMatch(/employeeId: z\.string\(\)\.uuid\(\)/);
    expect(actionsSrc).toMatch(/formData\.get\("employeeId"\)/);
  });

  it("resolves picker with EMPLOYEE_PICKER source hint", () => {
    expect(actionsSrc).toMatch(/employeeId, sourceHint: "EMPLOYEE_PICKER"/);
  });

  it("blocks free-text-only open on first-op count stations", () => {
    expect(actionsSrc).toMatch(/FIRST_OP_COUNT_ACCOUNTABILITY_STATION_KINDS/);
    expect(actionsSrc).toMatch(
      /Free-text name alone cannot open a shift on this station/,
    );
  });

  it("refuses session insert when stable employee required but unresolved", () => {
    expect(actionsSrc).toMatch(/requiresStableEmployee && !r\.accountableEmployeeId/);
  });
});

describe("OPERATOR-SHIFT-SUBMIT-BLOCK-1 · operator session form UI", () => {
  it("passes employeeId when picker selects (not freeText fallback)", () => {
    expect(formSrc).toMatch(/fd\.set\("employeeId", picked\)/);
    expect(formSrc).not.toMatch(/fd\.set\("freeText", match\.fullName\)/);
  });

  it("shows low-confidence warning when employeeId is null on count stations", () => {
    expect(formSrc).toMatch(/Low-confidence shift/);
    expect(formSrc).toMatch(/sessionSatisfiesFirstOpCount/);
    expect(formSrc).toMatch(/before submitting the first count/);
  });

  it("hides free-text open shift field on first-op count stations only", () => {
    expect(formSrc).toMatch(/requiresStableEmployee/);
    expect(formSrc).toMatch(/!requiresStableEmployee \?/);
    expect(formSrc).toMatch(/Full name \(last resort/);
  });

  it("page passes stationKind into OperatorSessionPanel", () => {
    const pageSrc = readFileSync(join(__dirname, "page.tsx"), "utf8");
    expect(pageSrc).toMatch(/stationKind=\{station\.station\.kind\}/);
  });
});

describe("BLISTER-PAUSE-COUNT-SNAPSHOT-1 · end-shift counter guard", () => {
  it("server blocks direct end shift while an active BLISTER/COMBINED bag is running", () => {
    expect(actionsSrc).toMatch(/isBlisterCounterSnapshotStation\(station\.kind\)/);
    expect(actionsSrc).toMatch(/readStationLive\.currentWorkflowBagId/);
    expect(actionsSrc).toMatch(/readBagState\.isPaused/);
    expect(actionsSrc).toMatch(/Pause this bag with a shift-end counter before ending shift/);
  });

  it("operator UI routes active BLISTER/COMBINED end shift through a shift-end pause snapshot", () => {
    expect(formSrc).toMatch(/pauseBagAction/);
    expect(formSrc).toMatch(/reason", "shift_end"/);
    expect(formSrc).toMatch(/counterSnapshotCount/);
    expect(formSrc).toMatch(/Machine counter at shift end/);
    expect(formSrc).toMatch(/Machines may reset when powered off/);
  });

  it("page passes current active bag pause state to the operator panel", () => {
    const pageSrc = readFileSync(join(__dirname, "page.tsx"), "utf8");
    expect(pageSrc).toMatch(/currentWorkflowBagId=\{currentAtStation\?\.bag\.id \?\? null\}/);
    expect(pageSrc).toMatch(/currentBagIsPaused=\{currentAtStation\?\.state\?\.isPaused \?\? false\}/);
  });
});

describe("OPERATOR-SHIFT-SUBMIT-BLOCK-1 · openOperatorSessionAction behavior", () => {
  let callIdx: number;
  let selectResults: unknown[][];
  let insertValues: Record<string, unknown> | null;

  beforeEach(() => {
    callIdx = 0;
    selectResults = [];
    insertValues = null;
    vi.resetModules();
  });

  async function loadAction() {
    vi.doMock("@/lib/db", () => ({
      db: {
        select: () => ({
          from: () => ({
            where: async () => {
              const rows = selectResults[callIdx++] ?? [];
              return rows;
            },
          }),
        }),
        transaction: async (fn: (tx: unknown) => Promise<void>) => {
          const tx = {
            select: () => ({
              from: () => ({
                where: async () => {
                  const rows = selectResults[callIdx++] ?? [];
                  return rows;
                },
              }),
            }),
            update: () => ({
              set: () => ({
                where: async () => undefined,
              }),
            }),
            insert: () => ({
              values: (vals: Record<string, unknown>) => ({
                returning: async () => {
                  insertValues = vals;
                  return [{ id: "sess-new" }];
                },
              }),
            }),
          };
          await fn(tx);
        },
      },
    }));
    vi.doMock("@/lib/db/audit", () => ({
      writeAudit: vi.fn(),
    }));
    vi.doMock("next/cache", () => ({
      revalidatePath: vi.fn(),
    }));
    const mod = await import("./operator-session-actions");
    return mod.openOperatorSessionAction;
  }

  const STATION = {
    id: "12492e4b-dac7-46fb-b860-b7ea483fbd9e",
    scanToken: "5dfdb0ee-b9a5-442a-9d1c-309895fa24f7",
    kind: "BLISTER",
  };
  const EMPLOYEE = {
    id: "303761de-e2c8-4474-b548-f2396f02a281",
    fullName: "ewsin",
    employeeCode: null,
    status: "ACTIVE",
  };

  it("picker employeeId with no employee_code stores employee_id on session", async () => {
    selectResults = [[STATION], [EMPLOYEE]];
    const openOperatorSessionAction = await loadAction();
    const fd = new FormData();
    fd.set("token", STATION.scanToken);
    fd.set("stationId", STATION.id);
    fd.set("employeeId", EMPLOYEE.id);
    const r = await openOperatorSessionAction(fd);
    expect(r.error).toBeUndefined();
    expect(r.ok).toBe(true);
    expect(insertValues?.employeeId).toBe(EMPLOYEE.id);
    expect(insertValues?.accountabilitySource).toBe("EMPLOYEE_PICKER");
  });

  it("freeText-only on BLISTER is rejected before insert", async () => {
    selectResults = [[STATION]];
    const openOperatorSessionAction = await loadAction();
    const fd = new FormData();
    fd.set("token", STATION.scanToken);
    fd.set("stationId", STATION.id);
    fd.set("freeText", "Sahil");
    const r = await openOperatorSessionAction(fd);
    expect(r.ok).toBeUndefined();
    expect(r.error).toMatch(/Free-text name alone cannot open a shift/);
    expect(insertValues).toBeNull();
  });
});
