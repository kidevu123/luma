import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { join, resolve } from "path";

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

  it("blocks floor open session on inactive stations", () => {
    expect(actionsSrc).toMatch(/assertStationActiveForFloorActions/);
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

  // P4b Task 5 (THE CUTOVER) — page.tsx no longer mounts
  // OperatorSessionPanel directly; the operator screen does, in both
  // places it can appear (the OPEN_SHIFT case and End shift under
  // More). The prop still has to arrive, so the scanner follows it.
  it("the operator screen passes stationKind into OperatorSessionPanel", () => {
    const screenSrc = readFileSync(join(__dirname, "operator-screen.tsx"), "utf8");
    expect(screenSrc).toMatch(/stationKind=\{station\.kind\}/);
    expect(screenSrc).toMatch(/stationKind=\{view\.station\.kind\}/);
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
    expect(formSrc).toMatch(/Counter snapshot at shift end/);
    expect(formSrc).toMatch(/shiftEndCounterSnapshotHelperText/);
    expect(formSrc).toMatch(/shiftEndCounterSnapshotMissingError/);
  });

  // P4b Task 5 (THE CUTOVER) — same guard, new host. End shift moved
  // into the More sheet, and it is the PANEL there rather than a bare
  // endOperatorSessionAction button precisely so this counter-snapshot
  // gate still runs; both facts it needs are passed through.
  it("the operator screen passes current active bag pause state to the operator panel", () => {
    const screenSrc = readFileSync(join(__dirname, "operator-screen.tsx"), "utf8");
    expect(screenSrc).toMatch(/currentWorkflowBagId=\{currentWorkflowBagId\}/);
    expect(screenSrc).toMatch(/currentBagIsPaused=\{currentBagIsPaused\}/);
    expect(screenSrc).toMatch(/code === "BAG_PAUSED"/);
    // End shift must not bypass the panel: the screen imports no
    // session-ending action of its own.
    expect(screenSrc).not.toMatch(/from "\.\/operator-session-actions"/);
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
    isActive: true,
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

// ── P4b inline-duplication value-pins ────────────────────────────────────────
// The plan's exact critique: tests must extract the LITERALS from both
// modules' source and assert equality — not name-mentions. Two sets are
// intentionally duplicated for bundle-isolation reasons (see each file's
// comment), but they must stay in sync. These tests catch drift without
// requiring a deduplicated import that would break the Next build.

/** Extract the set-literal members from a `new Set([...])` construction in source. */
function extractSetLiterals(src: string, varName: string): string[] {
  // Match: const VAR: ... = new Set([ "A", "B", ... ]);
  const re = new RegExp(
    `(?:const|export const)\\s+${varName}[^=]*=\\s*new Set\\(\\[([^\\]]+)\\]`,
  );
  const m = re.exec(src);
  if (!m?.[1]) throw new Error(`${varName} set literal not found in source`);
  return m[1]
    .split(",")
    .map((s) => s.replace(/\/\/[^\n]*/g, "").replace(/["'\s]/g, ""))
    .filter(Boolean)
    .sort();
}

describe("VALUE-PIN · FIRST_OP_COUNT_ACCOUNTABILITY_STATION_KINDS parity", () => {
  // Canonical: lib/production/station-operator-session.ts
  // Duplicate: app/(floor)/floor/[token]/operator-session-form.tsx
  // Reason for duplication: operator-session-form.tsx is "use client"; importing
  // station-operator-session.ts would pull DB schema objects into the client bundle.
  it("the duplicate in operator-session-form.tsx carries the same members as the canonical set", () => {
    const canonicalSrc = readFileSync(
      resolve(process.cwd(), "lib", "production", "station-operator-session.ts"),
      "utf8",
    );
    const duplicateSrc = readFileSync(
      join(__dirname, "operator-session-form.tsx"),
      "utf8",
    );
    const canonical = extractSetLiterals(
      canonicalSrc,
      "FIRST_OP_COUNT_ACCOUNTABILITY_STATION_KINDS",
    );
    const duplicate = extractSetLiterals(
      duplicateSrc,
      "FIRST_OP_COUNT_ACCOUNTABILITY_STATION_KINDS",
    );
    expect(duplicate).toEqual(canonical);
  });
});

describe("VALUE-PIN · FRESH_BAG_STATION_KINDS parity", () => {
  // Canonical: lib/production/first-op-product.ts (FIRST_OP_STATION_KINDS)
  // Duplicate: app/(floor)/floor/[token]/actions.ts (FRESH_BAG_STATION_KINDS)
  // Reason for duplication: floor actions are isolated from lib DB imports.
  it("the duplicate FRESH_BAG_STATION_KINDS in actions.ts carries the same members as FIRST_OP_STATION_KINDS", () => {
    const canonicalSrc = readFileSync(
      resolve(process.cwd(), "lib", "production", "first-op-product.ts"),
      "utf8",
    );
    const duplicateSrc = readFileSync(
      join(__dirname, "actions.ts"),
      "utf8",
    );
    const canonical = extractSetLiterals(canonicalSrc, "FIRST_OP_STATION_KINDS");
    const duplicate = extractSetLiterals(duplicateSrc, "FRESH_BAG_STATION_KINDS");
    expect(duplicate).toEqual(canonical);
  });
});
