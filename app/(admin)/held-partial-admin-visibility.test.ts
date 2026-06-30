// P2-PARTIAL-KEEP v1.9 — admin visibility + supervisor guardrail for held
// partial bottle bags. Source-structural assertions (matching the repo's
// existing admin test style) since these surfaces are server/DB-bound and the
// default vitest run has no Postgres harness.

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const repo = (p: string) => readFileSync(join(__dirname, "..", "..", p), "utf8");

const qrLoaderSrc = repo("lib/db/queries/qr-cards.ts");
const qrListSrc = repo("app/(admin)/qr-cards/qr-cards-list.tsx");
const partialBagsSrc = repo("lib/production/partial-bags.ts");
const partialPageSrc = repo("app/(admin)/partial-bags/page.tsx");
const recoveryFormSrc = repo("app/(admin)/workflow-submissions/_workflow-recovery-form.tsx");
const recoveryTableSrc = repo("app/(admin)/workflow-submissions/workflow-table.tsx");
const recoveryActionSrc = repo("app/(admin)/workflow-submissions/actions.ts");

describe("QR-cards list — held-partial remaining visibility", () => {
  it("loader selects product kind + system remaining + operator estimate via scalar subselects (no fan-out)", () => {
    expect(qrLoaderSrc).toMatch(/productKind: products\.kind/);
    expect(qrLoaderSrc).toMatch(/systemRemainingQty: sql/);
    expect(qrLoaderSrc).toMatch(/operatorRemainingEstimate: sql/);
    // System remaining reads the closed allocation session balance.
    expect(qrLoaderSrc).toMatch(/raw_bag_allocation_sessions/);
    expect(qrLoaderSrc).toMatch(/ending_balance_qty/);
    // Operator estimate reads the BAG_FINALIZED payload, gated by source tag.
    expect(qrLoaderSrc).toMatch(/operator_remaining_estimate_source.*=.*'OPERATOR_ESTIMATE'/s);
    // Scalar subselects (LIMIT 1) avoid duplicating QR rows.
    expect(qrLoaderSrc).toMatch(/LIMIT 1/);
  });

  it("list renders system remaining and operator estimate as DISTINCT labelled values", () => {
    expect(qrListSrc).toMatch(/System remaining:/);
    expect(qrListSrc).toMatch(/Operator est\.:/);
    expect(qrListSrc).toMatch(/Partial bottle · QR held for reuse/);
    // The two values are not merged into one field.
    expect(qrListSrc).toMatch(/operatorRemainingEstimate/);
    expect(qrListSrc).toMatch(/systemRemainingQty/);
  });
});

describe("Partial-bags workbench — operator estimate", () => {
  it("loader attaches operatorRemainingEstimate from the BAG_FINALIZED payload (no new join)", () => {
    expect(partialBagsSrc).toMatch(/bottleFinalizePayloadRemainingEstimate/);
    expect(partialBagsSrc).toMatch(/operatorRemainingEstimate/);
    // Read from the already-in-scope workflow events, not a new query.
    expect(partialBagsSrc).toMatch(/wfEvents[\s\S]*BAG_FINALIZED[\s\S]*bottleFinalizePayloadRemainingEstimate/);
  });

  it("page shows the operator estimate separately and warns when it differs from system remaining", () => {
    expect(partialPageSrc).toMatch(/Operator est\./);
    expect(partialPageSrc).toMatch(/differs from system/);
    // Never overwrites remainingEstimate (system) with the operator value.
    expect(partialPageSrc).not.toMatch(/remainingEstimate:\s*row\.operatorRemainingEstimate/);
  });
});

describe("Supervisor guardrail — held partial bottle reset", () => {
  it("table computes a heldPartialBottle flag from product kind + finalized + bag_remains_partial", () => {
    expect(recoveryTableSrc).toMatch(/heldPartialBottle/);
    expect(recoveryTableSrc).toMatch(/productKind === "BOTTLE"/);
    expect(recoveryTableSrc).toMatch(/bag_remains_partial/);
    expect(recoveryTableSrc).toMatch(/heldPartialBottle=\{heldPartialBottle\}/);
  });

  it("recovery form shows a strong warning before releasing a held partial bottle QR", () => {
    expect(recoveryFormSrc).toMatch(/heldPartialBottle/);
    expect(recoveryFormSrc).toMatch(/QR held for a partial bottle bag/i);
    expect(recoveryFormSrc).toMatch(/abandoned, relabeled, or corrected/i);
    // Override is still possible — the confirm checkbox still gates submit.
    expect(recoveryFormSrc).toMatch(/disabled=\{pending \|\| !confirmed\}/);
  });

  it("action detects the held-partial-bottle case and audits the override", () => {
    expect(recoveryActionSrc).toMatch(/heldPartialBottle/);
    expect(recoveryActionSrc).toMatch(/assignedCard/);
    expect(recoveryActionSrc).toMatch(/bag_remains_partial/);
    expect(recoveryActionSrc).toMatch(/workflow_recovery\.held_partial_bottle_override/);
    // The CARD_FORCE_RELEASED event carries the flag when a release happens.
    expect(recoveryActionSrc).toMatch(/held_partial_bottle: true/);
    // Override remains possible (still uses the existing resetAllowed gate).
    expect(recoveryActionSrc).toMatch(/if \(resetAllowed\)/);
  });
});
