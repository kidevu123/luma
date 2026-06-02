import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { planMaterialChangeRecovery } from "@/lib/production/material-change-recovery";
import {
  assembleRecoveryContext,
  buildRecoveryRollState,
  inferLineageState,
  mapExistingSegmentRow,
  materialKindToRollRole,
} from "@/lib/production/material-change-recovery-loader";
import {
  DRY_RUN_BANNER,
  buildRecoveryDryRunReport,
  formatRecoveryDryRunReportHuman,
  formatRecoveryDryRunReportJson,
  parseRecoveryDryRunCliArgs,
  recoveryDryRunExitCode,
} from "@/lib/production/material-change-recovery-dry-run-cli";

const VALID_UUID = "11111111-1111-4111-8111-111111111111";
const VALID_UUID_B = "22222222-2222-4222-8222-222222222222";
const VALID_UUID_C = "33333333-3333-4333-8333-333333333333";
const VALID_UUID_D = "44444444-4444-4444-8444-444444444444";

const ROOT = join(__dirname, "../..");

function baseArgv(extra: string[] = []): string[] {
  return [
    "--workflow-bag-id",
    VALID_UUID,
    "--station-id",
    VALID_UUID_B,
    "--old-roll-lot-id",
    VALID_UUID_C,
    "--new-roll-lot-id",
    VALID_UUID_D,
    "--segment-count",
    "516",
    "--recovery-kind",
    "depleted",
    "--material-role",
    "PVC",
    "--reason",
    "operator_correction",
    "--requested-by",
    "sahil",
    "--event-boundary-timestamp",
    "2026-06-02T15:00:00.000Z",
    ...extra,
  ];
}

describe("RECOVERY-DRY-RUN-HARNESS-1 · CLI parsing", () => {
  it("fails when required args are missing", () => {
    const parsed = parseRecoveryDryRunCliArgs(["--workflow-bag-id", VALID_UUID]);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error).toMatch(/Missing required arguments/);
    }
  });

  it("accepts explicit valid args", () => {
    const parsed = parseRecoveryDryRunCliArgs(baseArgv());
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.args.segmentCount).toBe(516);
      expect(parsed.args.recoveryKind).toBe("depleted");
    }
  });
});

describe("RECOVERY-DRY-RUN-HARNESS-1 · exit codes", () => {
  it("returns 0 for OK dry-run", () => {
    const result = planMaterialChangeRecovery(
      {
        workflowBagId: "bag-1",
        stationId: "station-blister",
        eventBoundaryTimestamp: "2026-06-02T15:00:00.000Z",
        oldRollLotId: "pvc-old",
        newRollLotId: "pvc-new",
        segmentCount: 516,
        materialRole: "PVC",
        reason: "historical_backfill",
        oldRollEndState: "depleted",
        requestedByUserId: "admin-1",
      },
      {
        workflowBag: { id: "bag-1", finalizedAt: null, finishedLotIds: [] },
        station: { id: "station-blister", machineId: "machine-blister" },
        rolls: [
          {
            lotId: "pvc-old",
            role: "PVC",
            status: "IN_USE",
            activeAtBoundary: true,
            segmentTotal: 205,
          },
          {
            lotId: "foil-active",
            role: "FOIL",
            status: "IN_USE",
            activeAtBoundary: true,
            segmentTotal: 205,
          },
          {
            lotId: "pvc-new",
            role: "PVC",
            status: "AVAILABLE",
            activeAtBoundary: false,
            segmentTotal: 0,
          },
        ],
        activeRollsAtBoundary: [
          {
            lotId: "pvc-old",
            role: "PVC",
            status: "IN_USE",
            activeAtBoundary: true,
          },
          {
            lotId: "foil-active",
            role: "FOIL",
            status: "IN_USE",
            activeAtBoundary: true,
          },
        ],
      },
    );
    expect(recoveryDryRunExitCode(result)).toBe(0);
  });

  it("returns 2 for BLOCKED dry-run", () => {
    const result = planMaterialChangeRecovery(
      {
        workflowBagId: "missing-bag",
        stationId: "station-blister",
        eventBoundaryTimestamp: "2026-06-02T15:00:00.000Z",
        oldRollLotId: "pvc-old",
        newRollLotId: "pvc-new",
        segmentCount: 516,
        materialRole: "PVC",
        reason: "historical_backfill",
        oldRollEndState: "depleted",
        requestedByUserId: "admin-1",
      },
      { rolls: [], activeRollsAtBoundary: [] },
    );
    expect(result.eligibility).toBe("BLOCKED");
    expect(recoveryDryRunExitCode(result)).toBe(2);
  });

  it("returns 0 for WARNING dry-run", () => {
    const result = planMaterialChangeRecovery(
      {
        workflowBagId: "bag-1",
        stationId: "station-blister",
        eventBoundaryTimestamp: "2026-06-02T15:00:00.000Z",
        oldRollLotId: "pvc-old",
        newRollLotId: "pvc-new",
        segmentCount: 516,
        materialRole: "PVC",
        reason: "historical_backfill",
        oldRollEndState: "removed_partial",
        requestedByUserId: "admin-1",
        endingWeightGrams: 1200,
      },
      {
        workflowBag: {
          id: "bag-1",
          finalizedAt: null,
          finishedLotIds: [],
          lineageState: "HIGH",
        },
        station: { id: "station-blister", machineId: "machine-blister" },
        boundaryWorkflowEventId: "event-boundary",
        rolls: [
          {
            lotId: "pvc-old",
            role: "PVC",
            status: "IN_USE",
            activeAtBoundary: true,
            stationId: "station-blister",
            machineId: "machine-blister",
            segmentTotal: 205,
          },
          {
            lotId: "foil-active",
            role: "FOIL",
            status: "IN_USE",
            activeAtBoundary: true,
            stationId: "station-blister",
            machineId: "machine-blister",
            segmentTotal: 205,
          },
          {
            lotId: "pvc-new",
            role: "PVC",
            status: "AVAILABLE",
            activeAtBoundary: false,
            segmentTotal: 0,
          },
        ],
        activeRollsAtBoundary: [
          {
            lotId: "pvc-old",
            role: "PVC",
            status: "IN_USE",
            activeAtBoundary: true,
            stationId: "station-blister",
            machineId: "machine-blister",
          },
          {
            lotId: "foil-active",
            role: "FOIL",
            status: "IN_USE",
            activeAtBoundary: true,
            stationId: "station-blister",
            machineId: "machine-blister",
          },
        ],
      },
    );
    expect(result.eligibility).toBe("WARNING");
    expect(recoveryDryRunExitCode(result)).toBe(0);
  });
});

describe("RECOVERY-DRY-RUN-HARNESS-1 · report output", () => {
  it("includes DRY RUN ONLY banner and preview-only events", () => {
    const result = planMaterialChangeRecovery(
      {
        workflowBagId: "bag-1",
        stationId: "station-blister",
        eventBoundaryTimestamp: "2026-06-02T15:00:00.000Z",
        oldRollLotId: "pvc-old",
        newRollLotId: "pvc-new",
        segmentCount: 516,
        materialRole: "PVC",
        reason: "historical_backfill",
        oldRollEndState: "depleted",
        requestedByUserId: "admin-1",
      },
      {
        workflowBag: { id: "bag-1", finalizedAt: null, finishedLotIds: [] },
        station: { id: "station-blister", machineId: "machine-blister" },
        rolls: [
          {
            lotId: "pvc-old",
            role: "PVC",
            status: "IN_USE",
            activeAtBoundary: true,
          },
          {
            lotId: "foil-active",
            role: "FOIL",
            status: "IN_USE",
            activeAtBoundary: true,
          },
          {
            lotId: "pvc-new",
            role: "PVC",
            status: "AVAILABLE",
            activeAtBoundary: false,
          },
        ],
        activeRollsAtBoundary: [
          {
            lotId: "pvc-old",
            role: "PVC",
            status: "IN_USE",
            activeAtBoundary: true,
          },
          {
            lotId: "foil-active",
            role: "FOIL",
            status: "IN_USE",
            activeAtBoundary: true,
          },
        ],
      },
    );
    const report = buildRecoveryDryRunReport({
      input: {
        workflowBagId: "bag-1",
        stationId: "station-blister",
        eventBoundaryTimestamp: "2026-06-02T15:00:00.000Z",
        oldRollLotId: "pvc-old",
        newRollLotId: "pvc-new",
        segmentCount: 516,
        materialRole: "PVC",
        reason: "historical_backfill",
        oldRollEndState: "depleted",
        requestedByUserId: "admin-1",
      },
      result,
      boundaryResolvedFromEvent: false,
      eventBoundaryTimestamp: new Date("2026-06-02T15:00:00.000Z"),
    });
    const human = formatRecoveryDryRunReportHuman(report);
    expect(human).toContain(DRY_RUN_BANNER);
    expect(human).toContain("NOT PERSISTED");
    const json = JSON.parse(formatRecoveryDryRunReportJson(report)) as {
      previewOnly: boolean;
      willPersist: boolean;
      eligibility: string;
      blockers: unknown[];
      warnings: unknown[];
      proposedEvents: Array<{ previewOnly: boolean; willPersist: boolean }>;
    };
    expect(json.previewOnly).toBe(true);
    expect(json.willPersist).toBe(false);
    expect(json.eligibility).toBeDefined();
    expect(Array.isArray(json.blockers)).toBe(true);
    expect(Array.isArray(json.warnings)).toBe(true);
    expect(json.proposedEvents.every((event) => event.previewOnly)).toBe(true);
  });
});

describe("RECOVERY-DRY-RUN-HARNESS-1 · loader mapping", () => {
  it("maps material kinds to roll roles", () => {
    expect(materialKindToRollRole("PVC_ROLL")).toBe("PVC");
    expect(materialKindToRollRole("FOIL_ROLL")).toBe("FOIL");
    expect(materialKindToRollRole("LABEL")).toBeNull();
  });

  it("maps existing segment rows and omits invalid rows", () => {
    expect(
      mapExistingSegmentRow({
        workflowBagId: "bag-1",
        packagingLotId: "pvc-old",
        role: "PVC",
        segmentCount: 516,
        segmentReason: "ROLL_CHANGE",
        oldLotId: "pvc-old",
        newLotId: "pvc-new",
        occurredAt: new Date("2026-06-02T15:00:00.000Z"),
      }),
    ).toMatchObject({ segmentCount: 516 });
    expect(
      mapExistingSegmentRow({
        workflowBagId: "bag-1",
        packagingLotId: "pvc-old",
        role: null,
        segmentCount: 516,
        segmentReason: null,
        oldLotId: null,
        newLotId: null,
        occurredAt: null,
      }),
    ).toBeNull();
  });

  it("assembles context without inventing missing bag/station records", () => {
    const context = assembleRecoveryContext({
      rolls: [],
      activeRollsAtBoundary: [],
      existingSegments: [],
    });
    expect(context.workflowBag).toBeUndefined();
    expect(context.station).toBeUndefined();
  });

  it("infers lineage state honestly", () => {
    expect(inferLineageState({ inventoryBagId: null, hasCorrection: false })).toBe(
      "MISSING",
    );
    expect(
      inferLineageState({ inventoryBagId: "bag-input", hasCorrection: true }),
    ).toBe("LOW");
  });

  it("builds roll state with active-at-boundary flag", () => {
    const roll = buildRecoveryRollState({
      lot: {
        lotId: "pvc-old",
        rollNumber: "PVC-1",
        status: "IN_USE",
        materialKind: "PVC_ROLL",
        role: "PVC",
      },
      segmentTotal: 100,
      activeAtBoundary: true,
      stationId: "station-1",
      machineId: "machine-1",
    });
    expect(roll?.activeAtBoundary).toBe(true);
    expect(roll?.segmentTotal).toBe(100);
  });

  it("represents duplicate segment risk in loaded context", () => {
    const context = assembleRecoveryContext({
      workflowBag: { id: "bag-1", finalizedAt: null, finishedLotIds: [] },
      station: { id: "station-1", machineId: "machine-1" },
      rolls: [
        {
          lotId: "pvc-old",
          role: "PVC",
          status: "IN_USE",
          activeAtBoundary: true,
        },
      ],
      activeRollsAtBoundary: [
        {
          lotId: "pvc-old",
          role: "PVC",
          status: "IN_USE",
          activeAtBoundary: true,
        },
      ],
      existingSegments: [
        {
          workflowBagId: "bag-1",
          packagingLotId: "pvc-old",
          role: "PVC",
          segmentCount: 516,
          segmentReason: "ROLL_CHANGE",
          oldLotId: "pvc-old",
          newLotId: "pvc-new",
          occurredAt: new Date("2026-06-02T15:00:00.000Z"),
        },
      ],
    });
    expect(context.existingSegments).toHaveLength(1);
    expect(context.existingSegments?.[0]?.segmentCount).toBe(516);
  });
});

describe("RECOVERY-DRY-RUN-HARNESS-1 · planner blockers from context", () => {
  it("blocks finalized bag", () => {
    const result = planMaterialChangeRecovery(
      {
        workflowBagId: "bag-1",
        stationId: "station-blister",
        eventBoundaryTimestamp: "2026-06-02T15:00:00.000Z",
        oldRollLotId: "pvc-old",
        newRollLotId: "pvc-new",
        segmentCount: 516,
        materialRole: "PVC",
        reason: "historical_backfill",
        oldRollEndState: "depleted",
        requestedByUserId: "admin-1",
      },
      {
        workflowBag: {
          id: "bag-1",
          finalizedAt: "2026-06-01T12:00:00.000Z",
          finishedLotIds: [],
        },
        station: { id: "station-blister", machineId: "machine-blister" },
        rolls: [],
        activeRollsAtBoundary: [],
      },
    );
    expect(result.eligibility).toBe("BLOCKED");
    expect(result.blockers.some((b) => /finalized/i.test(b.message))).toBe(true);
  });

  it("blocks finished-lot boundary", () => {
    const result = planMaterialChangeRecovery(
      {
        workflowBagId: "bag-1",
        stationId: "station-blister",
        eventBoundaryTimestamp: "2026-06-02T15:00:00.000Z",
        oldRollLotId: "pvc-old",
        newRollLotId: "pvc-new",
        segmentCount: 516,
        materialRole: "PVC",
        reason: "historical_backfill",
        oldRollEndState: "depleted",
        requestedByUserId: "admin-1",
      },
      {
        workflowBag: {
          id: "bag-1",
          finalizedAt: null,
          finishedLotIds: ["finished-lot-1"],
        },
        station: { id: "station-blister", machineId: "machine-blister" },
        rolls: [],
        activeRollsAtBoundary: [],
      },
    );
    expect(result.eligibility).toBe("BLOCKED");
    expect(result.blockers.some((b) => /finished lot/i.test(b.message))).toBe(true);
  });

  it("blocks missing station without crashing", () => {
    const result = planMaterialChangeRecovery(
      {
        workflowBagId: "bag-1",
        stationId: "missing-station",
        eventBoundaryTimestamp: "2026-06-02T15:00:00.000Z",
        oldRollLotId: "pvc-old",
        newRollLotId: "pvc-new",
        segmentCount: 516,
        materialRole: "PVC",
        reason: "historical_backfill",
        oldRollEndState: "depleted",
        requestedByUserId: "admin-1",
      },
      {
        workflowBag: { id: "bag-1", finalizedAt: null, finishedLotIds: [] },
        rolls: [],
        activeRollsAtBoundary: [],
      },
    );
    expect(result.eligibility).toBe("BLOCKED");
    expect(result.blockers.some((b) => /station/i.test(b.message))).toBe(true);
  });
});

describe("RECOVERY-DRY-RUN-HARNESS-1 · mutation guards", () => {
  const scriptSrc = readFileSync(
    join(ROOT, "scripts/material-change-recovery-dry-run.ts"),
    "utf8",
  );
  const loaderSrc = readFileSync(
    join(ROOT, "lib/production/material-change-recovery-loader.ts"),
    "utf8",
  );
  const cliSrc = readFileSync(
    join(ROOT, "lib/production/material-change-recovery-dry-run-cli.ts"),
    "utf8",
  );

  it("script does not import projectEvent or writeAudit", () => {
    expect(scriptSrc).not.toMatch(/projectEvent/);
    expect(scriptSrc).not.toMatch(/writeAudit/);
  });

  it("script does not rebuild read models or call repair apply paths", () => {
    expect(scriptSrc).not.toMatch(/rebuildRollUsage/);
    expect(scriptSrc).not.toMatch(/applyMaterialChangeRecovery/);
    expect(scriptSrc).not.toMatch(/confirmMaterialChangeRecovery/);
  });

  it("loader and cli use read-only paths and no insert/update/delete", () => {
    for (const src of [loaderSrc, cliSrc, scriptSrc]) {
      expect(src).not.toMatch(/\.insert\(/);
      expect(src).not.toMatch(/\.update\(/);
      expect(src).not.toMatch(/\.delete\(/);
      expect(src).not.toMatch(/projectEvent/);
      expect(src).not.toMatch(/writeAudit/);
      expect(src).not.toMatch(/rebuildRollUsage/);
    }
  });
});
