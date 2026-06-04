import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const formsSrc = readFileSync(join(__dirname, "forms.tsx"), "utf8");
const listSrc = readFileSync(join(__dirname, "qr-cards-list.tsx"), "utf8");
const actionsSrc = readFileSync(join(__dirname, "actions.ts"), "utf8");
const querySrc = readFileSync(join(__dirname, "../../../lib/db/queries/qr-cards.ts"), "utf8");

describe("QR-CARDS-RETIRE-1 · Retire UI wiring", () => {
  it("RetireButton calls retireQrCardAction with the card id", () => {
    expect(formsSrc).toMatch(/retireQrCardAction\(id\)/);
    expect(formsSrc).toMatch(/from "\.\/actions"/);
  });

  it("refreshes the page after a successful retire", () => {
    expect(formsSrc).toMatch(/useRouter/);
    expect(formsSrc).toMatch(/router\.refresh\(\)/);
  });

  it("shows inline error text on failure", () => {
    expect(formsSrc).toMatch(/setError\(r\.error\)/);
    expect(formsSrc).toMatch(/text-red-700/);
    expect(formsSrc).not.toMatch(/title=\{\s*error/);
  });

  it("list disables retire only for mid-production cards", () => {
    expect(listSrc).toMatch(/isQrCardMidProduction\(card\)/);
    expect(listSrc).not.toMatch(/disabled=\{card\.status === "ASSIGNED"\}/);
  });

  it("server action revalidates /qr-cards", () => {
    expect(actionsSrc).toMatch(/revalidatePath\("\/qr-cards"\)/);
  });
});

describe("QR-ACTIVE-WORKFLOW-CONTEXT-1 · assigned card visibility", () => {
  it("loads active workflow state and received-bag context through workflow_bags.inventory_bag_id", () => {
    expect(querySrc).toMatch(/workflowState/);
    expect(querySrc).toMatch(/readBagState\.stage/);
    expect(querySrc).toMatch(/eq\(inventoryBags\.id,\s*workflowBags\.inventoryBagId\)/);
    expect(querySrc).toMatch(/eq\(qrCards\.scanToken,\s*inventoryBags\.bagQrCode\)/);
    expect(querySrc).toMatch(/poNumber:\s*purchaseOrders\.poNumber/);
    expect(querySrc).toMatch(/tabletTypeName:\s*tabletTypes\.name/);
  });

  it("renders active workflow details instead of only generic copy", () => {
    expect(listSrc).toMatch(/shortWorkflowId/);
    expect(listSrc).toMatch(/workflowState\?\.stage/);
    expect(listSrc).toMatch(/intakeBag\?\.poNumber/);
    expect(listSrc).toMatch(/intakeBag\?\.internalReceiptNumber/);
    expect(listSrc).toMatch(/intakeBag\?\.bagNumber/);
    expect(listSrc).toMatch(/href=\{`\/genealogy\/\$\{bag\.id\}`\}/);
  });
});
