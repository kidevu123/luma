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
