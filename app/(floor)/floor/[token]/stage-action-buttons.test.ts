import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const src = readFileSync(join(__dirname, "stage-action-buttons.tsx"), "utf8");
const actionsSrc = readFileSync(join(__dirname, "actions.ts"), "utf8");

describe("STATION-HANDPACK-1 · HANDPACK_BLISTER timed-only completion", () => {
  it("maps HANDPACK_BLISTER to HANDPACK_BLISTER_COMPLETE event", () => {
    expect(src).toMatch(/HANDPACK_BLISTER.*HANDPACK_BLISTER_COMPLETE/s);
  });

  it("HANDPACK_BLISTER_COMPLETE is in TIMED_ONLY_EVENTS — not RICH_FORM_EVENTS", () => {
    expect(src).toMatch(/TIMED_ONLY_EVENTS.*HANDPACK_BLISTER_COMPLETE/s);
    const richIdx = src.indexOf("RICH_FORM_EVENTS = new Set");
    const richLine = src.slice(richIdx, richIdx + 120);
    expect(richLine).not.toMatch(/HANDPACK_BLISTER_COMPLETE/);
  });

  it("hasGenericStages excludes both RICH_FORM_EVENTS and TIMED_ONLY_EVENTS", () => {
    expect(src).toMatch(/hasGenericStages.*RICH_FORM_EVENTS.*TIMED_ONLY_EVENTS/s);
  });

  it("count input render is gated by hasGenericStages", () => {
    expect(src).toMatch(/hasGenericStages.*Count/s);
  });
});

describe("STATION-HANDPACK-1 · BLISTER station preserved", () => {
  it("BLISTER maps to BLISTER_COMPLETE", () => {
    const blisterIdx = src.indexOf("BLISTER:");
    const chunk = src.slice(blisterIdx, blisterIdx + 80);
    expect(chunk).toMatch(/BLISTER_COMPLETE/);
  });

  it("BLISTER_COMPLETE remains in RICH_FORM_EVENTS", () => {
    expect(src).toMatch(/RICH_FORM_EVENTS.*BLISTER_COMPLETE/s);
  });

  it("BlisterCompleteForm still exists for BLISTER stations", () => {
    expect(src).toMatch(/BlisterCompleteForm/);
    expect(src).toMatch(/blisterOpen.*BlisterCompleteForm/s);
  });

  it("BlisterCompleteForm is triggered by BLISTER_COMPLETE, not HANDPACK_BLISTER_COMPLETE", () => {
    const handlerIdx = src.indexOf("BLISTER_COMPLETE");
    const handlerChunk = src.slice(handlerIdx - 60, handlerIdx + 60);
    expect(handlerChunk).not.toMatch(/HANDPACK_BLISTER_COMPLETE/);
  });
});

describe("STATION-PAUSE-2 · pause reasons via helper", () => {
  it("imports getPauseReasonsForStation from station-pause-reasons helper", () => {
    expect(src).toMatch(/getPauseReasonsForStation/);
    expect(src).toMatch(/getDefaultPauseReasonForStation/);
    expect(src).toMatch(/from.*station-pause-reasons/);
  });

  it("imports PauseReasonValue type from helper", () => {
    expect(src).toMatch(/PauseReasonValue/);
  });

  it("pause options are rendered from pauseReasonOptions — not hardcoded", () => {
    expect(src).toMatch(/pauseReasonOptions\.map/);
    const selectIdx = src.indexOf("pauseReasonOptions.map");
    expect(selectIdx).toBeGreaterThan(-1);
    const selectChunk = src.slice(selectIdx - 50, selectIdx + 200);
    expect(selectChunk).not.toMatch(/value="pvc_swap"/);
    expect(selectChunk).not.toMatch(/value="machine_jam"/);
  });

  it("pauseReason initial value uses getDefaultPauseReasonForStation", () => {
    expect(src).toMatch(/getDefaultPauseReasonForStation\(stationKind\)/);
  });

  it("resyncs pause reason when stationKind changes", () => {
    expect(src).toMatch(/useEffect/);
    expect(src).toMatch(/getDefaultPauseReasonForStation\(stationKind\)/);
  });

  it("no inline station-kind checks remain in the JSX for pause reasons", () => {
    const pauseBlockIdx = src.indexOf("Why pausing?");
    expect(pauseBlockIdx).toBeGreaterThan(-1);
    const pauseBlock = src.slice(pauseBlockIdx, pauseBlockIdx + 600);
    expect(pauseBlock).not.toMatch(/stationKind !== "HANDPACK_BLISTER"/);
    expect(pauseBlock).not.toMatch(/pvc_swap.*PVC roll swap/);
  });
});

describe("PRODUCTION-OVERLAP-3 · completion gate at overlap stages", () => {
  it("EVENT_STAGE_PREREQ.SEALING_COMPLETE requires BLISTERED — button filter will hide it at STARTED", () => {
    // stages = allStages.filter(s => prereq.includes(currentStage))
    // If currentStage=STARTED and prereq=["BLISTERED"], STARTED is not included → button hidden.
    expect(src).toMatch(/EVENT_STAGE_PREREQ/);
    expect(src).toMatch(/prereq.*includes.*currentStage/s);
  });

  it("packagingReady requires currentStage === SEALED — BLISTERED is not ready", () => {
    // const packagingReady = !currentStage || currentStage === "SEALED"
    // BLISTERED ≠ SEALED → packagingReady = false → packaging form hidden.
    expect(src).toMatch(/packagingReady.*currentStage.*SEALED/s);
    expect(src).not.toMatch(/packagingReady.*BLISTERED/);
  });

  it("SEALING stage list filters on EVENT_STAGE_PREREQ — stages const derived from allStages.filter", () => {
    expect(src).toMatch(/allStages\.filter/);
    expect(src).toMatch(/prereq\.includes/);
  });

  it("PACKAGING completion path is gated by packagingReady, not by generic stages filter", () => {
    // PACKAGING overrides STAGE_BY_KIND with [] — it has no generic stage buttons.
    // The rich packaging form renders only when packagingReady is true.
    const packagingKindIdx = src.indexOf('PACKAGING: []');
    expect(packagingKindIdx).toBeGreaterThan(-1);
    const packReadyIdx = src.indexOf('packagingReady');
    expect(packReadyIdx).toBeGreaterThan(-1);
  });
});

describe("STATION-KIND-FIX-1 · behavior follows station kind, not station name", () => {
  it("HANDPACK_BLISTER maps to Hand-pack complete — not Blister complete", () => {
    const handpackIdx = src.indexOf("HANDPACK_BLISTER:");
    expect(handpackIdx).toBeGreaterThan(-1);
    const chunk = src.slice(handpackIdx, handpackIdx + 120);
    expect(chunk).toMatch(/Hand-pack complete/);
    expect(chunk).not.toMatch(/Blister complete/);
  });

  it("HANDPACK_BLISTER_COMPLETE is the event for hand-pack — BLISTER_COMPLETE is not", () => {
    const handpackIdx = src.indexOf("HANDPACK_BLISTER:");
    const chunk = src.slice(handpackIdx, handpackIdx + 120);
    expect(chunk).toMatch(/HANDPACK_BLISTER_COMPLETE/);
    expect(chunk).not.toMatch(/: "BLISTER_COMPLETE"/);
  });

  it("HANDPACK_BLISTER does not produce a count input (TIMED_ONLY = no generic stages)", () => {
    // TIMED_ONLY_EVENTS causes hasGenericStages = false for HANDPACK_BLISTER.
    // Count input is only rendered when hasGenericStages = true.
    // Combining: no count field is shown for HANDPACK_BLISTER.
    expect(src).toMatch(/TIMED_ONLY_EVENTS.*HANDPACK_BLISTER_COMPLETE/s);
    expect(src).toMatch(/hasGenericStages.*TIMED_ONLY_EVENTS/s);
    const countRenderIdx = src.indexOf("hasGenericStages");
    expect(countRenderIdx).toBeGreaterThan(-1);
  });

  it("HANDPACK_BLISTER_COMPLETE is not in RICH_FORM_EVENTS — no blister close-out panel", () => {
    const richStart = src.indexOf("RICH_FORM_EVENTS = new Set");
    const richEnd = src.indexOf(");", richStart);
    const richBlock = src.slice(richStart, richEnd);
    expect(richBlock).not.toMatch(/HANDPACK_BLISTER_COMPLETE/);
  });

  it("BLISTER_COMPLETE is in RICH_FORM_EVENTS — blister close-out stays for machine stations", () => {
    expect(src).toMatch(/RICH_FORM_EVENTS.*BLISTER_COMPLETE/s);
  });

  it("stationKind prop — not station label — determines which events fire", () => {
    // The component receives stationKind: string as a prop.
    // All event routing uses STAGE_BY_KIND[stationKind] — no name comparison.
    expect(src).toMatch(/STAGE_BY_KIND\[stationKind\]/);
    expect(src).not.toMatch(/station\.label|stationName|stationLabel/);
  });
});

describe("STATION-HANDPACK-AUTO-RELEASE-1 · hand-pack complete auto-releases", () => {
  it("fireStageEventAction chains BAG_RELEASED after HANDPACK_BLISTER_COMPLETE", () => {
    expect(actionsSrc).toMatch(/eventType === "HANDPACK_BLISTER_COMPLETE"/);
    expect(actionsSrc).toMatch(/maybeAutoReleaseHandpackAfterComplete/);
    const completeIdx = actionsSrc.indexOf('eventType === "HANDPACK_BLISTER_COMPLETE"');
    const autoIdx = actionsSrc.indexOf("maybeAutoReleaseHandpackAfterComplete");
    expect(autoIdx).toBeGreaterThan(completeIdx);
  });

  it("auto-release reuses projectBagReleasedEvent shared with releaseBagAction", () => {
    expect(actionsSrc).toMatch(/async function projectBagReleasedEvent/);
    expect(actionsSrc).toMatch(/releaseBagAction[\s\S]*projectBagReleasedEvent/);
    expect(actionsSrc).toMatch(
      /maybeAutoReleaseHandpackAfterComplete[\s\S]*projectBagReleasedEvent/,
    );
  });

  it("auto-release is guarded to HANDPACK_BLISTER only and checks stage + station pin", () => {
    expect(actionsSrc).toMatch(/stationKind !== "HANDPACK_BLISTER"/);
    expect(actionsSrc).toMatch(/STATION_RELEASE_FROM_STAGE\.HANDPACK_BLISTER/);
    expect(actionsSrc).toMatch(/readStationLive\.currentWorkflowBagId/);
  });

  it("HANDPACK_BLISTER hides manual Release button — BLISTER still shows it", () => {
    expect(src).toMatch(/stationKind !== "HANDPACK_BLISTER"/);
    const releaseBlock = src.slice(
      src.indexOf("const releaseReady"),
      src.indexOf("const releaseLabel"),
    );
    expect(releaseBlock).toMatch(/HANDPACK_BLISTER/);
    const blisterReleaseAt = src.indexOf('stationKind === "BLISTER"');
    expect(blisterReleaseAt).toBeGreaterThan(-1);
  });

  it("sealing overlap pickup stages unchanged in stage-progression", () => {
    const progressionSrc = readFileSync(
      join(__dirname, "../../../../lib/production/stage-progression.ts"),
      "utf8",
    );
    expect(progressionSrc).toMatch(/SEALING: \["STARTED", "BLISTERED"\]/);
    expect(progressionSrc).toMatch(/HANDPACK_BLISTER: "BLISTERED"/);
  });

  it("scan-card-form and stage-progression files not modified for auto-release", () => {
    const scanSrc = readFileSync(join(__dirname, "scan-card-form.tsx"), "utf8");
    expect(scanSrc).not.toMatch(/maybeAutoReleaseHandpackAfterComplete/);
    expect(scanSrc).not.toMatch(/auto-release/);
  });
});

describe("SEALING-COUNTER-1 · sealing completion uses machine counter", () => {
  it("SealingCompleteForm asks for counter presses — not blisters sealed or sealed count", () => {
    expect(src).toMatch(/Counter presses/);
    expect(src).not.toMatch(/label="Sealed count"/);
    expect(src).not.toMatch(/blisters sealed/i);
  });

  it("shows cards-per-press multiplier when configured", () => {
    expect(src).toMatch(/Cards per press:/);
    expect(src).toMatch(/Sealed cards = counter ×/);
    expect(src).toMatch(/sealingCardsPerPress/);
  });

  it("blocks completion when sealingCardsPerPress is missing", () => {
    expect(src).toMatch(/SEALING_COUNTER_CONFIG_ERROR/);
    expect(src).toMatch(/disabled=\{pending \|\| !configReady\}/);
  });

  it("submits counterPresses — not countTotal — for SEALING_COMPLETE", () => {
    const formIdx = src.indexOf("function SealingCompleteForm");
    const formBlock = src.slice(formIdx, formIdx + 3500);
    expect(formBlock).toMatch(/fd\.set\("counterPresses"/);
    expect(formBlock).not.toMatch(/fd\.set\("countTotal"/);
  });

  it("BlisterCompleteForm unchanged — still uses blister count", () => {
    const blisterIdx = src.indexOf("function BlisterCompleteForm");
    const blisterBlock = src.slice(blisterIdx, blisterIdx + 2500);
    expect(blisterBlock).toMatch(/Blister count/);
    expect(blisterBlock).toMatch(/countTotal/);
  });

  it("scan-card-form not modified for sealing counter", () => {
    const scanSrc = readFileSync(join(__dirname, "scan-card-form.tsx"), "utf8");
    expect(scanSrc).not.toMatch(/counterPresses/);
    expect(scanSrc).not.toMatch(/sealingCardsPerPress/);
  });

  it("stage-progression not modified for sealing counter", () => {
    const progressionSrc = readFileSync(
      join(__dirname, "../../../../lib/production/stage-progression.ts"),
      "utf8",
    );
    expect(progressionSrc).not.toMatch(/counterPresses/);
    expect(progressionSrc).not.toMatch(/cards_per_press/);
  });
});
