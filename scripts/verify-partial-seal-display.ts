import { extractSubmissionLines } from "../app/(admin)/workflow-submissions/workflow-table-helpers";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    console.error(`[verify-partial-seal-display] FAIL — ${message}`);
    process.exit(1);
  }
}

const historicalPartialPayload = {
  partial_close: true,
  lane_close: false,
  sealed_partial_count: 1656,
  partial_close_reason: "OTHER",
};

const lines = extractSubmissionLines("SEALING_COMPLETE", historicalPartialPayload);
const sealed = lines.find((line) => line.label === "Sealed partial");
const remaining = lines.find((line) => line.label === "Remaining");

assert(sealed?.value === 1656, "sealed_partial_count maps to Sealed partial");
assert(sealed.kind === "partial", "partial seal display is marked partial");
assert(remaining?.value === null, "remaining tablets are not inferred from sealed cards");

console.log("[verify-partial-seal-display] PASS — historical partial seal display fixture OK");
