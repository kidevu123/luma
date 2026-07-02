import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const actionsSrc = readFileSync(join(__dirname, "actions.ts"), "utf8");
const projectorSrc = readFileSync(
  join(__dirname, "../../../../lib/projector/index.ts"),
  "utf8",
);

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

describe("BLISTER-PAUSE-COUNT-SNAPSHOT-1 · pause counter snapshots", () => {
  it("imports counter snapshot helpers and roll segment recorder", () => {
    expect(actionsSrc).toMatch(/stationRequiresBlisterCounterSnapshot/);
    expect(actionsSrc).toMatch(/parseNonnegativeIntegerInput/);
    expect(actionsSrc).toMatch(/recordBlisterCounterRollSegment/);
    expect(actionsSrc).toMatch(/pauseCounterSnapshotMissingError/);
  });

  it("pauseSchema accepts counterSnapshotCount as a nonnegative integer", () => {
    expect(actionsSrc).toMatch(/counterSnapshotCount/);
    expect(actionsSrc).toMatch(/z\.number\(\)\.int\(\)\.nonnegative\(\)\.optional/);
  });

  it("BLISTER and COMBINED pauses require reason-aware counter snapshot errors server-side", () => {
    expect(actionsSrc).toMatch(/stationRequiresBlisterCounterSnapshot\(\s*station\.kind/);
    expect(actionsSrc).toMatch(/pauseCounterSnapshotMissingError\(parsed\.data\.reason\)/);
  });

  it("pause payload stores the actual counter snapshot, including zero", () => {
    expect(actionsSrc).toMatch(/counter_snapshot_count/);
    expect(actionsSrc).toMatch(/counter_snapshot_reason/);
    expect(actionsSrc).toMatch(/good_blisters_since_last_reset/);
    expect(actionsSrc).toMatch(/operator_entry/);
  });

  it("positive pause snapshots emit roll segments and zero snapshots do not", () => {
    expect(actionsSrc).toMatch(/counterSnapshotCount > 0/);
    expect(actionsSrc).toMatch(/assertCounterSnapshotAllowed/);
    expect(actionsSrc).toMatch(/segmentReason/);
    expect(actionsSrc).toMatch(/PAUSE_SNAPSHOT/);
    expect(actionsSrc).toMatch(/SHIFT_END_SNAPSHOT/);
    // Roll usage rebuild moved to refreshMaterialReadModelsAfterBlister (53b6296).
    expect(actionsSrc).toMatch(/refreshMaterialReadModelsAfterBlister/);
    expect(actionsSrc).not.toMatch(/rebuildRollUsage/);
  });

  it("resume remains a plain BAG_RESUMED action without counter segment emission", () => {
    const resumeIdx = actionsSrc.indexOf("export async function resumeBagAction");
    const operatorIdx = actionsSrc.indexOf("// ── operator handoff");
    const block = actionsSrc.slice(resumeIdx, operatorIdx);
    expect(block).toMatch(/eventType: "BAG_RESUMED"/);
    expect(block).not.toMatch(/recordBlisterCounterRollSegment/);
    expect(block).not.toMatch(/counterSnapshotCount/);
  });
});

describe("COUNTER-SNAPSHOT-GUARD-1 · server-side counter guards", () => {
  it("pause and blister close-out call assertCounterSnapshotAllowed before segments", () => {
    expect(actionsSrc).toMatch(/assertCounterSnapshotAllowed/);
    expect(actionsSrc).toMatch(/"blister_close_out"/);
    expect(actionsSrc).toMatch(/"pause_shift_end"/);
    expect(actionsSrc).toMatch(/"pause_machine_jam"/);
  });

  it("does not replace recordBlisterCounterRollSegment for valid pause paths", () => {
    const pauseIdx = actionsSrc.indexOf("export async function pauseBagAction");
    const resumeIdx = actionsSrc.indexOf("export async function resumeBagAction");
    const pauseBlock = actionsSrc.slice(pauseIdx, resumeIdx);
    expect(pauseBlock).toMatch(/recordBlisterCounterRollSegment/);
    expect(pauseBlock).toMatch(/refreshMaterialReadModelsAfterBlister/);
    expect(pauseBlock).not.toMatch(/rebuildRollUsage/);
  });
});

describe("SEALING-AUTO-RELEASE-1 · sealing complete auto-releases", () => {
  it("chains maybeAutoReleaseAfterComplete after final SEALING on SEALING stations", () => {
    expect(actionsSrc).toMatch(/isSealingFinal && station\.kind === "SEALING"/);
    expect(actionsSrc).toMatch(/maybeAutoReleaseAfterComplete/);
  });

  it("does not auto-release on COMBINED SEALING_COMPLETE", () => {
    const match = actionsSrc.match(
      /isSealingFinal && station\.kind === "SEALING"[\s\S]{0,80}maybeAutoReleaseAfterComplete/,
    );
    expect(match?.[0]).toBeTruthy();
  });
});

describe("MULTI-SEALING-SAME-BAG-1 · segment vs final sealing", () => {
  it("allows SEALING_SEGMENT_COMPLETE on SEALING stations", () => {
    expect(actionsSrc).toMatch(/SEALING: \["SEALING_SEGMENT_COMPLETE", "SEALING_COMPLETE"\]/);
    expect(actionsSrc).toMatch(/"SEALING_SEGMENT_COMPLETE"/);
  });

  it("segment submit keeps bag pinned — handoff is explicit", () => {
    expect(actionsSrc).toMatch(/projectSealingStationHandoff/);
    expect(actionsSrc).toMatch(/releaseSealingHandoffAction/);
    expect(actionsSrc).not.toMatch(
      /isSealingSegment && isPureSealingStation[\s\S]{0,120}maybeAutoReleaseAfterSegment/,
    );
    expect(actionsSrc).toMatch(/SEALING_SEGMENT_EVENT/);
  });

  it("releaseSealingHandoffAction requires BLISTERED stage and prior segment", () => {
    expect(actionsSrc).toMatch(
      /Record a sealing segment on this machine before handing the bag off/,
    );
    expect(actionsSrc).toMatch(/Bag must be blistered before handoff/);
  });

  it("final SEALING_COMPLETE on pure sealing requires prior segment", () => {
    expect(actionsSrc).toMatch(
      /Record at least one sealing segment before marking sealing complete/,
    );
    expect(actionsSrc).toMatch(/lane_close: true/);
  });

  it("partial SEALING_COMPLETE validates reason and segment totals", () => {
    expect(actionsSrc).toMatch(/sealingCloseMode/);
    expect(actionsSrc).toMatch(/validateSealingPartialCloseInput/);
    expect(actionsSrc).toMatch(/buildPartialSealingClosePayload/);
    expect(actionsSrc).toMatch(/buildPartialSealingClosePayload/);
    expect(actionsSrc).toMatch(/maybeAutoReleaseAfterPartialSealingClose/);
  });

  it("partial SEALING_COMPLETE skips counter presses on pure sealing station", () => {
    expect(actionsSrc).toMatch(/sealingFinalOnPureStation/);
    const fireIdx = actionsSrc.indexOf("export async function fireStageEventAction");
    const pauseIdx = actionsSrc.indexOf("export async function pauseBagAction");
    const block = actionsSrc.slice(fireIdx, pauseIdx);
    expect(block).toMatch(
      /if \(sealingUsesCounter && !sealingFinalOnPureStation\)/,
    );
    expect(block).toMatch(
      /sealingUsesCounter && !sealingFinalOnPureStation[\s\S]*buildPartialSealingClosePayload/,
    );
    expect(block).not.toMatch(
      /isPartialSealingClose[\s\S]{0,120}SEALING_COUNTER_PRESS_ERROR/,
    );
  });

  it("partial close with no segments returns segment error not counter error", () => {
    const fireIdx = actionsSrc.indexOf("export async function fireStageEventAction");
    const pauseIdx = actionsSrc.indexOf("export async function pauseBagAction");
    const block = actionsSrc.slice(fireIdx, pauseIdx);
    const partialValIdx = block.indexOf("validateSealingPartialCloseInput");
    const counterIdx = block.indexOf("SEALING_COUNTER_PRESS_ERROR");
    expect(partialValIdx).toBeGreaterThan(-1);
    expect(counterIdx).toBeGreaterThan(partialValIdx);
  });

  it("packaging complete allows BLISTERED when partial sealing close-out exists", () => {
    expect(actionsSrc).toMatch(/packagingPartialSealedReady/);
    expect(actionsSrc).toMatch(/allowsPackagingCompleteAtBlistered/);
  });

  it("handpack material runs on segment not final close-only", () => {
    expect(actionsSrc).toMatch(/isSealingSegment \|\|\s*\(isSealingFinal && !isPureSealingStation\)/);
  });
});

describe("PACKAGING-AUTO-FINALIZE-1 · packaging close-out auto-finalizes", () => {
  it("chains maybeAutoFinalizeAfterPackagingComplete after PACKAGING_COMPLETE on PACKAGING stations", () => {
    expect(actionsSrc).toMatch(/station\.kind === "PACKAGING"/);
    expect(actionsSrc).toMatch(/maybeAutoFinalizeAfterPackagingComplete/);
    expect(actionsSrc).toMatch(/autoCreateAndReleaseFinishedLotForWorkflowBag/);
    const pkgIdx = actionsSrc.indexOf("export async function packagingCompleteAction");
    const lookupIdx = actionsSrc.indexOf("export async function lookupCardByTokenAction");
    const block = actionsSrc.slice(pkgIdx, lookupIdx);
    expect(block).toMatch(/maybeAutoFinalizeAfterPackagingComplete/);
    expect(block).toMatch(/runFinishedLotPostCommitEffects/);
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
    expect(block).toMatch(
      /if \(station\.kind === "PACKAGING" && !emitPartialPackaging\)/,
    );
    expect(block).not.toMatch(/COMBINED[\s\S]{0,40}maybeAutoFinalizeAfterPackagingComplete/);
  });

  it("only auto-creates and releases finished lots after successful full packaging auto-finalize", () => {
    const pkgIdx = actionsSrc.indexOf("export async function packagingCompleteAction");
    const lookupIdx = actionsSrc.indexOf("export async function lookupCardByTokenAction");
    const block = actionsSrc.slice(pkgIdx, lookupIdx);
    expect(block).toMatch(/if \(station\.kind === "PACKAGING" && !emitPartialPackaging\)/);
    expect(block).toMatch(/const didFinalize = await maybeAutoFinalizeAfterPackagingComplete/);
    expect(block).toMatch(/if \(didFinalize\)[\s\S]*autoCreateAndReleaseFinishedLotForWorkflowBag/);
    expect(block).not.toMatch(/emitPartialPackaging[\s\S]{0,120}autoCreateAndReleaseFinishedLotForWorkflowBag/);
  });

  it("audits auto finished lot exceptions without rolling back packaging completion", () => {
    const pkgIdx = actionsSrc.indexOf("export async function packagingCompleteAction");
    const lookupIdx = actionsSrc.indexOf("export async function lookupCardByTokenAction");
    const block = actionsSrc.slice(pkgIdx, lookupIdx);
    expect(block).toMatch(/finished_lot\.auto_create_blocked/);
    expect(block).toMatch(/targetType: "WorkflowBag"/);
    expect(block).toMatch(/reason: autoLot\.reason/);
  });

  it("auto-finalize guards on PACKAGED stage, not finalized, and station pin", () => {
    const helperIdx = actionsSrc.indexOf("function maybeAutoFinalizeAfterPackagingComplete");
    const helperBlock = actionsSrc.slice(helperIdx, helperIdx + 1800);
    expect(helperBlock).toMatch(/stage !== "PACKAGED"/);
    expect(helperBlock).toMatch(/isFinalized/);
    expect(helperBlock).toMatch(/currentWorkflowBagId/);
    expect(helperBlock).toMatch(/Promise<boolean>/);
    expect(helperBlock).toMatch(/return true/);
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
    expect(block).toMatch(/buildPartialPackagingCompletePayload/);
    expect(block).toMatch(/shouldEmitPartialPackagingComplete/);
  });
});

describe("P2-PARTIAL-KEEP · QR is never dropped for a partial bottle bag", () => {
  const finalizeBlock = (() => {
    const i = actionsSrc.indexOf("export async function finalizeBagAction");
    const j = actionsSrc.indexOf("// ── release to next station");
    return actionsSrc.slice(i, j);
  })();
  const pkgBlock = (() => {
    const i = actionsSrc.indexOf("export async function packagingCompleteAction");
    const j = actionsSrc.indexOf("export async function lookupCardByTokenAction");
    return actionsSrc.slice(i, j);
  })();

  it("projector releases the QR through the intent-aware guard, not the raw session rule", () => {
    expect(projectorSrc).toMatch(/shouldReleaseQrAtFinalizationWithIntent/);
    // The old un-guarded helper must not be the one wired into the finalize branch.
    expect(projectorSrc).not.toMatch(
      /if \(shouldReleaseQrAtFinalization\(wfSession/,
    );
  });

  it("MANUAL finalizeBagAction defers + re-decides QR release for bottle bags (A2 gap closed)", () => {
    // Determines the product kind and only defers for bottles.
    expect(finalizeBlock).toMatch(/products\.kind/);
    expect(finalizeBlock).toMatch(/const isBottleBag = bagProduct\?\.kind === "BOTTLE"/);
    // Defers the projector release and re-resolves after, never a bare finalize.
    expect(finalizeBlock).toMatch(/deferQrRelease: isBottleBag/);
    expect(finalizeBlock).toMatch(/if \(isBottleBag\)[\s\S]*resolveDeferredQrReleaseAfterPackaging/);
    // Carries the explicit operator keep-partial override.
    expect(finalizeBlock).toMatch(/keepPartial: keepBagPartial && isBottleBag/);
  });

  it("manual finalize is still a no-op deferral for card/variety (release behavior unchanged)", () => {
    // deferQrRelease is gated on isBottleBag, so non-bottle bags keep the
    // existing immediate session-rule release.
    expect(finalizeBlock).toMatch(/deferQrRelease: isBottleBag/);
    expect(finalizeBlock).not.toMatch(/deferQrRelease: true(?![\s\S]*isBottleBag)/);
  });

  it("packaging keep-partial + defer is scoped to bottle products only", () => {
    expect(pkgBlock).toMatch(/const isBottleBag = productRow\?\.kind === "BOTTLE"/);
    expect(pkgBlock).toMatch(/deferQrRelease: isBottleBag/);
    expect(pkgBlock).toMatch(/keepPartial: keepBagPartial && isBottleBag/);
    expect(pkgBlock).toMatch(/if \(isBottleBag\)[\s\S]*resolveDeferredQrReleaseAfterPackaging/);
  });

  it("deferred release only drops the QR when the bag is confirmed empty", () => {
    const i = actionsSrc.indexOf("function resolveDeferredQrReleaseAfterPackaging");
    const block = actionsSrc.slice(i, i + 2400);
    expect(block).toMatch(/shouldReleaseQrAfterPackagingClose/);
    expect(block).toMatch(/status: "IDLE", assignedWorkflowBagId: null/);
    // Both outcomes are audited with a distinct, understandable reason.
    expect(block).toMatch(/floor\.bag_qr_released_empty/);
    expect(block).toMatch(/floor\.bag_kept_partial/);
  });

  it("operator remaining estimate is stored as a labelled estimate, never as the reconciliation balance", () => {
    expect(actionsSrc).toMatch(/operator_remaining_estimate/);
    expect(actionsSrc).toMatch(/operator_remaining_estimate_source/);
    // The estimate rides the BAG_FINALIZED payload only — it must not be wired
    // into endingBalanceQty / the OUTPUT_DERIVED allocation close.
    expect(actionsSrc).not.toMatch(/endingBalanceQty:\s*partialRemainingEstimate/);
    expect(actionsSrc).not.toMatch(/endingBalanceQty:\s*remainingEstimate/);
  });
});

describe("PRODUCT-SELECTION-AT-SEALING-1 · floor actions", () => {
  it("imports sealing product helpers", () => {
    expect(actionsSrc).toMatch(/from "@\/lib\/production\/sealing-product"/);
    expect(actionsSrc).toMatch(/validateSealingProductPick/);
    expect(actionsSrc).toMatch(/SEALING_STATION_KINDS/);
    expect(actionsSrc).toMatch(/SEALING_SAVE_PRODUCT_FIRST_ERROR/);
  });

  it("saveSealingProductAction persists product before segment work", () => {
    expect(actionsSrc).toMatch(/export async function saveSealingProductAction/);
    expect(actionsSrc).toMatch(/floor\.sealing_product_saved/);
    expect(actionsSrc).toMatch(/source: "SEALING_SELECTION"/);
    expect(actionsSrc).toMatch(/SEALING_PRODUCT_ALREADY_SAVED_ERROR/);
  });

  it("saveSealingProductAction idempotently accepts same product re-save", () => {
    const saveIdx = actionsSrc.indexOf("export async function saveSealingProductAction");
    const fireIdx = actionsSrc.indexOf("export async function fireStageEventAction");
    const block = actionsSrc.slice(saveIdx, fireIdx);
    expect(block).toMatch(/bagProductRow\.productId === parsed\.data\.productId/);
    expect(block).toMatch(/return \{ ok: true \}/);
  });

  it("fireStageEventAction still accepts optional productId for legacy FormData only", () => {
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

  it("scanCardAction blocks fresh start when floor readiness is BLOCKED", () => {
    const scanIdx = actionsSrc.indexOf("export async function scanCardAction");
    const stageIdx = actionsSrc.indexOf("// ── stage events");
    const block = actionsSrc.slice(scanIdx, stageIdx);
    expect(block).toMatch(/evaluateQrCardReadinessById/);
    expect(block).toMatch(/floorReadinessOperatorMessage/);
    expect(block).not.toMatch(/override.*lineage/i);
    expect(block).not.toMatch(/guess/i);
  });

  it("does not emit PRODUCT_MAPPED at scan when first-op returns null product", () => {
    const scanIdx = actionsSrc.indexOf("export async function scanCardAction");
    const stageIdx = actionsSrc.indexOf("// ── stage events");
    const block = actionsSrc.slice(scanIdx, stageIdx);
    expect(block).toMatch(/if \(productIdToSet && productLookup\)/);
  });

  it("saveSealingProductAction emits PRODUCT_MAPPED before segment events", () => {
    const saveIdx = actionsSrc.indexOf("export async function saveSealingProductAction");
    const fireIdx = actionsSrc.indexOf("export async function fireStageEventAction");
    const saveBlock = actionsSrc.slice(saveIdx, fireIdx);
    expect(saveBlock).toMatch(/eventType: "PRODUCT_MAPPED"/);
    expect(saveBlock).toMatch(/source: "SEALING_SELECTION"/);

    const fireIdx2 = actionsSrc.indexOf("export async function fireStageEventAction");
    const pauseIdx = actionsSrc.indexOf("// ── pause / resume");
    const fireBlock = actionsSrc.slice(fireIdx2, pauseIdx);
    expect(fireBlock).not.toMatch(
      /!bagProductRow\?\.productId &&\s*pickedSealingProductId/,
    );
  });

  it("handpack lot lookup runs inside transaction after product map", () => {
    const fireIdx = actionsSrc.indexOf("export async function fireStageEventAction");
    const pauseIdx = actionsSrc.indexOf("// ── pause / resume");
    const block = actionsSrc.slice(fireIdx, pauseIdx);
    expect(block).toMatch(/lookupProductMatchedBlisterCardLot\(\s*workflowBagId,\s*tx/);
  });

  it("rejects routine remapping when product already set", () => {
    expect(actionsSrc).toMatch(/SEALING_PRODUCT_ALREADY_SAVED_ERROR/);
  });

  it("requires saved product before sealing segment or close-out", () => {
    expect(actionsSrc).toMatch(/SEALING_SAVE_PRODUCT_FIRST_ERROR/);
  });

  it("resolves tablet type via shared workflow bag resolver for sealing pick", () => {
    const saveIdx = actionsSrc.indexOf("export async function saveSealingProductAction");
    // Scope to saveSealingProductAction's body only — end at the next exported
    // action (other floor actions legitimately reference bagQrCode).
    const nextIdx = actionsSrc.indexOf(
      "export async function",
      saveIdx + "export async function saveSealingProductAction".length,
    );
    const block = actionsSrc.slice(saveIdx, nextIdx);
    expect(block).toMatch(/resolveWorkflowBagTabletTypeId/);
    expect(block).not.toMatch(/bagQrCode/);
  });
});

describe("SEALING-PRODUCT-PERSIST-1 · projector read model", () => {
  it("PRODUCT_MAPPED updates read_bag_state product columns", () => {
    expect(projectorSrc).toMatch(/ev\.eventType === "PRODUCT_MAPPED"/);
    expect(projectorSrc).toMatch(/productId,/);
    expect(projectorSrc).toMatch(/productName,/);
  });
});

describe("HANDPACK-TABLET-CONTEXT-1 · floor actions", () => {
  it("eventSchema no longer accepts normal-operator tabletTypeId", () => {
    expect(actionsSrc).not.toMatch(/tabletTypeId: z\.string\(\)\.uuid\(\)/);
  });

  it("fireStageEventAction does not read tabletTypeId from FormData", () => {
    const fireIdx = actionsSrc.indexOf("export async function fireStageEventAction");
    const pauseIdx = actionsSrc.indexOf("// ── pause / resume");
    const block = actionsSrc.slice(fireIdx, pauseIdx);
    expect(block).not.toMatch(/formData\.get\("tabletTypeId"\)/);
    expect(block).not.toMatch(/pickedHandpackTabletTypeId/);
  });

  it("HANDPACK_BLISTER_COMPLETE re-resolves received tablet context server-side", () => {
    const fireIdx = actionsSrc.indexOf("export async function fireStageEventAction");
    const pauseIdx = actionsSrc.indexOf("// ── pause / resume");
    const block = actionsSrc.slice(fireIdx, pauseIdx);
    expect(block).toMatch(/resolveWorkflowBagReceivedTabletContext/);
    expect(block).toMatch(/missing received tablet context/);
    expect(block).toMatch(/fix receiving\/admin lineage/);
  });

  it("HANDPACK_BLISTER_COMPLETE payload records resolved lineage, not client-supplied tablet", () => {
    const fireIdx = actionsSrc.indexOf("export async function fireStageEventAction");
    const pauseIdx = actionsSrc.indexOf("// ── pause / resume");
    const block = actionsSrc.slice(fireIdx, pauseIdx);
    expect(block).toMatch(/HANDPACK_BLISTER_COMPLETE.*tablet_type_id/s);
    expect(block).toMatch(/handpackTabletContext\.tabletTypeId/);
    expect(block).toMatch(/tablet_type_source/);
    expect(block).toMatch(/inventory_bag_id/);
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

describe("P3-FLOOR-UX · pause schema rejects roll swap reasons", () => {
  // Roll changes use the dedicated roll workflow; new pauses can no
  // longer select pvc_swap/foil_swap. Historical events are preserved.
  it("pauseSchema reason enum no longer includes foil_swap", () => {
    const enumMatch = actionsSrc.match(/reason: z\.enum\(\[([^\]]+)\]\)/)?.[1] ?? "";
    expect(enumMatch).not.toMatch(/foil_swap/);
  });

  it("pauseSchema reason enum no longer includes pvc_swap", () => {
    const enumMatch = actionsSrc.match(/reason: z\.enum\(\[([^\]]+)\]\)/)?.[1] ?? "";
    expect(enumMatch).not.toMatch(/pvc_swap/);
  });

  it("pauseSchema reason enum still includes shift_end, shift_break, machine_jam, qa_check, other", () => {
    const enumMatch = actionsSrc.match(/reason: z\.enum\(\[([^\]]+)\]\)/)?.[1] ?? "";
    expect(enumMatch).toMatch(/shift_end/);
    expect(enumMatch).toMatch(/shift_break/);
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

describe("OPERATOR-PACKAGING-UUID-CLOSEOUT-1 · packaging complete accountability", () => {
  it("packagingCompleteAction resolves accountability via resolveStationAccountability", () => {
    const idx = actionsSrc.indexOf("export async function packagingCompleteAction");
    expect(idx).toBeGreaterThan(-1);
    const chunk = actionsSrc.slice(idx, idx + 7200);
    expect(chunk).toMatch(/resolveStationAccountability\(tx,/);
    expect(chunk).toMatch(/overrideEmployeeCode: parsed\.data\.operatorCode/);
    expect(chunk).toMatch(
      /accountableEmployeeId: accountability\.accountableEmployeeId/,
    );
  });

  it("packaging complete does not compare employee_id UUID against employee_code text in actions", () => {
    expect(actionsSrc).not.toMatch(/loadActiveEmployeeByCode/);
    expect(actionsSrc).not.toMatch(/employees\.employeeCode.*operatorCode/s);
  });

  it("BLISTER_COMPLETE and SEALING paths still use resolveStationAccountability", () => {
    expect(actionsSrc).toMatch(
      /export async function fireStageEventAction[\s\S]*resolveStationAccountability\(tx,/,
    );
    expect(actionsSrc).toMatch(/overrideEmployeeCode: overrideEmployeeCode/);
  });
});
