// SIMPLIFY-A — one-click release from hold. The transition table is UI policy
// (the server accepts any transition and audits previous_status), so we pin
// the table itself.

import { describe, it, expect } from "vitest";
import { ALLOWED } from "./[id]/lot-transitions";

describe("finished-lot transition table", () => {
  it("ON_HOLD offers a direct Release lot (optional reason) — no two-step clear-then-release", () => {
    const onHold = ALLOWED.ON_HOLD;
    const release = onHold.find((m) => m.next === "RELEASED");
    expect(release).toBeDefined();
    expect(release?.label).toBe("Release lot");
    expect(release?.needsReason ?? false).toBe(false);
    expect(release?.optionalReason).toBe(true);
  });
  it("keeps Clear hold and Recall available from hold", () => {
    expect(ALLOWED.ON_HOLD.some((m) => m.next === "PENDING_QC" && m.label === "Clear hold")).toBe(true);
    expect(ALLOWED.ON_HOLD.some((m) => m.next === "RECALLED")).toBe(true);
  });
  it("PENDING_QC release keeps its existing label", () => {
    expect(ALLOWED.PENDING_QC.some((m) => m.next === "RELEASED" && m.label === "Approve & release")).toBe(true);
  });
});
