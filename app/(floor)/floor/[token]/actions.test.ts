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

describe("BLISTER-AUTO-RELEASE-1 · blister complete auto-releases", () => {
  it("chains maybeAutoReleaseAfterComplete after BLISTER_COMPLETE on BLISTER stations", () => {
    expect(actionsSrc).toMatch(
      /eventType === "BLISTER_COMPLETE" && station\.kind === "BLISTER"/,
    );
    expect(actionsSrc).toMatch(/maybeAutoReleaseAfterComplete/);
    const blisterIdx = actionsSrc.indexOf(
      'eventType === "BLISTER_COMPLETE" && station.kind === "BLISTER"',
    );
    const autoIdx = actionsSrc.indexOf("await maybeAutoReleaseAfterComplete");
    expect(autoIdx).toBeGreaterThan(blisterIdx);
  });

  it("does not auto-release on COMBINED BLISTER_COMPLETE", () => {
    expect(actionsSrc).toMatch(
      /eventType === "BLISTER_COMPLETE" && station\.kind === "BLISTER"/,
    );
    expect(actionsSrc).not.toMatch(
      /eventType === "BLISTER_COMPLETE" && station\.kind === "COMBINED"/,
    );
  });

  it("BLISTER is in AUTO_RELEASE_AFTER_COMPLETE_STATION_KINDS with BLISTERED release stage", () => {
    expect(actionsSrc).toMatch(/AUTO_RELEASE_AFTER_COMPLETE_STATION_KINDS[\s\S]*"BLISTER"/);
    const helperIdx = actionsSrc.indexOf("function maybeAutoReleaseAfterComplete");
    const helperBlock = actionsSrc.slice(helperIdx, helperIdx + 1200);
    expect(helperBlock).toMatch(/STATION_RELEASE_FROM_STAGE\[args\.stationKind\]/);
    expect(helperBlock).toMatch(/-auto-release/);
  });

  it("BLISTER_COMPLETE payload still records count_total", () => {
    const fireIdx = actionsSrc.indexOf("export async function fireStageEventAction");
    const pauseIdx = actionsSrc.indexOf("// ── pause / resume");
    const block = actionsSrc.slice(fireIdx, pauseIdx);
    expect(block).toMatch(/count_total/);
    expect(block).not.toMatch(/BLISTER_COMPLETE[\s\S]{0,200}packs_remaining/s);
  });

  it("first-op count guard unchanged for BLISTER_COMPLETE", () => {
    expect(actionsSrc).toMatch(
      /FIRST_OP_COUNT_EVENTS\.has\(eventType\) &&\s*!accountability\.accountableEmployeeId/,
    );
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

describe("PRODUCT-SELECTION-AT-SEALING-1 · floor actions", () => {
  it("imports sealing product helpers", () => {
    expect(actionsSrc).toMatch(/from "@\/lib\/production\/sealing-product"/);
    expect(actionsSrc).toMatch(/validateSealingProductPick/);
    expect(actionsSrc).toMatch(/SEALING_STATION_KINDS/);
  });

  it("fireStageEventAction accepts optional productId for sealing mapping", () => {
    expect(actionsSrc).toMatch(/productId: z\.string\(\)\.uuid\(\)/);
    expect(actionsSrc).toMatch(/pickedSealingProductId/);
  });

  it("scanCardAction links inventory bag from QR scan token at first-op start", () => {
    const scanIdx = actionsSrc.indexOf("export async function scanCardAction");
    const stageIdx = actionsSrc.indexOf("// ── stage events");
    const block = actionsSrc.slice(scanIdx, stageIdx);
    expect(block).toMatch(/lookupInventoryBagByQrScanToken/);
    expect(block).toMatch(/inventoryBagId: inventoryLink\.inventoryBagId/);
    expect(block).toMatch(/inventory_bag_id: inventoryLink\.inventoryBagId/);
    expect(block).toMatch(/tablet_type_id: inventoryLink\.tabletTypeId/);
  });

  it("does not emit PRODUCT_MAPPED at scan when first-op returns null product", () => {
    const scanIdx = actionsSrc.indexOf("export async function scanCardAction");
    const stageIdx = actionsSrc.indexOf("// ── stage events");
    const block = actionsSrc.slice(scanIdx, stageIdx);
    expect(block).toMatch(/if \(productIdToSet && productLookup\)/);
  });

  it("SEALING_COMPLETE maps product before SEALING_COMPLETE event", () => {
    const fireIdx = actionsSrc.indexOf("export async function fireStageEventAction");
    const pauseIdx = actionsSrc.indexOf("// ── pause / resume");
    const block = actionsSrc.slice(fireIdx, pauseIdx);
    expect(block).toMatch(/eventType: "PRODUCT_MAPPED"/);
    expect(block).toMatch(/source: "SEALING_SELECTION"/);
    const mapIdx = block.indexOf('eventType: "PRODUCT_MAPPED"');
    const sealIdx = block.indexOf("await projectEvent(tx, {", mapIdx + 1);
    expect(mapIdx).toBeGreaterThan(-1);
    expect(sealIdx).toBeGreaterThan(mapIdx);
  });

  it("handpack lot lookup runs inside transaction after product map", () => {
    const fireIdx = actionsSrc.indexOf("export async function fireStageEventAction");
    const pauseIdx = actionsSrc.indexOf("// ── pause / resume");
    const block = actionsSrc.slice(fireIdx, pauseIdx);
    expect(block).toMatch(/lookupProductMatchedBlisterCardLot\(\s*workflowBagId,\s*tx/);
  });

  it("rejects routine remapping when product already set", () => {
    expect(actionsSrc).toMatch(
      /Product is already set on this bag and cannot be changed here/,
    );
  });

  it("requires product before SEALING_COMPLETE when bag has no product", () => {
    expect(actionsSrc).toMatch(
      /Select the finished product before completing sealing/,
    );
  });

  it("resolves tablet type via shared workflow bag resolver for sealing pick", () => {
    const fireIdx = actionsSrc.indexOf("export async function fireStageEventAction");
    const pauseIdx = actionsSrc.indexOf("// ── pause / resume");
    const block = actionsSrc.slice(fireIdx, pauseIdx);
    expect(block).toMatch(/resolveWorkflowBagTabletTypeId/);
    const mapBlock = block.slice(block.indexOf('eventType: "PRODUCT_MAPPED"') - 400);
    expect(mapBlock).not.toMatch(/bagQrCode/);
  });
});

describe("HANDPACK-TABLET-TYPE-SOURCE-1 · floor actions", () => {
  it("eventSchema accepts optional tabletTypeId", () => {
    expect(actionsSrc).toMatch(/tabletTypeId: z\.string\(\)\.uuid\(\)/);
  });

  it("fireStageEventAction reads tabletTypeId from FormData", () => {
    const fireIdx = actionsSrc.indexOf("export async function fireStageEventAction");
    const pauseIdx = actionsSrc.indexOf("// ── pause / resume");
    const block = actionsSrc.slice(fireIdx, pauseIdx);
    expect(block).toMatch(/formData\.get\("tabletTypeId"\)/);
    expect(block).toMatch(/pickedHandpackTabletTypeId/);
  });

  it("HANDPACK_BLISTER_COMPLETE payload includes tablet_type_id when provided", () => {
    const fireIdx = actionsSrc.indexOf("export async function fireStageEventAction");
    const pauseIdx = actionsSrc.indexOf("// ── pause / resume");
    const block = actionsSrc.slice(fireIdx, pauseIdx);
    expect(block).toMatch(/HANDPACK_BLISTER_COMPLETE.*tablet_type_id/s);
    expect(block).toMatch(/pickedHandpackTabletTypeId/);
  });

  it("product selection still happens at sealing, not hand-pack", () => {
    const fireIdx = actionsSrc.indexOf("export async function fireStageEventAction");
    const pauseIdx = actionsSrc.indexOf("// ── pause / resume");
    const block = actionsSrc.slice(fireIdx, pauseIdx);
    // PRODUCT_MAPPED is only emitted for SEALING_COMPLETE, not HANDPACK_BLISTER_COMPLETE
    expect(block).toMatch(/eventType === "SEALING_COMPLETE".*pickedSealingProductId/s);
    // No product_id in HANDPACK_BLISTER payload
    expect(block).not.toMatch(/HANDPACK_BLISTER_COMPLETE.*product_id/s);
  });
});

describe("BLISTER-MACHINE-COUNTER-1 · pause schema accepts foil_swap", () => {
  it("pauseSchema reason enum includes foil_swap", () => {
    expect(actionsSrc).toMatch(/z\.enum\(\[.*"foil_swap".*\]\)/s);
  });

  it("pauseSchema reason enum still includes pvc_swap", () => {
    expect(actionsSrc).toMatch(/z\.enum\(\[.*"pvc_swap".*\]\)/s);
  });

  it("pauseSchema reason enum still includes shift_end, machine_jam, qa_check, other", () => {
    const enumMatch = actionsSrc.match(/reason: z\.enum\(\[([^\]]+)\]\)/)?.[1] ?? "";
    expect(enumMatch).toMatch(/shift_end/);
    expect(enumMatch).toMatch(/machine_jam/);
    expect(enumMatch).toMatch(/qa_check/);
    expect(enumMatch).toMatch(/other/);
  });
});

describe("OPERATOR-SHIFT-SUBMIT-BLOCK-1 · first-op count guard", () => {
  it("FIRST_OP_COUNT_EVENTS includes BLISTER_COMPLETE and BOTTLE_HANDPACK_COMPLETE only", () => {
    const setMatch =
      actionsSrc.match(
        /const FIRST_OP_COUNT_EVENTS[^=]*=\s*new Set\(\[([\s\S]*?)\]\)/,
      )?.[1] ?? "";
    expect(setMatch).toMatch(/"BLISTER_COMPLETE"/);
    expect(setMatch).toMatch(/"BOTTLE_HANDPACK_COMPLETE"/);
    expect(setMatch).not.toMatch(/"SEALING_COMPLETE"/);
    expect(setMatch).not.toMatch(/"HANDPACK_BLISTER_COMPLETE"/);
  });

  it("refuses first-op count when accountableEmployeeId is null", () => {
    expect(actionsSrc).toMatch(
      /FIRST_OP_COUNT_EVENTS\.has\(eventType\) &&\s*!accountability\.accountableEmployeeId/,
    );
    expect(actionsSrc).toMatch(
      /No operator on shift\. Open a shift on this station before submitting the first count/,
    );
  });

  it("does not weaken guard for LEGACY_TEXT sessions", () => {
    expect(actionsSrc).not.toMatch(/LEGACY_TEXT.*accountableEmployeeId/s);
  });
});
