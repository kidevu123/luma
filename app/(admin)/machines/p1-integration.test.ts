import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * P1 launch integration seam — station management + partial roll swap.
 * Wiring tests prove both slices coexist in shared floor modules.
 */
describe("P1 launch integration · station mgmt + partial roll swap", () => {
  const rollActionsSrc = readFileSync(
    join(process.cwd(), "app/(floor)/floor/[token]/roll-actions.ts"),
    "utf8",
  );
  const qcActionsSrc = readFileSync(
    join(process.cwd(), "app/(floor)/floor/[token]/qc-actions.ts"),
    "utf8",
  );
  const operatorSrc = readFileSync(
    join(process.cwd(), "app/(floor)/floor/[token]/operator-session-actions.ts"),
    "utf8",
  );
  const changeIdx = rollActionsSrc.indexOf("export async function changeRollAction");
  const changeBlock =
    changeIdx >= 0 ? rollActionsSrc.slice(changeIdx, changeIdx + 18000) : "";

  it("roll-actions authStation blocks inactive stations", () => {
    expect(rollActionsSrc).toMatch(/assertStationActiveForFloorActions/);
    const authIdx = rollActionsSrc.indexOf("async function authStation");
    const authBlock = rollActionsSrc.slice(authIdx, authIdx + 600);
    expect(authBlock).toMatch(/assertStationActiveForFloorActions\(station\)/);
  });

  it("changeRollAction still supports partial and depleted old-roll paths", () => {
    expect(rollActionsSrc).toMatch(
      /oldRollEndState:\s*z\.enum\(\["depleted",\s*"removed_partial"\]/,
    );
    expect(changeBlock).toMatch(/d\.oldRollEndState === "depleted"/);
    expect(changeBlock).toMatch(/eventType:\s*"ROLL_DEPLETED"/);
    expect(changeBlock).toMatch(/eventType:\s*"ROLL_UNMOUNTED"/);
    expect(changeBlock).toMatch(/status:\s*"AVAILABLE"/);
  });

  it("changeRollAction calls authStation (inactive guard applies to roll swap)", () => {
    expect(changeBlock).toMatch(/const station = await authStation\(d\.token, d\.stationId\)/);
  });

  it("qc-actions blocks inactive stations", () => {
    expect(qcActionsSrc).toMatch(/assertStationActiveForFloorActions/);
  });

  it("open operator session blocks inactive; end shift does not", () => {
    const openIdx = operatorSrc.indexOf("export async function openOperatorSessionAction");
    const endIdx = operatorSrc.indexOf("export async function endOperatorSessionAction");
    const openBlock = operatorSrc.slice(openIdx, endIdx);
    const endBlock = operatorSrc.slice(endIdx, endIdx + 1200);
    expect(openBlock).toMatch(/assertStationActiveForFloorActions/);
    expect(endBlock).not.toMatch(/assertStationActiveForFloorActions/);
  });
});
