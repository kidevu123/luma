import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const pageSrc = readFileSync(
  join(root, "app/(admin)/finished-lots/[id]/page.tsx"),
  "utf8",
);
const cardSrc = readFileSync(
  join(
    root,
    "app/(admin)/finished-lots/[id]/zoho-production-output-preview-card.tsx",
  ),
  "utf8",
);
const previewActionSrc = readFileSync(
  join(
    root,
    "app/(admin)/finished-lots/[id]/zoho-production-output-preview-actions.ts",
  ),
  "utf8",
);
const gateActionSrc = readFileSync(
  join(
    root,
    "app/(admin)/finished-lots/[id]/zoho-production-output-gate-actions.ts",
  ),
  "utf8",
);
const querySrc = readFileSync(
  join(root, "lib/db/queries/zoho-production-output.ts"),
  "utf8",
);
const clientSrc = readFileSync(
  join(root, "lib/zoho/production-output-preview.ts"),
  "utf8",
);
const approvalSrc = readFileSync(
  join(root, "lib/zoho/production-output-approval.ts"),
  "utf8",
);
const migrationSrc = readFileSync(
  join(root, "drizzle/0052_zoho_production_output_approval.sql"),
  "utf8",
);

describe("ZOHO-PRODUCTION-OUTPUT-SLICE-B wiring", () => {
  it("adds an owner/admin-only preview card to the finished lot detail page", () => {
    expect(pageSrc).toContain("ZohoProductionOutputPreviewCard");
    expect(pageSrc).toContain('user.role === "OWNER" || user.role === "ADMIN"');
    expect(pageSrc).toContain("getActiveZohoProductionOutputOpForLot");
    expect(pageSrc).toContain(
      "persistedPreview={existingProductionOutputPreview}",
    );
  });

  it("does not call preview or gate actions during page render", () => {
    expect(pageSrc).not.toContain("previewZohoProductionOutputAction");
    expect(pageSrc).not.toContain("approveZohoProductionOutputAction");
    expect(pageSrc).not.toContain("queueZohoProductionOutputAction");
    expect(cardSrc).toContain("onSubmit={handleSubmit}");
    expect(cardSrc).toContain("previewZohoProductionOutputAction({");
    expect(cardSrc).toContain("approveZohoProductionOutputAction({");
    expect(cardSrc).toContain("queueZohoProductionOutputAction({");
    expect(cardSrc).toContain("voidZohoProductionOutputAction({");
  });

  it("renders preview-only language and approval/void states", () => {
    expect(cardSrc).toContain("Preview only");
    expect(cardSrc).toContain("no Zoho write performed");
    expect(cardSrc).toContain("Approved for future Zoho commit");
    expect(cardSrc).toContain("Approve for future commit");
    expect(cardSrc).toContain("Future commit readiness");
    expect(cardSrc).toContain("Queue for future Zoho commit");
    expect(cardSrc).toContain("Ready for future commit.");
    expect(cardSrc).toContain("Queued for future Zoho commit");
    expect(cardSrc).toContain("No Zoho write has been performed yet");
    expect(approvalSrc).toContain("Legacy Zoho assembly operations exist for this lot");
    expect(cardSrc).toContain("Void reason");
    expect(cardSrc).toContain('status === "PREVIEWED"');
    expect(cardSrc).toContain('status === "APPROVED"');
    expect(cardSrc).toContain('status !== "VOIDED"');
    expect(cardSrc).toContain('name="purchaseorder_id"');
    expect(clientSrc).toContain(
      "ZOHO_WAREHOUSE_ID is not configured and no warehouse ID was entered",
    );
  });

  it("does not call or reference live commit/apply/send paths", () => {
    for (const src of [
      pageSrc,
      cardSrc,
      previewActionSrc,
      gateActionSrc,
      querySrc,
      clientSrc,
    ]) {
      expect(src).not.toContain("/commit");
      expect(src).not.toMatch(/\/apply['"`]/);
      expect(src).not.toMatch(/\/send['"`]/);
      expect(src).not.toContain("Send to Zoho");
      expect(src).not.toContain("Queue commit to Zoho");
    }
    expect(migrationSrc).toContain("No commit/apply/send");
  });

  it("uses gate actions for approve/queue/void without live-write helpers", () => {
    expect(gateActionSrc).toContain("approveZohoProductionOutputOp");
    expect(gateActionSrc).toContain("queueZohoProductionOutputOpForFutureCommit");
    expect(gateActionSrc).toContain("voidZohoProductionOutputOp");
    expect(gateActionSrc).not.toContain("callProductionOutputPreview");
    expect(querySrc).not.toContain("callProductionOutputPreview");
    expect(previewActionSrc).toContain("getActiveZohoProductionOutputOpForLot");
    expect(previewActionSrc).toContain('status === "APPROVED"');
  });

  it("does not render or reference service bearer secrets", () => {
    expect(pageSrc).not.toContain("ZOHO_SERVICE_BEARER_SECRET");
    expect(cardSrc).not.toContain("ZOHO_SERVICE_BEARER_SECRET");
    expect(cardSrc).not.toContain("Bearer ");
    expect(cardSrc).not.toContain("Authorization");
  });

  it("checks legacy zoho_assembly_ops as a read-only future-commit blocker", () => {
    expect(querySrc).toContain("zohoAssemblyOps");
    expect(querySrc).toContain("legacyAssemblyOpExists");
    expect(approvalSrc).toContain("LEGACY_ASSEMBLY_OP_EXISTS");
    expect(querySrc).not.toContain(".insert(zohoAssemblyOps)");
    expect(querySrc).not.toContain(".update(zohoAssemblyOps)");
    expect(querySrc).not.toContain(".delete(zohoAssemblyOps)");
    expect(gateActionSrc).not.toContain("zoho_assembly_ops");
  });

  it("does not enqueue workers or expose live commit controls in C2", () => {
    expect(cardSrc).not.toContain("Send to Zoho");
    expect(cardSrc).not.toContain("Apply to Zoho");
    expect(cardSrc).not.toContain("Commit to Zoho");
    expect(gateActionSrc).not.toContain("pg-boss");
    expect(gateActionSrc).not.toContain("boss.send");
    expect(querySrc).toContain("queueZohoProductionOutputOpForFutureCommit");
    expect(querySrc).not.toContain("pg-boss");
    expect(cardSrc).toContain('status === "QUEUED"');
    expect(cardSrc).not.toContain("Queue commit to Zoho");
  });
});
