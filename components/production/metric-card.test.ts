// Phase D — UI honesty contract tests.
//
// These don't render React (no jsdom in the suite); they assert
// that the renderer's input contract matches what the metric API
// returns, so a future regression that drops a label or skips
// the missing-state branch fails fast.

import { describe, it, expect } from "vitest";
import { ok, missing, zero, estimated } from "@/lib/production/confidence";

describe("UI honesty contract — MetricResult shape", () => {
  it("MISSING metric carries label and missingInputs[]", () => {
    const m = missing("%", ["station_standards"], "Insufficient data for OEE");
    expect(m.confidence).toBe("MISSING");
    expect(m.label).toBe("Insufficient data for OEE");
    expect(m.missingInputs).toContain("station_standards");
    expect(m.value).toBe(null);
  });

  it("zero metric is HIGH confidence with value 0 — not MISSING", () => {
    const m = zero("bags", "No activity captured for this route in window.");
    expect(m.confidence).toBe("HIGH");
    expect(m.value).toBe(0);
  });

  it("OEE missing standards must label exactly 'Insufficient data for OEE'", () => {
    const m = missing(
      "%",
      ["production_calendars", "station_standards"],
      "Insufficient data for OEE",
    );
    expect(m.label).toBe("Insufficient data for OEE");
  });

  it("on-time missing due target must label exactly 'No target configured'", () => {
    const m = missing("%", ["due_targets"], "No target configured");
    expect(m.label).toBe("No target configured");
  });

  it("labor cost missing rate must label exactly 'No labor rate configured'", () => {
    const m = missing(
      "USD/case",
      ["labor_rates"],
      "No labor rate configured",
    );
    expect(m.label).toBe("No labor rate configured");
  });

  it("quality missing reject data must label exactly 'No reject data'", () => {
    const m = missing("%", ["reject_data"], "No reject data");
    expect(m.label).toBe("No reject data");
  });

  it("estimated material recon row carries LOW confidence + missingInputs", () => {
    const m = estimated(150, "tablets", {
      missingInputs: ["scrap", "remaining"],
      explanation: "Estimated; missing scrap, remaining.",
    });
    expect(m.confidence).toBe("LOW");
    expect(m.missingInputs).toEqual(["scrap", "remaining"]);
  });

  it("ok metric never carries a label override", () => {
    const m = ok(42, "bags");
    expect(m.label).toBeUndefined();
    expect(m.confidence).toBe("HIGH");
  });
});
