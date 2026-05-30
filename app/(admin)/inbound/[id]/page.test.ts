import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const src = readFileSync(join(__dirname, "page.tsx"), "utf8");
const addBagPageSrc = readFileSync(join(__dirname, "add-bag/page.tsx"), "utf8");
const addBagFormSrc = readFileSync(join(__dirname, "add-bag/add-bag-form.tsx"), "utf8");
const addBagActionsSrc = readFileSync(join(__dirname, "add-bag/actions.ts"), "utf8");
const notesCellSrc = readFileSync(join(__dirname, "bag-notes-cell.tsx"), "utf8");
const querySrc = readFileSync(
  join(process.cwd(), "lib/receive/add-bag.ts"),
  "utf8",
);
const dbQuerySrc = readFileSync(
  join(process.cwd(), "lib/db/queries/receive-add-bag.ts"),
  "utf8",
);

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

describe("RECEIVE-EDIT-2B-1 · receive-level edit entry", () => {
  it("links to the receive edit route from the header", () => {
    expect(src).toMatch(/\/inbound\/\$\{id\}\/edit/);
    expect(src).toMatch(/Edit receive/);
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

describe("RECEIVE-ADD-BAG-1 · add bag to existing receive", () => {
  it("receive detail links to add-bag route for open receives", () => {
    expect(src).toMatch(/\/inbound\/\$\{id\}\/add-bag/);
    expect(src).toMatch(/Add bag/);
  });

  it("hides add action for closed receives with clear copy", () => {
    expect(src).toMatch(/closedAt/);
    expect(src).toMatch(/reopen from Edit receive/i);
  });

  it("add-bag page blocks closed receives", () => {
    expect(addBagPageSrc).toMatch(/closedAt/);
    expect(addBagPageSrc).toMatch(/Reopen it from/);
  });

  it("add-bag form defaults migration reason", () => {
    expect(addBagFormSrc).toMatch(/DEFAULT_ADD_BAG_REASON/);
    expect(querySrc).toMatch(/Historical migration/);
  });

  it("add-bag action calls addBagToReceive on same receive id", () => {
    expect(addBagActionsSrc).toMatch(/addBagToReceive/);
    expect(addBagActionsSrc).toMatch(/revalidatePath\(`\/inbound\/\$\{receiveId\}`\)/);
  });

  it("query writes inventory_bag.add audit without creating new receive", () => {
    expect(dbQuerySrc).toMatch(/action: "inventory_bag.add"/);
    expect(dbQuerySrc).not.toMatch(/insert\(receives\)/);
    expect(dbQuerySrc).toMatch(/insert\(inventoryBags\)/);
    expect(dbQuerySrc).toMatch(/totalBags: sql/);
  });

  it("query blocks closed receives", () => {
    expect(dbQuerySrc).toMatch(/receiveRow\.closedAt/);
  });
});

describe("RECEIVE-ADD-BAG-1 · view bag notes without edit", () => {
  it("detail page uses BagNotesCell instead of truncate-only notes", () => {
    expect(src).toMatch(/BagNotesCell/);
    expect(src).not.toMatch(/max-w-\[120px\] truncate/);
  });

  it("notes cell shows em dash for empty notes", () => {
    expect(notesCellSrc).toMatch(/—/);
  });

  it("notes cell expands long notes with View control", () => {
    expect(notesCellSrc).toMatch(/<details/);
    expect(notesCellSrc).toMatch(/View/);
    expect(notesCellSrc).toMatch(/PREVIEW_LEN/);
  });

  it("edit bag link remains separate from notes view", () => {
    expect(src).toMatch(/Edit bag/);
    expect(src).toMatch(/\/bag\/\$\{bag\.id\}\/edit/);
  });
});
