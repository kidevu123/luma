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
    // Must NOT appear in the RICH_FORM_EVENTS set
    const richIdx = src.indexOf("RICH_FORM_EVENTS = new Set");
    const richLine = src.slice(richIdx, richIdx + 120);
    expect(richLine).not.toMatch(/HANDPACK_BLISTER_COMPLETE/);
  });

  it("hasGenericStages excludes both RICH_FORM_EVENTS and TIMED_ONLY_EVENTS", () => {
    expect(src).toMatch(/hasGenericStages.*RICH_FORM_EVENTS.*TIMED_ONLY_EVENTS/s);
  });

  it("does not hardcode a blister count or packs-remaining field for HANDPACK_BLISTER", () => {
    // The count input is gated by hasGenericStages — HANDPACK_BLISTER_COMPLETE
    // is in TIMED_ONLY_EVENTS so hasGenericStages is false for that station.
    // Verify that the count input render is gated by hasGenericStages.
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

describe("STATION-HANDPACK-1 · pause reasons station-kind-aware", () => {
  it("PVC roll swap option is gated by station kind — not shown for HANDPACK_BLISTER", () => {
    // Look for the JSX option tag value="pvc_swap"; the conditional guard
    // that excludes HANDPACK_BLISTER must appear within 200 chars before it.
    const optionIdx = src.indexOf('value="pvc_swap"');
    expect(optionIdx).toBeGreaterThan(-1);
    const context = src.slice(optionIdx - 200, optionIdx + 60);
    expect(context).toMatch(/HANDPACK_BLISTER/);
  });

  it("shift_end, machine_jam, qa_check, other remain available for all stations", () => {
    expect(src).toMatch(/shift_end/);
    expect(src).toMatch(/machine_jam/);
    expect(src).toMatch(/qa_check/);
    // other is always present
    const otherMatches = (src.match(/value="other"/g) ?? []).length;
    expect(otherMatches).toBeGreaterThanOrEqual(1);
  });

  it("HANDPACK_BLISTER defaults pause reason to shift_end, not pvc_swap", () => {
    // Initial state is station-kind-aware
    expect(src).toMatch(/HANDPACK_BLISTER.*shift_end/s);
    // Default for non-HANDPACK is pvc_swap — verify pvc_swap appears as the else branch
    expect(src).toMatch(/shift_end.*pvc_swap/s);
  });
});
