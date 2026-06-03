import { describe, it, expect } from "vitest";
import {
  STATION_KIND_BY_LABEL,
  STATION_LABELS_TO_DEACTIVATE,
  plannedKindCorrections,
  plannedDeactivations,
} from "./station-kind-catalog";
import {
  floorSupervisorToolsForStation,
  FLOOR_ROLL_STATION_KINDS,
} from "./floor-station-mobile-nav";
import {
  getDefaultPauseReasonForStation,
  getPauseReasonsForStation,
} from "./station-pause-reasons";
import { readFileSync } from "fs";
import { join } from "path";

const TOKEN = "station-token-fix-1";

describe("STATION-KIND-FIX-1 · station kind catalog", () => {
  it("Blister Hand Pack Station is cataloged as HANDPACK_BLISTER", () => {
    expect(STATION_KIND_BY_LABEL["Blister Hand Pack Station"]).toBe(
      "HANDPACK_BLISTER",
    );
  });

  it("Blister Room remains BLISTER (machine station)", () => {
    expect(STATION_KIND_BY_LABEL["Blister Room"]).toBe("BLISTER");
  });

  it("smoke duplicate hand-pack station is marked for deactivation", () => {
    expect(STATION_LABELS_TO_DEACTIVATE).toContain("Hand Pack Blister Smoke");
    expect(STATION_LABELS_TO_DEACTIVATE).not.toContain(
      "Blister Hand Pack Station",
    );
  });

  it("plannedKindCorrections clears machine_id only for hand-pack", () => {
    const handpack = plannedKindCorrections().find(
      (c) => c.label === "Blister Hand Pack Station",
    );
    const blisterRoom = plannedKindCorrections().find(
      (c) => c.label === "Blister Room",
    );
    expect(handpack?.clearMachineId).toBe(true);
    expect(blisterRoom?.clearMachineId).toBe(false);
  });

  it("plannedDeactivations includes smoke station only", () => {
    expect(plannedDeactivations().map((d) => d.label)).toEqual([
      "Hand Pack Blister Smoke",
    ]);
  });
});

describe("STATION-KIND-FIX-1 · HANDPACK_BLISTER floor expectations (regression)", () => {
  it("HANDPACK_BLISTER has no Rolls supervisor tool", () => {
    expect(
      floorSupervisorToolsForStation(TOKEN, "HANDPACK_BLISTER"),
    ).toEqual([]);
  });

  it("BLISTER still has Rolls supervisor tool", () => {
    expect(floorSupervisorToolsForStation(TOKEN, "BLISTER").map((t) => t.id)).toEqual(
      ["rolls"],
    );
  });

  it("HANDPACK_BLISTER is not a roll station kind", () => {
    expect(FLOOR_ROLL_STATION_KINDS.has("HANDPACK_BLISTER")).toBe(false);
    expect(FLOOR_ROLL_STATION_KINDS.has("BLISTER")).toBe(true);
  });

  it("HANDPACK_BLISTER pause reasons exclude PVC and machine jam", () => {
    const values = getPauseReasonsForStation("HANDPACK_BLISTER").map(
      (r) => r.value,
    );
    expect(values).toEqual(["shift_end", "shift_break", "qa_check", "other"]);
    expect(values).not.toContain("pvc_swap");
    expect(values).not.toContain("machine_jam");
  });

  it("HANDPACK_BLISTER default pause is shift_end", () => {
    expect(getDefaultPauseReasonForStation("HANDPACK_BLISTER")).toBe(
      "shift_end",
    );
  });

  it("BLISTER default pause is shift_end (roll swap uses roll-change UI)", () => {
    expect(getDefaultPauseReasonForStation("BLISTER")).toBe("shift_end");
  });

  it("HANDPACK_BLISTER uses timed-only complete, not blister count form", () => {
    const src = readFileSync(
      join(__dirname, "../../app/(floor)/floor/[token]/stage-action-buttons.tsx"),
      "utf8",
    );
    expect(src).toMatch(
      /HANDPACK_BLISTER:.*Hand-pack complete.*HANDPACK_BLISTER_COMPLETE/s,
    );
    expect(src).toMatch(/TIMED_ONLY_EVENTS.*HANDPACK_BLISTER_COMPLETE/s);
    const richLine = src.match(/RICH_FORM_EVENTS = new Set\(\[([\s\S]*?)\]\)/)?.[1] ?? "";
    expect(richLine).not.toMatch(/HANDPACK_BLISTER_COMPLETE/);
  });
});

describe("STATION-KIND-FIX-1 · repair script structure", () => {
  const scriptSrc = readFileSync(
    join(__dirname, "../../scripts/fix-station-handpack-kind.ts"),
    "utf8",
  );

  it("defaults to dry-run — mutations gated on --apply", () => {
    expect(scriptSrc).toMatch(/const apply = process\.argv\.includes\("--apply"\)/);
    expect(scriptSrc).toMatch(/if \(!apply\) \{/);
    expect(scriptSrc).toMatch(/dry-run complete/);
    expect(scriptSrc).toMatch(/await db\.transaction/);
    const applyIdx = scriptSrc.indexOf('includes("--apply")');
    const txnIdx = scriptSrc.indexOf("await db.transaction");
    expect(txnIdx).toBeGreaterThan(applyIdx);
  });

  it("requires ALLOW_STATION_KIND_FIX=true on production apply", () => {
    expect(scriptSrc).toMatch(/ALLOW_STATION_KIND_FIX/);
    expect(scriptSrc).toMatch(/NODE_ENV === "production"/);
    expect(scriptSrc).toMatch(/Refusing --apply/);
  });

  it("sources planned changes from station-kind-catalog only", () => {
    expect(scriptSrc).toMatch(/plannedKindCorrections/);
    expect(scriptSrc).toMatch(/plannedDeactivations/);
    expect(scriptSrc).not.toMatch(/insert\(stations\)/);
    expect(scriptSrc).not.toMatch(/\.insert\(/);
  });

  it("updates only catalog station labels — no broad station scan", () => {
    expect(scriptSrc).toMatch(/inArray\(stations\.label, labels\)/);
  });

  it("deactivates smoke duplicate only via plannedDeactivations", () => {
    expect(scriptSrc).toMatch(/kind: "deactivate"/);
    expect(scriptSrc).toMatch(/set\(\{ isActive: false \}\)/);
    expect(plannedDeactivations().map((d) => d.label)).toEqual([
      "Hand Pack Blister Smoke",
    ]);
  });

  it("Blister Room catalog keeps BLISTER — correction is noop when already correct", () => {
    const blisterRoom = plannedKindCorrections().find(
      (c) => c.label === "Blister Room",
    );
    expect(blisterRoom?.expectedKind).toBe("BLISTER");
    expect(blisterRoom?.clearMachineId).toBe(false);
  });

  it("does not touch workflow bags, events, or qr cards", () => {
    expect(scriptSrc).not.toMatch(/workflow_bags/);
    expect(scriptSrc).not.toMatch(/workflow_events/);
    expect(scriptSrc).not.toMatch(/qr_cards/);
    expect(scriptSrc).not.toMatch(/read_bag_state/);
    expect(scriptSrc).not.toMatch(/read_station_live/);
  });
});
