// BOTTLE-SEALING-RECOVERY-1 — coverage for the packaging-station recovery that
// clears a stale bottle sealing hold. The write path runs against Postgres
// (no harness in the default vitest run), so these are structural assertions on
// the action / page / panel plus the pure stage-progression helpers.

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  bothBottleFinishingDone,
  missingBottleFinishingSteps,
  BOTTLE_FINISHING_EVENTS,
} from "./stage-progression";

const repo = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const actionsSrc = repo("app/(floor)/floor/[token]/actions.ts");
const pageSrc = repo("app/(floor)/floor/[token]/page.tsx");
const panelSrc = repo("app/(floor)/floor/[token]/bottle-sealing-recovery-panel.tsx");

describe("stage helpers — bottle finishing gate (pure)", () => {
  it("a bag with neither finishing event is not done, and both are missing", () => {
    expect(bothBottleFinishingDone([])).toBe(false);
    expect(missingBottleFinishingSteps([])).toHaveLength(2);
  });
  it("a bag with both finishing events is done (nothing to recover)", () => {
    expect(bothBottleFinishingDone([...BOTTLE_FINISHING_EVENTS])).toBe(true);
    expect(missingBottleFinishingSteps([...BOTTLE_FINISHING_EVENTS])).toHaveLength(0);
  });
});

describe("recoverBottleSealingHoldAction — product-kind aware, lead-gated, safe", () => {
  it("is only available at a finalizing (packaging) station", () => {
    expect(actionsSrc).toMatch(/export async function recoverBottleSealingHoldAction/);
    expect(actionsSrc).toMatch(/STATIONS_THAT_FINALIZE\.has\(station\.kind\)/);
  });

  it("requires a lead/supervisor badge — a normal operator cannot clear the hold", () => {
    expect(actionsSrc).toMatch(/sourceHint: "SUPERVISOR_OVERRIDE"/);
    expect(actionsSrc).toMatch(/Lead badge code not recognized/);
    expect(actionsSrc).toMatch(/note: z\.string\(\)\.min\(3\)/); // explicit note required
  });

  it("only applies to BOTTLE products and a not-finalized bag at a finishing-eligible stage", () => {
    expect(actionsSrc).toMatch(/row\.productKind !== "BOTTLE"/);
    expect(actionsSrc).toMatch(/only applies to bottle products/i);
    expect(actionsSrc).toMatch(/row\.isFinalized/);
    expect(actionsSrc).toMatch(/row\.stage !== "BLISTERED" && row\.stage !== "SEALED"/);
    // No-op guard when sealing is already complete.
    expect(actionsSrc).toMatch(/bothBottleFinishingDone\(priorTypes\)/);
  });

  it("records ONLY the missing finishing events via projectEvent with recovery provenance", () => {
    expect(actionsSrc).toMatch(/BOTTLE_FINISHING_EVENTS\.filter\(\(e\) => !priorTypes\.includes\(e\)\)/);
    expect(actionsSrc).toMatch(/recovery_source: "PACKAGING_STATION_RECOVERY"/);
    expect(actionsSrc).toMatch(/recovery_reason: "STALE_BOTTLE_SEALING_HOLD_CLEARED"/);
    expect(actionsSrc).toMatch(/accountabilitySource: "SUPERVISOR_OVERRIDE"/);
  });

  it("writes an audit event with the required provenance fields", () => {
    expect(actionsSrc).toMatch(/action: "packaging\.recover_bottle_sealing_hold"/);
    expect(actionsSrc).toMatch(/previous_stage:/);
    expect(actionsSrc).toMatch(/cleared_events: missing/);
    expect(actionsSrc).toMatch(/lead_employee_id: accountability\.accountableEmployeeId/);
    expect(actionsSrc).toMatch(/note: parsed\.data\.note\.trim\(\)/);
  });

  it("does NOT release the QR, close/deplete allocation, or finalize the bag", () => {
    // Scope the assertions to the recovery action body.
    const start = actionsSrc.indexOf("export async function recoverBottleSealingHoldAction");
    const end = actionsSrc.indexOf("export async function fireStageEventAction");
    const body = actionsSrc.slice(start, end);
    expect(body).not.toMatch(/status: "IDLE"/); // no QR release
    expect(body).not.toMatch(/assignedWorkflowBagId: null/);
    expect(body).not.toMatch(/rawBagAllocationSessions/); // no allocation mutation
    expect(body).not.toMatch(/closeAllocationSessionInTx/);
    expect(body).not.toMatch(/BAG_FINALIZED/); // no finalize
  });
});

describe("banner + panel — product-kind aware UI", () => {
  it("the card-line 'waiting for sealing' banner is suppressed for bottle products", () => {
    expect(pageSrc).toMatch(/if \(productKind === "BOTTLE"\) return null;/);
    // The card message still exists for non-bottle products.
    expect(pageSrc).toMatch(/Waiting for sealing to complete/);
  });

  it("renders the recovery panel only for a bottle bag stuck at BLISTERED at packaging", () => {
    expect(pageSrc).toMatch(/BottleSealingRecoveryPanel/);
    expect(pageSrc).toMatch(/currentAtStation\.product\?\.kind === "BOTTLE"/);
    expect(pageSrc).toMatch(/currentAtStation\.state\?\.stage === "BLISTERED"/);
  });

  it("panel uses bottle language (not card sealing) and states what it does NOT change", () => {
    expect(panelSrc).toMatch(/cap-seal/i);
    expect(panelSrc).toMatch(/sticker/i);
    // No card-line "still being sealed" language in the visible copy.
    expect(panelSrc).not.toMatch(/still being sealed/i);
    expect(panelSrc).toMatch(/Lead badge code/);
    expect(panelSrc).toMatch(/Reason \/ note \(required\)/);
    expect(panelSrc).toMatch(/does not release the QR|Does not release the QR/i);
    expect(panelSrc).toMatch(/recoverBottleSealingHoldAction/);
  });
});
