import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const src = readFileSync(join(__dirname, "page.tsx"), "utf8");

describe("RECEIVE-EDIT-AUDIT-1 · receive detail bag edit discoverability", () => {
  it("links each bag row to the bag edit route", () => {
    expect(src).toMatch(/\/inbound\/\$\{r\.receive\.id\}\/bag\/\$\{bag\.id\}\/edit/);
  });

  it("uses Edit bag action label", () => {
    expect(src).toMatch(/Edit bag/);
  });

  it("explains post-save edit capabilities in the bags section", () => {
    expect(src).toMatch(/audit log/i);
    expect(src).toMatch(/edit reason/i);
    expect(src).toMatch(/can only have notes updated/i);
  });

  it("displays weight in kg on the detail table", () => {
    expect(src).toMatch(/Weight \(kg\)/);
    expect(src).toMatch(/weightGrams \/ 1000/);
  });
});

describe("RECEIVE-EDIT-2A-1 · per-bag edit history", () => {
  const panelSrc = readFileSync(join(__dirname, "bag-edit-history-panel.tsx"), "utf8");

  it("page loads audit logs and renders BagEditHistoryPanel", () => {
    expect(src).toMatch(/listAuditLogsForInventoryBags/);
    expect(src).toMatch(/listQrCardBagEditAudits/);
    expect(src).toMatch(/BagEditHistoryPanel/);
    expect(src).toMatch(/groupBagEditHistories/);
  });

  it("page shows per-row edit count column", () => {
    expect(src).toMatch(/<TH>Edits<\/TH>/);
    expect(src).toMatch(/No edits/);
  });

  it("panel uses expandable details for history entries", () => {
    expect(panelSrc).toMatch(/<details/);
    expect(panelSrc).toMatch(/release\/reserve/i);
  });
});
