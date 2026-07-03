// QR-RESERVE-REPAIR-1 — re-reserve a bag's own IDLE QR (lost intake
// reservation). The DB path runs against Postgres (no harness in the default
// vitest run), so the guard is tested pure + the action/UI structurally.

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

// bag-edits imports @/lib/db at top level; stub it for the pure guard.
vi.mock("@/lib/db", () => ({ db: {} }));

import { canRepairQrReservation } from "@/lib/db/queries/bag-edits";
import { classifyQrIdlePointedBag } from "@/lib/db/queries/lost-qr-reservations";

const RAW_IDLE = { cardType: "RAW_BAG", status: "IDLE", assignedWorkflowBagId: null };

describe("canRepairQrReservation — fail closed", () => {
  it("re-reserves a bag's own IDLE RAW_BAG card with no conflict (bag-card-199 case)", () => {
    expect(
      canRepairQrReservation({
        bagStatus: "AVAILABLE",
        bagQrCode: "bag-card-199",
        card: { ...RAW_IDLE },
        otherBagClaimsToken: false,
      }),
    ).toEqual({ ok: true });
  });

  it("no repair needed when the card is already ASSIGNED", () => {
    const r = canRepairQrReservation({
      bagStatus: "AVAILABLE",
      bagQrCode: "bag-card-199",
      card: { cardType: "RAW_BAG", status: "ASSIGNED", assignedWorkflowBagId: null },
      otherBagClaimsToken: false,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/already reserved/i);
  });

  it("NEVER touches a card active in a production run", () => {
    const r = canRepairQrReservation({
      bagStatus: "AVAILABLE",
      bagQrCode: "bag-card-199",
      card: { cardType: "RAW_BAG", status: "IDLE", assignedWorkflowBagId: "wf-1" },
      otherBagClaimsToken: false,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/active in a production run/i);
  });

  it("blocks wrong card type, retired card, token conflict, and missing token", () => {
    expect(canRepairQrReservation({ bagStatus: "AVAILABLE", bagQrCode: "x", card: { cardType: "VARIETY_PACK", status: "IDLE", assignedWorkflowBagId: null }, otherBagClaimsToken: false }).ok).toBe(false);
    expect(canRepairQrReservation({ bagStatus: "AVAILABLE", bagQrCode: "x", card: { cardType: "RAW_BAG", status: "RETIRED", assignedWorkflowBagId: null }, otherBagClaimsToken: false }).ok).toBe(false);
    expect(canRepairQrReservation({ bagStatus: "AVAILABLE", bagQrCode: "x", card: { ...RAW_IDLE }, otherBagClaimsToken: true }).ok).toBe(false);
    expect(canRepairQrReservation({ bagStatus: "AVAILABLE", bagQrCode: null, card: { ...RAW_IDLE }, otherBagClaimsToken: false }).ok).toBe(false);
    expect(canRepairQrReservation({ bagStatus: "AVAILABLE", bagQrCode: "x", card: null, otherBagClaimsToken: false }).ok).toBe(false);
  });

  it("only AVAILABLE bags are repairable — IN_USE/EMPTIED/VOID/QUARANTINED are all skipped", () => {
    for (const s of ["IN_USE", "EMPTIED", "DEPLETED", "VOID", "QUARANTINED"]) {
      const r = canRepairQrReservation({ bagStatus: s, bagQrCode: "x", card: { ...RAW_IDLE }, otherBagClaimsToken: false });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/only AVAILABLE/i);
    }
  });
});

const repo = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const bagEditsSrc = repo("lib/db/queries/bag-edits.ts");
const actionsSrc = repo("app/(admin)/inbound/[id]/bag/[bagId]/edit/actions.ts");
const pageSrc = repo("app/(admin)/inbound/[id]/page.tsx");
const buttonSrc = repo("app/(admin)/inbound/[id]/repair-qr-reservation-button.tsx");

describe("repair — audited, race-safe, no workflow allocation touch", () => {
  it("only flips an IDLE/unassigned card to ASSIGNED (conditional update) and audits it", () => {
    expect(bagEditsSrc).toMatch(/status: "ASSIGNED"[\s\S]{0,80}assignedWorkflowBagId: null/);
    expect(bagEditsSrc).toMatch(/eq\(qrCards\.status, "IDLE"\), isNull\(qrCards\.assignedWorkflowBagId\)/);
    expect(bagEditsSrc).toMatch(/action: "qr_card\.reservation_repaired"/);
    // Does NOT touch allocation sessions / workflow bags.
    const start = bagEditsSrc.indexOf("export async function repairQrReservation");
    const body = bagEditsSrc.slice(start, start + 2200);
    expect(body).not.toMatch(/rawBagAllocationSessions|workflowBags|closeAllocation/);
  });

  it("action is lead-gated and revalidates the receive page", () => {
    expect(actionsSrc).toMatch(/export async function repairQrReservationAction/);
    expect(actionsSrc).toMatch(/repairQrReservationAction[\s\S]{0,120}requireLead\(\)/);
  });

  it("receive page shows the Re-reserve button ONLY for RESERVATION_LOST rows", () => {
    expect(pageSrc).toMatch(/codes\.includes\("BLOCKED_QR_RESERVATION_LOST"\)/);
    expect(pageSrc).toMatch(/RepairQrReservationButton/);
    expect(buttonSrc).toMatch(/repairQrReservationAction/);
    expect(buttonSrc).toMatch(/Re-reserve QR/);
  });
});

// ── BATCH-LOST-QR-RESERVATION-REPAIR-1 — detector + batch + edit reconcile ──

const lostSrc = repo("lib/db/queries/lost-qr-reservations.ts");
const routeSrc = repo("app/api/admin/repair-lost-qr-reservations/route.ts");
const batchButtonSrc = repo("app/(admin)/inbound/[id]/repair-lost-qr-reservations-button.tsx");

describe("batch detector + repair — reuses the single-row guard, audited, no allocation touch", () => {
  it("detector classifies each candidate with the SAME canRepairQrReservation guard (no duplicate logic)", () => {
    expect(lostSrc).toMatch(/canRepairQrReservation\(/);
    expect(lostSrc).toMatch(/eq\(qrCards\.cardType, "RAW_BAG"\)/);
    expect(lostSrc).toMatch(/eq\(qrCards\.status, "IDLE"\)/);
    expect(lostSrc).toMatch(/isNull\(qrCards\.assignedWorkflowBagId\)/);
    // token-claimed-by-multiple detection feeds the guard's conflict flag
    expect(lostSrc).toMatch(/otherBagClaimsToken/);
  });

  it("batch repairs only safe rows via the single-row repairQrReservation (per-row re-check), capped", () => {
    expect(lostSrc).toMatch(/BATCH_LOST_QR_RESERVATION_CAP = 100/);
    expect(lostSrc).toMatch(/\.filter\(\(c\) => c\.safe\)/);
    expect(lostSrc).toMatch(/repairQrReservation\(c\.inventoryBagId, actor\)/);
  });

  it("writes a batch audit (BATCH_LOST_QR_RESERVATION_REPAIR) and never touches workflow/allocation/finished-lot/Zoho", () => {
    expect(lostSrc).toMatch(/action: "qr_card\.reservation_repair_batch"/);
    expect(lostSrc).toMatch(/source: "BATCH_LOST_QR_RESERVATION_REPAIR"/);
    // The batch repair body touches no workflow/allocation/finished-lot/Zoho
    // tables (the read-only report may JOIN workflowBags, so scope to the fn).
    const start = lostSrc.indexOf("export async function repairLostQrReservationsBatch");
    const body = lostSrc.slice(start, start + 1600);
    expect(body).not.toMatch(/rawBagAllocationSessions|workflowBags|finishedLots|zohoProductionOutput/);
    // No table mutation anywhere in the module (detector + batch are read-only
    // except the per-card qr_cards flip inside repairQrReservation, in bag-edits).
    expect(lostSrc).not.toMatch(/\.update\(|\.insert\(|\.delete\(/);
  });

  it("bearer route is auth-gated; GET is read-only dry-run, POST executes with a system actor", () => {
    expect(routeSrc).toMatch(/validateCronBearer/);
    expect(routeSrc).toMatch(/export async function GET/);
    expect(routeSrc).toMatch(/listLostQrReservationCandidates/);
    expect(routeSrc).toMatch(/export async function POST/);
    expect(routeSrc).toMatch(/repairLostQrReservationsBatch\(\{ id: null, role: null \}\)/);
  });

  it("admin batch action is admin-gated; button confirms and reports repaired/skipped", () => {
    expect(actionsSrc).toMatch(/export async function repairLostQrReservationsAction/);
    expect(actionsSrc).toMatch(/repairLostQrReservationsAction[\s\S]{0,320}requireAdmin\(\)/);
    expect(batchButtonSrc).toMatch(/repairLostQrReservationsAction/);
    expect(batchButtonSrc).toMatch(/Repair lost QR reservations/);
  });
});

describe("classifyQrIdlePointedBag — intake vs production-side (fail closed)", () => {
  it("AVAILABLE + guard-ok = SAFE_INTAKE_LOST_RESERVATION (the only actionable category)", () => {
    const r = classifyQrIdlePointedBag({ bagStatus: "AVAILABLE", hasWorkflow: false, workflowFinalized: false, intakeGuardOk: true });
    expect(r.category).toBe("SAFE_INTAKE_LOST_RESERVATION");
    expect(r.actionable).toBe(true);
  });
  it("AVAILABLE + guard-fail (e.g. conflict) = AVAILABLE_NEEDS_REVIEW (not actionable)", () => {
    const r = classifyQrIdlePointedBag({ bagStatus: "AVAILABLE", hasWorkflow: false, workflowFinalized: false, intakeGuardOk: false });
    expect(r.category).toBe("AVAILABLE_NEEDS_REVIEW");
    expect(r.actionable).toBe(false);
  });
  it("IN_USE + finalized workflow = IN_USE_FINALIZED_QR_RELEASED (expected history, not actionable)", () => {
    const r = classifyQrIdlePointedBag({ bagStatus: "IN_USE", hasWorkflow: true, workflowFinalized: true, intakeGuardOk: false });
    expect(r.category).toBe("IN_USE_FINALIZED_QR_RELEASED");
    expect(r.actionable).toBe(false);
  });
  it("IN_USE + ACTIVE workflow = IN_USE_ACTIVE_QR_IDLE (real desync — manual review, not actionable)", () => {
    const r = classifyQrIdlePointedBag({ bagStatus: "IN_USE", hasWorkflow: true, workflowFinalized: false, intakeGuardOk: false });
    expect(r.category).toBe("IN_USE_ACTIVE_QR_IDLE");
    expect(r.actionable).toBe(false);
  });
  it("IN_USE + no workflow = IN_USE_NO_WORKFLOW; EMPTIED/DEPLETED = DEPLETED_QR_RELEASED; other = OTHER_NEEDS_REVIEW", () => {
    expect(classifyQrIdlePointedBag({ bagStatus: "IN_USE", hasWorkflow: false, workflowFinalized: false, intakeGuardOk: false }).category).toBe("IN_USE_NO_WORKFLOW");
    expect(classifyQrIdlePointedBag({ bagStatus: "EMPTIED", hasWorkflow: true, workflowFinalized: true, intakeGuardOk: false }).category).toBe("DEPLETED_QR_RELEASED");
    expect(classifyQrIdlePointedBag({ bagStatus: "DEPLETED", hasWorkflow: true, workflowFinalized: true, intakeGuardOk: false }).category).toBe("DEPLETED_QR_RELEASED");
    expect(classifyQrIdlePointedBag({ bagStatus: "QUARANTINED", hasWorkflow: false, workflowFinalized: false, intakeGuardOk: false }).category).toBe("OTHER_NEEDS_REVIEW");
  });
  it("ONLY SAFE_INTAKE_LOST_RESERVATION is actionable — every other category is review/expected", () => {
    const nonActionable = [
      classifyQrIdlePointedBag({ bagStatus: "IN_USE", hasWorkflow: true, workflowFinalized: true, intakeGuardOk: false }),
      classifyQrIdlePointedBag({ bagStatus: "IN_USE", hasWorkflow: true, workflowFinalized: false, intakeGuardOk: false }),
      classifyQrIdlePointedBag({ bagStatus: "EMPTIED", hasWorkflow: true, workflowFinalized: true, intakeGuardOk: false }),
      classifyQrIdlePointedBag({ bagStatus: "AVAILABLE", hasWorkflow: false, workflowFinalized: false, intakeGuardOk: false }),
    ];
    expect(nonActionable.every((r) => !r.actionable)).toBe(true);
  });
});

describe("production-desync detector + script — read-only, separate buckets", () => {
  it("report classifies with the pure classifier + intake guard, and never mutates", () => {
    expect(lostSrc).toMatch(/export async function listQrProductionDesyncReport/);
    expect(lostSrc).toMatch(/classifyQrIdlePointedBag\(/);
    expect(lostSrc).not.toMatch(/\.update\(|\.insert\(|\.delete\(/);
  });
  it("npm script + detector script exist and are read-only", () => {
    const pkg = repo("package.json");
    expect(pkg).toMatch(/"detect:qr-production-desync": "tsx scripts\/detect-qr-production-desync\.ts"/);
    const scriptSrc = repo("scripts/detect-qr-production-desync.ts");
    expect(scriptSrc).toMatch(/classifyQrIdlePointedBag/);
    expect(scriptSrc).not.toMatch(/\.update\(|\.insert\(|\.delete\(|UPDATE |INSERT |DELETE /);
  });
});

describe("edit flow — self-heals the invariant (AVAILABLE bag claiming RAW_BAG token ⇒ ASSIGNED)", () => {
  it("re-reserves a drifted IDLE card on save via a conditional update + audit (no double audit on swap)", () => {
    // Runs only for AVAILABLE bags, only flips IDLE→ASSIGNED, guarded by conflict check.
    expect(bagEditsSrc).toMatch(/finalToken && bag\.status === "AVAILABLE"/);
    expect(bagEditsSrc).toMatch(/finalCard\.status === "IDLE"/);
    expect(bagEditsSrc).toMatch(/finalCard\.assignedWorkflowBagId === null/);
    expect(bagEditsSrc).toMatch(/eq\(qrCards\.status, "IDLE"\),\s*isNull\(qrCards\.assignedWorkflowBagId\)/);
  });
});

void vi;
