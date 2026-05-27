import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const src = readFileSync(join(__dirname, "stage-action-buttons.tsx"), "utf8");

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
