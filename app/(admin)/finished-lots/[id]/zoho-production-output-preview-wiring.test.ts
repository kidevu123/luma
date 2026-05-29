import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const pageSrc = readFileSync(
  join(root, "app/(admin)/finished-lots/[id]/page.tsx"),
  "utf8",
);
const cardSrc = readFileSync(
  join(root, "app/(admin)/finished-lots/[id]/zoho-production-output-preview-card.tsx"),
  "utf8",
);
const actionSrc = readFileSync(
  join(root, "app/(admin)/finished-lots/[id]/zoho-production-output-preview-actions.ts"),
  "utf8",
);
const clientSrc = readFileSync(
  join(root, "lib/zoho/production-output-preview.ts"),
  "utf8",
);

describe("ZOHO-PRODUCTION-OUTPUT-PREVIEW-FORM-1-CLEAN wiring", () => {
  it("adds an owner/admin-only preview card to the finished lot detail page", () => {
    expect(pageSrc).toContain("ZohoProductionOutputPreviewCard");
    expect(pageSrc).toContain('user.role === "OWNER" || user.role === "ADMIN"');
  });

  it("does not call the preview action during page render", () => {
    expect(pageSrc).not.toContain("previewZohoProductionOutputAction");
    expect(cardSrc).toContain("onSubmit={handleSubmit}");
    expect(cardSrc).toContain("previewZohoProductionOutputAction({");
  });

  it("renders the explicit form fields and preview-only language", () => {
    expect(cardSrc).toContain("Preview only");
    expect(cardSrc).toContain("no Zoho write performed");
    expect(cardSrc).toContain('name="purchaseorder_id"');
    expect(cardSrc).toContain('name="purchaseorder_line_item_id"');
    expect(cardSrc).toContain('name="warehouse_id"');
    expect(cardSrc).toContain("Request summary sent to preview");
    expect(clientSrc).toContain(
      "ZOHO_WAREHOUSE_ID is not configured and no warehouse ID was entered",
    );
  });

  it("does not call or reference the Zoho production-output commit path", () => {
    expect(pageSrc).not.toContain("/commit");
    expect(cardSrc).not.toContain("/commit");
    expect(actionSrc).not.toContain("/commit");
    expect(clientSrc).not.toContain("/commit");
  });

  it("does not render or reference service bearer secrets", () => {
    expect(pageSrc).not.toContain("ZOHO_SERVICE_BEARER_SECRET");
    expect(cardSrc).not.toContain("ZOHO_SERVICE_BEARER_SECRET");
    expect(cardSrc).not.toContain("Bearer ");
    expect(cardSrc).not.toContain("Authorization");
  });
});
