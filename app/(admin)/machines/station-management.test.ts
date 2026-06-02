import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  STATION_INACTIVE_FLOOR_MESSAGE,
  assertStationActiveForFloorActions,
} from "@/lib/production/station-management";

describe("station management helpers", () => {
  it("assertStationActiveForFloorActions blocks inactive stations", () => {
    expect(() => assertStationActiveForFloorActions({ isActive: false })).toThrow(
      STATION_INACTIVE_FLOOR_MESSAGE,
    );
    expect(() => assertStationActiveForFloorActions({ isActive: true })).not.toThrow();
  });

  it("inactive floor message is operator-facing", () => {
    expect(STATION_INACTIVE_FLOOR_MESSAGE).toMatch(/inactive/i);
    expect(STATION_INACTIVE_FLOOR_MESSAGE).toMatch(/admin/i);
  });
});

describe("STATION-MGMT-1 · admin machines page wiring", () => {
  const actionsSrc = readFileSync(
    join(__dirname, "actions.ts"),
    "utf8",
  );
  const formsSrc = readFileSync(join(__dirname, "forms.tsx"), "utf8");
  const pageSrc = readFileSync(join(__dirname, "page.tsx"), "utf8");
  const queriesSrc = readFileSync(
    join(process.cwd(), "lib/db/queries/machines.ts"),
    "utf8",
  );
  const floorPageSrc = readFileSync(
    join(process.cwd(), "app/(floor)/floor/[token]/page.tsx"),
    "utf8",
  );
  const floorActionsSrc = readFileSync(
    join(process.cwd(), "app/(floor)/floor/[token]/actions.ts"),
    "utf8",
  );
  const stationMgmtSrc = readFileSync(
    join(process.cwd(), "lib/production/station-management.ts"),
    "utf8",
  );

  it("requires admin for management actions", () => {
    expect(actionsSrc).toMatch(/requireAdmin/);
  });

  it("add station creates scan token via createStation", () => {
    expect(queriesSrc).toMatch(/scanToken = crypto\.randomUUID\(\)/);
    expect(formsSrc).toMatch(/createStationAction/);
    expect(pageSrc).toMatch(/CopyFloorUrl/);
  });

  it("edit station name does not rotate scan token", () => {
    expect(actionsSrc).toMatch(/updateStationLabelAction/);
    expect(queriesSrc).toMatch(/updateStationLabel/);
    expect(queriesSrc).toMatch(/scanToken: before\.scanToken/);
    expect(queriesSrc).not.toMatch(/updateStationLabel[\s\S]*scanToken: fresh/);
  });

  it("deactivate and reactivate audit actions exist", () => {
    expect(actionsSrc).toMatch(/setStationActiveAction/);
    expect(actionsSrc).toMatch(/setMachineActiveAction/);
    expect(queriesSrc).toMatch(/station\.deactivate/);
    expect(queriesSrc).toMatch(/station\.reactivate/);
  });

  it("lists active and inactive stations separately", () => {
    expect(pageSrc).toMatch(/listStationsGrouped/);
    expect(pageSrc).toMatch(/Active stations/);
    expect(pageSrc).toMatch(/Inactive stations/);
  });

  it("deactivate checks pinned bag and open session blockers", () => {
    expect(queriesSrc).toMatch(/getStationDeactivateBlockers/);
    expect(stationMgmtSrc).toMatch(/currentWorkflowBagId/);
  });

  it("no hard delete offered in admin UI", () => {
    expect(pageSrc).not.toMatch(/deleteStation/);
    expect(pageSrc).not.toMatch(/DELETE FROM stations/);
    expect(queriesSrc).not.toMatch(/deleteStation/);
  });

  it("inactive station floor URL blocks new actions", () => {
    expect(floorPageSrc).toMatch(/STATION_INACTIVE_FLOOR_MESSAGE/);
    expect(floorActionsSrc).toMatch(/assertStationActiveForFloorActions/);
  });

  it("does not touch bag45 phase2 repair files", () => {
    expect(actionsSrc).not.toMatch(/bag45-phase2/);
    expect(pageSrc).not.toMatch(/bag45/);
  });

  it("does not touch zoho receive or packaging reconciliation", () => {
    expect(actionsSrc).not.toMatch(/zoho/i);
    expect(queriesSrc).not.toMatch(/receive/i);
    expect(pageSrc).not.toMatch(/packaging.reconciliation/i);
  });
});
