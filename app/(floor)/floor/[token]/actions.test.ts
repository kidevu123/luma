import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const actionsSrc = readFileSync(join(__dirname, "actions.ts"), "utf8");

describe("SEALING-COUNTER-1 · fireStageEventAction sealing path", () => {
  it("imports sealing-counter helpers", () => {
    expect(actionsSrc).toMatch(/from "@\/lib\/production\/sealing-counter"/);
    expect(actionsSrc).toMatch(/computeSealedCountFromCounter/);
    expect(actionsSrc).toMatch(/resolveSealingCardsPerPress/);
    expect(actionsSrc).toMatch(/stationUsesSealingCounter/);
  });

  it("SEALING_COMPLETE accepts counterPresses and computes count server-side", () => {
    expect(actionsSrc).toMatch(/counterPresses/);
    expect(actionsSrc).toMatch(/eventType === "SEALING_COMPLETE"/);
    expect(actionsSrc).toMatch(/computeSealedCountFromCounter/);
    expect(actionsSrc).toMatch(/counter_presses/);
    expect(actionsSrc).toMatch(/cards_per_press/);
  });

  it("rejects SEALING_COMPLETE when machine cards-per-press is missing", () => {
    expect(actionsSrc).toMatch(/SEALING_COUNTER_CONFIG_ERROR/);
  });

  it("does not import stage-progression changes", () => {
    expect(actionsSrc).not.toMatch(/EVENT_STAGE_PREREQ\s*=/);
  });
});

describe("SEALING-FLOW-CLARITY-2 · unified hand-pack sealing", () => {
  it("uses hand-pack material helper after SEALING_COMPLETE", () => {
    expect(actionsSrc).toMatch(/from "@\/lib\/production\/handpack-seal-material"/);
    expect(actionsSrc).toMatch(/workflowBagHasHandpackBlisterComplete/);
    expect(actionsSrc).toMatch(/issueHandpackBlisterCardMaterial/);
    expect(actionsSrc).toMatch(/needsHandpackBlisterMaterial/);
  });

  it("sealHandpackBagAction removed", () => {
    expect(actionsSrc).not.toMatch(/export async function sealHandpackBagAction/);
    expect(actionsSrc).not.toMatch(/plasticBlisterCount/);
  });
});

describe("SEALING-COUNTER-UI-2 · server payload unchanged for material path", () => {
  it("SEALING_COMPLETE still records counter_presses, cards_per_press, count_total", () => {
    expect(actionsSrc).toMatch(/counter_presses/);
    expect(actionsSrc).toMatch(/cards_per_press/);
    expect(actionsSrc).toMatch(/count_total/);
  });

  it("hand-pack BLISTER_CARD issuance still keyed on count_total", () => {
    expect(actionsSrc).toMatch(/issueHandpackBlisterCardMaterial/);
    expect(actionsSrc).toMatch(/needsHandpackBlisterMaterial/);
  });
});

describe("SEALING-MATERIAL-NONBLOCKING-1 · sealing never blocked by blister lot", () => {
  it("uses product-matched lot lookup — not global oldest", () => {
    expect(actionsSrc).toMatch(/lookupProductMatchedBlisterCardLot/);
    expect(actionsSrc).not.toMatch(/findOldestAvailableBlisterCardLot/);
  });

  it("does not return pre-made blister lot error to floor UI", () => {
    expect(actionsSrc).not.toMatch(/No available pre-made blister lot found/);
    expect(actionsSrc).not.toMatch(/Receive stock first/);
  });

  it("records skip audit fields when material lot unavailable", () => {
    expect(actionsSrc).toMatch(/handpack_blister_material_skipped/);
    expect(actionsSrc).toMatch(/handpack_blister_material_skip_reason/);
  });
});

describe("SEALING-AUTO-RELEASE-1 · sealing complete auto-releases", () => {
  it("chains maybeAutoReleaseAfterComplete after SEALING_COMPLETE on SEALING stations", () => {
    expect(actionsSrc).toMatch(
      /eventType === "SEALING_COMPLETE" && station\.kind === "SEALING"/,
    );
    expect(actionsSrc).toMatch(/maybeAutoReleaseAfterComplete/);
  });

  it("does not auto-release on COMBINED SEALING_COMPLETE", () => {
    const match = actionsSrc.match(
      /SEALING_COMPLETE[\s\S]{0,80}maybeAutoReleaseAfterComplete/,
    );
    expect(match?.[0]).toMatch(/station\.kind === "SEALING"/);
  });
});

describe("PACKAGING-AUTO-FINALIZE-1 · packaging close-out auto-finalizes", () => {
  it("chains maybeAutoFinalizeAfterPackagingComplete after PACKAGING_COMPLETE on PACKAGING stations", () => {
    expect(actionsSrc).toMatch(/station\.kind === "PACKAGING"/);
    expect(actionsSrc).toMatch(/maybeAutoFinalizeAfterPackagingComplete/);
    const pkgIdx = actionsSrc.indexOf("export async function packagingCompleteAction");
    const lookupIdx = actionsSrc.indexOf("export async function lookupCardByTokenAction");
    const block = actionsSrc.slice(pkgIdx, lookupIdx);
    expect(block).toMatch(/maybeAutoFinalizeAfterPackagingComplete/);
    expect(block).toMatch(/emitCountBasedPackagingConsumption/);
  });

  it("uses shared projectBagFinalizedEvent for manual finalize and auto-finalize", () => {
    expect(actionsSrc).toMatch(/function projectBagFinalizedEvent/);
    expect(actionsSrc).toMatch(/projectBagFinalizedEvent[\s\S]*BAG_FINALIZED/);
    const finalizeIdx = actionsSrc.indexOf("export async function finalizeBagAction");
    const releaseIdx = actionsSrc.indexOf("// ── release to next station");
    const finalizeBlock = actionsSrc.slice(finalizeIdx, releaseIdx);
    expect(finalizeBlock).toMatch(/projectBagFinalizedEvent/);
  });

  it("auto-finalize is idempotent with -auto-finalize clientEventId suffix", () => {
    expect(actionsSrc).toMatch(/-auto-finalize/);
    expect(actionsSrc).toMatch(/AUTO_FINALIZE_AFTER_PACKAGING_COMPLETE_STATION_KINDS/);
  });

  it("does not auto-finalize on COMBINED PACKAGING_COMPLETE", () => {
    const pkgIdx = actionsSrc.indexOf("export async function packagingCompleteAction");
    const lookupIdx = actionsSrc.indexOf("export async function lookupCardByTokenAction");
    const block = actionsSrc.slice(pkgIdx, lookupIdx);
    expect(block).toMatch(/if \(station\.kind === "PACKAGING"\)/);
    expect(block).not.toMatch(/COMBINED[\s\S]{0,40}maybeAutoFinalizeAfterPackagingComplete/);
  });

  it("auto-finalize guards on PACKAGED stage, not finalized, and station pin", () => {
    const helperIdx = actionsSrc.indexOf("function maybeAutoFinalizeAfterPackagingComplete");
    const helperBlock = actionsSrc.slice(helperIdx, helperIdx + 1200);
    expect(helperBlock).toMatch(/stage !== "PACKAGED"/);
    expect(helperBlock).toMatch(/isFinalized/);
    expect(helperBlock).toMatch(/currentWorkflowBagId/);
  });

  it("packaging payload keys unchanged", () => {
    const pkgIdx = actionsSrc.indexOf("export async function packagingCompleteAction");
    const lookupIdx = actionsSrc.indexOf("export async function lookupCardByTokenAction");
    const block = actionsSrc.slice(pkgIdx, lookupIdx);
    expect(block).toMatch(/master_cases/);
    expect(block).toMatch(/displays_made/);
    expect(block).toMatch(/loose_cards/);
    expect(block).toMatch(/damaged_packaging/);
    expect(block).toMatch(/ripped_cards/);
  });
});
