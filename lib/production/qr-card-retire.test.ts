import { describe, it, expect } from "vitest";
import { isQrCardMidProduction } from "./qr-card-retire";

describe("QR-CARDS-RETIRE-1 · isQrCardMidProduction", () => {
  it("blocks ASSIGNED cards with an active workflow bag", () => {
    expect(
      isQrCardMidProduction({
        status: "ASSIGNED",
        assignedWorkflowBagId: "bag-uuid",
      }),
    ).toBe(true);
  });

  it("allows ASSIGNED intake-reserved cards (no workflow bag yet)", () => {
    expect(
      isQrCardMidProduction({
        status: "ASSIGNED",
        assignedWorkflowBagId: null,
      }),
    ).toBe(false);
  });

  it("allows IDLE and RETIRED cards", () => {
    expect(
      isQrCardMidProduction({ status: "IDLE", assignedWorkflowBagId: null }),
    ).toBe(false);
    expect(
      isQrCardMidProduction({
        status: "RETIRED",
        assignedWorkflowBagId: null,
      }),
    ).toBe(false);
  });
});
