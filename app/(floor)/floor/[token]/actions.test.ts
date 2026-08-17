import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

// P6 Task 4 — legacy floor actions retired:
//   fireStageEventAction, packagingCompleteAction, lookupCardByTokenAction,
//   finalizeBagAction, releaseSealingHandoffAction, releaseBagAction,
//   setOperatorAction, verifyVendorBarcodeAction
// After the P4a extractions (STAGE-EVENT-EXTRACT-1, PACKAGING-COMPLETE-
// EXTRACT-1, ASSIGN-PRODUCT-EXTRACT-1) these actions were thin forwarders
// to engine modules; P4b's operator screen cut them off completely. The
// scanners that used to assert on the moved bodies now read the engine
// source DIRECTLY instead of splicing it back into actions.ts. The dead
// actions' shells (finalizeBagAction, releaseBagAction, releaseSealing
// HandoffAction, setOperatorAction, verifyVendorBarcodeAction, lookupCard
// ByTokenAction) had no independent semantics worth pinning — the shells'
// disappearance is verified by the deletion itself.
const actionsSrc = readFileSync(
  join(__dirname, "actions.ts"),
  "utf8",
);
const recordStageEventSrc = readFileSync(
  join(__dirname, "../../../../lib/production/engine/record-stage-event.ts"),
  "utf8",
);
const recordPackagingCompleteSrc = readFileSync(
  join(
    __dirname,
    "../../../../lib/production/engine/record-packaging-complete.ts",
  ),
  "utf8",
);
const assignBagProductSrc = readFileSync(
  join(__dirname, "../../../../lib/production/engine/assign-bag-product.ts"),
  "utf8",
);
const projectorSrc = readFileSync(
  join(__dirname, "../../../../lib/projector/index.ts"),
  "utf8",
);

describe("SEALING-COUNTER-1 · sealing counter path (engine)", () => {
  it("imports sealing-counter helpers", () => {
    expect(recordStageEventSrc).toMatch(
      /from "@\/lib\/production\/sealing-counter"/,
    );
    expect(recordStageEventSrc).toMatch(/computeSealedCountFromCounter/);
    expect(recordStageEventSrc).toMatch(/resolveSealingCardsPerPress/);
    expect(recordStageEventSrc).toMatch(/stationUsesSealingCounter/);
  });

  it("SEALING_COMPLETE accepts counterPresses and computes count server-side", () => {
    expect(recordStageEventSrc).toMatch(/counterPresses/);
    expect(recordStageEventSrc).toMatch(/eventType === "SEALING_COMPLETE"/);
    expect(recordStageEventSrc).toMatch(/computeSealedCountFromCounter/);
    expect(recordStageEventSrc).toMatch(/counter_presses/);
    expect(recordStageEventSrc).toMatch(/cards_per_press/);
  });

  it("rejects SEALING_COMPLETE when machine cards-per-press is missing", () => {
    expect(recordStageEventSrc).toMatch(/SEALING_COUNTER_CONFIG_ERROR/);
  });

  it("does not import stage-progression changes", () => {
    expect(recordStageEventSrc).not.toMatch(/EVENT_STAGE_PREREQ\s*=/);
  });
});

describe("SEALING-FLOW-CLARITY-2 · unified hand-pack sealing (engine)", () => {
  it("uses hand-pack material helper after SEALING_COMPLETE", () => {
    expect(recordStageEventSrc).toMatch(
      /from "@\/lib\/production\/handpack-seal-material"/,
    );
    expect(recordStageEventSrc).toMatch(/workflowBagHasHandpackBlisterComplete/);
    expect(recordStageEventSrc).toMatch(/issueHandpackBlisterCardMaterial/);
    expect(recordStageEventSrc).toMatch(/needsHandpackBlisterMaterial/);
  });

  it("sealHandpackBagAction removed", () => {
    expect(actionsSrc).not.toMatch(/export async function sealHandpackBagAction/);
    expect(actionsSrc).not.toMatch(/plasticBlisterCount/);
  });
});

describe("SEALING-COUNTER-UI-2 · server payload unchanged for material path (engine)", () => {
  it("SEALING_COMPLETE still records counter_presses, cards_per_press, count_total", () => {
    expect(recordStageEventSrc).toMatch(/counter_presses/);
    expect(recordStageEventSrc).toMatch(/cards_per_press/);
    expect(recordStageEventSrc).toMatch(/count_total/);
  });

  it("hand-pack BLISTER_CARD issuance still keyed on count_total", () => {
    expect(recordStageEventSrc).toMatch(/issueHandpackBlisterCardMaterial/);
    expect(recordStageEventSrc).toMatch(/needsHandpackBlisterMaterial/);
  });
});

describe("SEALING-MATERIAL-NONBLOCKING-1 · sealing never blocked by blister lot (engine)", () => {
  it("uses product-matched lot lookup — not global oldest", () => {
    expect(recordStageEventSrc).toMatch(/lookupProductMatchedBlisterCardLot/);
    expect(recordStageEventSrc).not.toMatch(
      /findOldestAvailableBlisterCardLot/,
    );
  });

  it("does not return pre-made blister lot error to floor UI", () => {
    expect(recordStageEventSrc).not.toMatch(
      /No available pre-made blister lot found/,
    );
    expect(recordStageEventSrc).not.toMatch(/Receive stock first/);
  });

  it("records skip audit fields when material lot unavailable", () => {
    expect(recordStageEventSrc).toMatch(/handpack_blister_material_skipped/);
    expect(recordStageEventSrc).toMatch(
      /handpack_blister_material_skip_reason/,
    );
  });
});

describe("BLISTER-AUTO-RELEASE-1 · blister complete auto-releases (engine)", () => {
  it("chains maybeAutoReleaseAfterComplete after BLISTER_COMPLETE on BLISTER stations", () => {
    expect(recordStageEventSrc).toMatch(
      /eventType === "BLISTER_COMPLETE" && station\.kind === "BLISTER"/,
    );
    expect(recordStageEventSrc).toMatch(/maybeAutoReleaseAfterComplete/);
    const blisterIdx = recordStageEventSrc.indexOf(
      'eventType === "BLISTER_COMPLETE" && station.kind === "BLISTER"',
    );
    const autoIdx = recordStageEventSrc.indexOf(
      "await maybeAutoReleaseAfterComplete",
    );
    expect(autoIdx).toBeGreaterThan(blisterIdx);
  });

  it("does not auto-release on COMBINED BLISTER_COMPLETE", () => {
    expect(recordStageEventSrc).toMatch(
      /eventType === "BLISTER_COMPLETE" && station\.kind === "BLISTER"/,
    );
    expect(recordStageEventSrc).not.toMatch(
      /eventType === "BLISTER_COMPLETE" && station\.kind === "COMBINED"/,
    );
  });

  it("BLISTER is in AUTO_RELEASE_AFTER_COMPLETE_STATION_KINDS with BLISTERED release stage", () => {
    expect(recordStageEventSrc).toMatch(
      /AUTO_RELEASE_AFTER_COMPLETE_STATION_KINDS[\s\S]*"BLISTER"/,
    );
    const helperIdx = recordStageEventSrc.indexOf(
      "function maybeAutoReleaseAfterComplete",
    );
    const helperBlock = recordStageEventSrc.slice(helperIdx, helperIdx + 1200);
    expect(helperBlock).toMatch(/STATION_RELEASE_FROM_STAGE\[args\.stationKind\]/);
    expect(helperBlock).toMatch(/-auto-release/);
  });

  it("BLISTER_COMPLETE payload still records count_total", () => {
    expect(recordStageEventSrc).toMatch(/count_total/);
    expect(recordStageEventSrc).not.toMatch(
      /BLISTER_COMPLETE[\s\S]{0,200}packs_remaining/s,
    );
  });

  it("first-op count guard unchanged for BLISTER_COMPLETE", () => {
    expect(recordStageEventSrc).toMatch(
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
    // resumeBagAction is the last exported action in the file — scope to
    // its body by pinning to the next non-action anchor (there is none),
    // so we scan the tail from resumeBagAction to end-of-file.
    const resumeIdx = actionsSrc.indexOf(
      "export async function resumeBagAction",
    );
    const block = actionsSrc.slice(
      resumeIdx,
      resumeIdx +
        actionsSrc.slice(resumeIdx).indexOf("\n}\n") +
        3,
    );
    expect(block).toMatch(/eventType: "BAG_RESUMED"/);
    expect(block).not.toMatch(/recordBlisterCounterRollSegment/);
    expect(block).not.toMatch(/counterSnapshotCount/);
  });
});

describe("COUNTER-SNAPSHOT-GUARD-1 · server-side counter guards", () => {
  it("pause and blister close-out call assertCounterSnapshotAllowed before segments", () => {
    // pause path lives in actions.ts (pauseBagAction); blister close-out lives
    // in the engine (record-stage-event.ts).
    expect(actionsSrc).toMatch(/assertCounterSnapshotAllowed/);
    expect(actionsSrc).toMatch(/"pause_shift_end"/);
    expect(actionsSrc).toMatch(/"pause_machine_jam"/);
    expect(recordStageEventSrc).toMatch(/"blister_close_out"/);
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

describe("SEALING-AUTO-RELEASE-1 · sealing complete auto-releases (engine)", () => {
  it("chains maybeAutoReleaseAfterComplete after final SEALING on SEALING stations", () => {
    expect(recordStageEventSrc).toMatch(
      /isSealingFinal && station\.kind === "SEALING"/,
    );
    expect(recordStageEventSrc).toMatch(/maybeAutoReleaseAfterComplete/);
  });

  it("does not auto-release on COMBINED SEALING_COMPLETE", () => {
    // Anchor on the OR-clause list up to its closing "?) {" then require the
    // auto-release call within a tight window of that brace, so it must be
    // the block's first statement regardless of how many OR-clauses precede.
    const match = recordStageEventSrc.match(
      /\(isSealingFinal && station\.kind === "SEALING"\)[\s\S]*?\)\s*\{\s{0,20}await maybeAutoReleaseAfterComplete/,
    );
    expect(match?.[0]).toBeTruthy();
  });
});

describe("MULTI-SEALING-SAME-BAG-1 · segment vs final sealing (engine)", () => {
  // P6 Task 4 — releaseSealingHandoffAction retired; its stage/segment
  // guard checks moved into the engine's auto-release/segment logic. Kept
  // scanners target the engine's segment-vs-final gating directly.
  it("allows SEALING_SEGMENT_COMPLETE on SEALING stations", () => {
    expect(recordStageEventSrc).toMatch(
      /SEALING: \["SEALING_SEGMENT_COMPLETE", "SEALING_COMPLETE"\]/,
    );
    expect(recordStageEventSrc).toMatch(/"SEALING_SEGMENT_COMPLETE"/);
  });

  it("final SEALING_COMPLETE on pure sealing requires prior segment", () => {
    expect(recordStageEventSrc).toMatch(
      /Record at least one sealing segment before marking sealing complete/,
    );
    expect(recordStageEventSrc).toMatch(/lane_close: true/);
  });

  it("partial SEALING_COMPLETE validates reason and segment totals", () => {
    expect(recordStageEventSrc).toMatch(/sealingCloseMode/);
    expect(recordStageEventSrc).toMatch(/validateSealingPartialCloseInput/);
    expect(recordStageEventSrc).toMatch(/buildPartialSealingClosePayload/);
    expect(recordStageEventSrc).toMatch(/maybeAutoReleaseAfterPartialSealingClose/);
  });

  it("partial SEALING_COMPLETE skips counter presses on pure sealing station", () => {
    expect(recordStageEventSrc).toMatch(/sealingFinalOnPureStation/);
    expect(recordStageEventSrc).toMatch(
      /if \(sealingUsesCounter && !sealingFinalOnPureStation\)/,
    );
    expect(recordStageEventSrc).toMatch(
      /sealingUsesCounter && !sealingFinalOnPureStation[\s\S]*buildPartialSealingClosePayload/,
    );
    expect(recordStageEventSrc).not.toMatch(
      /isPartialSealingClose[\s\S]{0,120}SEALING_COUNTER_PRESS_ERROR/,
    );
  });

  it("partial close with no segments returns segment error not counter error", () => {
    const partialValNeedle =
      "const partialValidation = validateSealingPartialCloseInput";
    const counterNeedle = "return { error: SEALING_COUNTER_PRESS_ERROR };";
    expect(recordStageEventSrc.split(partialValNeedle).length - 1).toBe(1);
    expect(recordStageEventSrc.split(counterNeedle).length - 1).toBe(1);
    const partialValIdx = recordStageEventSrc.indexOf(partialValNeedle);
    const counterIdx = recordStageEventSrc.indexOf(counterNeedle);
    expect(partialValIdx).toBeGreaterThan(-1);
    expect(counterIdx).toBeGreaterThan(partialValIdx);
  });

  it("packaging complete allows BLISTERED when partial sealing close-out exists", () => {
    expect(recordPackagingCompleteSrc).toMatch(/packagingPartialSealedReady/);
    expect(recordPackagingCompleteSrc).toMatch(/allowsPackagingCompleteAtBlistered/);
  });

  it("handpack material runs on segment not final close-only", () => {
    expect(recordStageEventSrc).toMatch(
      /isSealingSegment \|\|\s*\(isSealingFinal && !isPureSealingStation\)/,
    );
  });
});

describe("PACKAGING-AUTO-FINALIZE-1 · packaging close-out auto-finalizes (engine)", () => {
  it("chains maybeAutoFinalizeAfterPackagingComplete after PACKAGING_COMPLETE on PACKAGING stations", () => {
    expect(recordPackagingCompleteSrc).toMatch(/station\.kind === "PACKAGING"/);
    expect(recordPackagingCompleteSrc).toMatch(
      /maybeAutoFinalizeAfterPackagingComplete/,
    );
    expect(recordPackagingCompleteSrc).toMatch(
      /autoCreateAndReleaseFinishedLotForWorkflowBag/,
    );
    expect(recordPackagingCompleteSrc).toMatch(/runFinishedLotPostCommitEffects/);
    expect(recordPackagingCompleteSrc).toMatch(/emitCountBasedPackagingConsumption/);
  });

  it("exports projectBagFinalizedEvent for shared use", () => {
    expect(recordPackagingCompleteSrc).toMatch(/function projectBagFinalizedEvent/);
    expect(recordPackagingCompleteSrc).toMatch(
      /projectBagFinalizedEvent[\s\S]*BAG_FINALIZED/,
    );
  });

  it("auto-finalize is idempotent with -auto-finalize clientEventId suffix", () => {
    expect(recordPackagingCompleteSrc).toMatch(/-auto-finalize/);
    expect(recordPackagingCompleteSrc).toMatch(
      /AUTO_FINALIZE_AFTER_PACKAGING_COMPLETE_STATION_KINDS/,
    );
  });

  it("does not auto-finalize on COMBINED PACKAGING_COMPLETE", () => {
    expect(recordPackagingCompleteSrc).toMatch(
      /if \(station\.kind === "PACKAGING" && !emitPartialPackaging\)/,
    );
    expect(recordPackagingCompleteSrc).not.toMatch(
      /COMBINED[\s\S]{0,40}maybeAutoFinalizeAfterPackagingComplete/,
    );
  });

  it("only auto-creates and releases finished lots after successful full packaging auto-finalize", () => {
    expect(recordPackagingCompleteSrc).toMatch(
      /if \(station\.kind === "PACKAGING" && !emitPartialPackaging\)/,
    );
    expect(recordPackagingCompleteSrc).toMatch(
      /const didFinalize = await maybeAutoFinalizeAfterPackagingComplete/,
    );
    expect(recordPackagingCompleteSrc).toMatch(
      /if \(didFinalize\)[\s\S]*autoCreateAndReleaseFinishedLotForWorkflowBag/,
    );
    expect(recordPackagingCompleteSrc).not.toMatch(
      /emitPartialPackaging[\s\S]{0,120}autoCreateAndReleaseFinishedLotForWorkflowBag/,
    );
  });

  it("audits auto finished lot exceptions without rolling back packaging completion", () => {
    expect(recordPackagingCompleteSrc).toMatch(/finished_lot\.auto_create_blocked/);
    expect(recordPackagingCompleteSrc).toMatch(/targetType: "WorkflowBag"/);
    expect(recordPackagingCompleteSrc).toMatch(/reason: autoLot\.reason/);
  });

  it("auto-finalize guards on PACKAGED stage, not finalized, and station pin", () => {
    const helperIdx = recordPackagingCompleteSrc.indexOf(
      "function maybeAutoFinalizeAfterPackagingComplete",
    );
    const helperBlock = recordPackagingCompleteSrc.slice(
      helperIdx,
      helperIdx + 1800,
    );
    expect(helperBlock).toMatch(/stage !== "PACKAGED"/);
    expect(helperBlock).toMatch(/isFinalized/);
    expect(helperBlock).toMatch(/currentWorkflowBagId/);
    expect(helperBlock).toMatch(/Promise<boolean>/);
    expect(helperBlock).toMatch(/return true/);
  });

  it("packaging payload keys unchanged", () => {
    expect(recordPackagingCompleteSrc).toMatch(/master_cases/);
    expect(recordPackagingCompleteSrc).toMatch(/displays_made/);
    expect(recordPackagingCompleteSrc).toMatch(/loose_cards/);
    expect(recordPackagingCompleteSrc).toMatch(/damaged_packaging/);
    expect(recordPackagingCompleteSrc).toMatch(/ripped_cards/);
    expect(recordPackagingCompleteSrc).toMatch(
      /buildPartialPackagingCompletePayload/,
    );
    expect(recordPackagingCompleteSrc).toMatch(
      /shouldEmitPartialPackagingComplete/,
    );
  });
});

describe("P2-PARTIAL-KEEP · QR is never dropped for a partial bottle bag (engine)", () => {
  // P6 Task 4 — finalizeBagAction retired; its keep-partial + defer logic
  // was already delegated to the engine's projectBagFinalizedEvent /
  // resolveDeferredQrReleaseAfterPackaging (record-packaging-complete.ts).
  // The remaining scanners target the engine module directly.
  it("projector releases the QR through the intent-aware guard, not the raw session rule", () => {
    expect(projectorSrc).toMatch(/shouldReleaseQrAtFinalizationWithIntent/);
    expect(projectorSrc).not.toMatch(
      /if \(shouldReleaseQrAtFinalization\(wfSession/,
    );
  });

  it("packaging keep-partial + defer is scoped to bottle products only", () => {
    expect(recordPackagingCompleteSrc).toMatch(
      /const isBottleBag = productRow\?\.kind === "BOTTLE"/,
    );
    expect(recordPackagingCompleteSrc).toMatch(/deferQrRelease: isBottleBag/);
    expect(recordPackagingCompleteSrc).toMatch(
      /keepPartial: keepBagPartial && isBottleBag/,
    );
    expect(recordPackagingCompleteSrc).toMatch(
      /if \(isBottleBag\)[\s\S]*resolveDeferredQrReleaseAfterPackaging/,
    );
  });

  it("deferred release only drops the QR when the bag is confirmed empty", () => {
    const i = recordPackagingCompleteSrc.indexOf(
      "function resolveDeferredQrReleaseAfterPackaging",
    );
    const block = recordPackagingCompleteSrc.slice(i, i + 2400);
    expect(block).toMatch(/shouldReleaseQrAfterPackagingClose/);
    expect(block).toMatch(/status: "IDLE", assignedWorkflowBagId: null/);
    expect(block).toMatch(/floor\.bag_qr_released_empty/);
    expect(block).toMatch(/floor\.bag_kept_partial/);
  });

  it("operator remaining estimate is stored as a labelled estimate, never as the reconciliation balance", () => {
    expect(recordPackagingCompleteSrc).toMatch(/operator_remaining_estimate/);
    expect(recordPackagingCompleteSrc).toMatch(
      /operator_remaining_estimate_source/,
    );
    expect(recordPackagingCompleteSrc).not.toMatch(
      /endingBalanceQty:\s*partialRemainingEstimate/,
    );
    expect(recordPackagingCompleteSrc).not.toMatch(
      /endingBalanceQty:\s*remainingEstimate/,
    );
  });
});

describe("PRODUCT-SELECTION-AT-SEALING-1 · floor actions", () => {
  it("imports sealing product helpers", () => {
    // assign-bag-product owns the save-first path;
    // record-stage-event owns the SEALING_SAVE_PRODUCT_FIRST_ERROR gate.
    expect(assignBagProductSrc).toMatch(
      /from "@\/lib\/production\/sealing-product"/,
    );
    expect(assignBagProductSrc).toMatch(/validateSealingProductPick/);
    expect(assignBagProductSrc).toMatch(/SEALING_STATION_KINDS/);
    expect(recordStageEventSrc).toMatch(/SEALING_SAVE_PRODUCT_FIRST_ERROR/);
  });

  it("saveSealingProductAction persists product before segment work", () => {
    expect(actionsSrc).toMatch(/export async function saveSealingProductAction/);
    expect(assignBagProductSrc).toMatch(/floor\.sealing_product_saved/);
    expect(assignBagProductSrc).toMatch(/source: "SEALING_SELECTION"/);
    expect(assignBagProductSrc).toMatch(/SEALING_PRODUCT_ALREADY_SAVED_ERROR/);
  });

  it("saveSealingProductAction idempotently accepts same product re-save", () => {
    // ASSIGN-PRODUCT-EXTRACT-1: the picked product is read off the input
    // type in the engine module (`productId`) while the action forwards
    // `parsed.data.productId`. Both halves pinned.
    expect(actionsSrc).toMatch(/productId: parsed\.data\.productId/);
    expect(assignBagProductSrc).toMatch(/bagProductRow\.productId === productId/);
    expect(assignBagProductSrc).toMatch(/return \{ ok: true \}/);
  });

  it("scanCardAction links inventory bag from QR scan token at first-op start", () => {
    const scanIdx = actionsSrc.indexOf("export async function scanCardAction");
    const nextExportIdx = actionsSrc.indexOf(
      "export async function",
      scanIdx + "export async function scanCardAction".length,
    );
    const block = actionsSrc.slice(scanIdx, nextExportIdx);
    expect(block).toMatch(/lookupInventoryBagByQrScanToken/);
    expect(block).toMatch(/inventoryBagId: inventoryLink\.inventoryBagId/);
    expect(block).toMatch(/inventory_bag_id: inventoryLink\.inventoryBagId/);
    expect(block).toMatch(/tablet_type_id: inventoryLink\.tabletTypeId/);
  });

  it("scanCardAction blocks fresh start when floor readiness is BLOCKED", () => {
    const scanIdx = actionsSrc.indexOf("export async function scanCardAction");
    const nextExportIdx = actionsSrc.indexOf(
      "export async function",
      scanIdx + "export async function scanCardAction".length,
    );
    const block = actionsSrc.slice(scanIdx, nextExportIdx);
    expect(block).toMatch(/evaluateQrCardReadinessById/);
    expect(block).toMatch(/floorReadinessOperatorMessage/);
    expect(block).not.toMatch(/override.*lineage/i);
    expect(block).not.toMatch(/guess/i);
  });

  it("does not emit PRODUCT_MAPPED at scan when first-op returns null product", () => {
    const scanIdx = actionsSrc.indexOf("export async function scanCardAction");
    const nextExportIdx = actionsSrc.indexOf(
      "export async function",
      scanIdx + "export async function scanCardAction".length,
    );
    const block = actionsSrc.slice(scanIdx, nextExportIdx);
    expect(block).toMatch(/if \(productIdToSet && productLookup\)/);
  });

  it("saveSealingProductAction emits PRODUCT_MAPPED and stage-event body no longer double-saves", () => {
    expect(assignBagProductSrc).toMatch(/eventType: "PRODUCT_MAPPED"/);
    expect(assignBagProductSrc).toMatch(/source: "SEALING_SELECTION"/);
    // The engine's stage-event body must NOT also save the picked product on SEALING_COMPLETE.
    expect(recordStageEventSrc).not.toMatch(
      /!bagProductRow\?\.productId &&\s*pickedSealingProductId/,
    );
  });

  it("handpack lot lookup runs inside transaction after product map", () => {
    expect(recordStageEventSrc).toMatch(
      /lookupProductMatchedBlisterCardLot\(\s*workflowBagId,\s*tx/,
    );
  });

  it("rejects routine remapping when product already set", () => {
    expect(assignBagProductSrc).toMatch(/SEALING_PRODUCT_ALREADY_SAVED_ERROR/);
  });

  it("requires saved product before sealing segment or close-out", () => {
    expect(recordStageEventSrc).toMatch(/SEALING_SAVE_PRODUCT_FIRST_ERROR/);
  });

  it("resolves tablet type via shared workflow bag resolver for sealing pick", () => {
    expect(assignBagProductSrc).toMatch(/resolveWorkflowBagTabletTypeId/);
    expect(assignBagProductSrc).not.toMatch(/bagQrCode/);
  });
});

describe("SEALING-PRODUCT-PERSIST-1 · projector read model", () => {
  it("PRODUCT_MAPPED updates read_bag_state product columns", () => {
    expect(projectorSrc).toMatch(/ev\.eventType === "PRODUCT_MAPPED"/);
    expect(projectorSrc).toMatch(/productId,/);
    expect(projectorSrc).toMatch(/productName,/);
  });
});

describe("HANDPACK-TABLET-CONTEXT-1 · engine actions", () => {
  it("stage-event body no longer accepts normal-operator tabletTypeId", () => {
    expect(recordStageEventSrc).not.toMatch(/tabletTypeId: z\.string\(\)\.uuid\(\)/);
  });

  it("stage-event body does not read tabletTypeId from FormData", () => {
    expect(recordStageEventSrc).not.toMatch(/formData\.get\("tabletTypeId"\)/);
    expect(recordStageEventSrc).not.toMatch(/pickedHandpackTabletTypeId/);
  });

  it("HANDPACK_BLISTER_COMPLETE re-resolves received tablet context server-side", () => {
    expect(recordStageEventSrc).toMatch(/resolveWorkflowBagReceivedTabletContext/);
    expect(recordStageEventSrc).toMatch(/missing received tablet context/);
    expect(recordStageEventSrc).toMatch(/fix receiving\/admin lineage/);
  });

  it("HANDPACK_BLISTER_COMPLETE payload records resolved lineage, not client-supplied tablet", () => {
    expect(recordStageEventSrc).toMatch(/HANDPACK_BLISTER_COMPLETE.*tablet_type_id/s);
    expect(recordStageEventSrc).toMatch(/handpackTabletContext\.tabletTypeId/);
    expect(recordStageEventSrc).toMatch(/tablet_type_source/);
    expect(recordStageEventSrc).toMatch(/inventory_bag_id/);
  });

  it("product selection still happens at sealing, not hand-pack", () => {
    // PRODUCT_MAPPED is only emitted for SEALING_COMPLETE (assign-bag-product /
    // record-stage-event), not HANDPACK_BLISTER_COMPLETE.
    expect(recordStageEventSrc).toMatch(
      /eventType === "SEALING_COMPLETE".*pickedSealingProductId/s,
    );
    expect(recordStageEventSrc).not.toMatch(
      /HANDPACK_BLISTER_COMPLETE.*product_id/s,
    );
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

describe("OPERATOR-SHIFT-SUBMIT-BLOCK-1 · first-op count guard (engine)", () => {
  it("FIRST_OP_COUNT_EVENTS includes BLISTER_COMPLETE and BOTTLE_HANDPACK_COMPLETE only", () => {
    const setMatch =
      recordStageEventSrc.match(
        /const FIRST_OP_COUNT_EVENTS[^=]*=\s*new Set\(\[([\s\S]*?)\]\)/,
      )?.[1] ?? "";
    expect(setMatch).toMatch(/"BLISTER_COMPLETE"/);
    expect(setMatch).toMatch(/"BOTTLE_HANDPACK_COMPLETE"/);
    expect(setMatch).not.toMatch(/"SEALING_COMPLETE"/);
    expect(setMatch).not.toMatch(/"HANDPACK_BLISTER_COMPLETE"/);
  });

  it("refuses first-op count when accountableEmployeeId is null", () => {
    expect(recordStageEventSrc).toMatch(
      /FIRST_OP_COUNT_EVENTS\.has\(eventType\) &&\s*!accountability\.accountableEmployeeId/,
    );
    expect(recordStageEventSrc).toMatch(
      /No operator on shift\. Open a shift on this station before submitting the first count/,
    );
  });

  it("does not weaken guard for LEGACY_TEXT sessions", () => {
    expect(recordStageEventSrc).not.toMatch(/LEGACY_TEXT.*accountableEmployeeId/s);
  });
});

describe("OPERATOR-PACKAGING-UUID-CLOSEOUT-1 · packaging complete accountability (engine)", () => {
  it("engine packaging body resolves accountability via resolveStationAccountability", () => {
    expect(recordPackagingCompleteSrc).toMatch(/resolveStationAccountability\(tx,/);
    // PACKAGING-COMPLETE-EXTRACT-1: the override is read off the input type
    // (`operatorCode`) inside the moved body.
    expect(recordPackagingCompleteSrc).toMatch(/overrideEmployeeCode: operatorCode/);
    expect(recordPackagingCompleteSrc).toMatch(
      /accountableEmployeeId: accountability\.accountableEmployeeId/,
    );
  });

  it("packaging complete does not compare employee_id UUID against employee_code text", () => {
    expect(recordPackagingCompleteSrc).not.toMatch(/loadActiveEmployeeByCode/);
    expect(recordPackagingCompleteSrc).not.toMatch(
      /employees\.employeeCode.*operatorCode/s,
    );
  });

  it("BLISTER and SEALING paths in the stage-event engine still use resolveStationAccountability", () => {
    expect(recordStageEventSrc).toMatch(/resolveStationAccountability\(tx,/);
    expect(recordStageEventSrc).toMatch(/overrideEmployeeCode: overrideEmployeeCode/);
  });
});
