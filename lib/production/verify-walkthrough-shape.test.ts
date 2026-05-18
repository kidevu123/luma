// VERIFY-WALKTHROUGH-1 — source-shape safety guards on the verification
// harness. Asserts structural invariants on the script source without
// spinning up a DB.

import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const SCRIPT_PATH = path.join(REPO_ROOT, "scripts", "verify-full-walkthrough.ts");

function read(): string {
  return fs.readFileSync(SCRIPT_PATH, "utf8");
}

describe("VERIFY-WALKTHROUGH-1 · verify-full-walkthrough.ts shape", () => {
  it("script exists at the expected path", () => {
    expect(fs.existsSync(SCRIPT_PATH)).toBe(true);
  });

  it("QA_TAG is the walkthrough marker and all fixture identifiers use QA- prefix", () => {
    const src = read();
    expect(src).toMatch(/QA_TAG\s*=\s*"QA-WALKTHROUGH-1"/);
    for (const needle of [
      "QA-WALK-TABLET",
      "QA-WALK-PRODUCT",
      "QA-WALK-PO-001",
      "QA-WALK-1243",
      "QA-WALK-R",
      "BAG-QA-WALK-",
      "QA-WALK-FL-001",
      "QA-WALK-CUST",
      "QA-NEXUS-WALK-001",
      "QA-WALK-INV-001",
    ]) {
      expect(src).toContain(needle);
    }
  });

  it("refuseInProduction guard is wired", () => {
    const src = read();
    expect(src).toContain("refuseInProduction()");
    expect(src).toContain("NODE_ENV");
    expect(src).toContain("ALLOW_STAGING_QA_DATA");
  });

  it("cleanup runs in correct reverse dependency order", () => {
    const src = read();
    // allocation before invoice_line before invoice before sfl before
    // shipment before finished_lot before workflow_bags.
    const allocIdx = src.lastIndexOf('"allocation"');
    const lineIdx = src.lastIndexOf('"invoice_line"');
    const invIdx = src.lastIndexOf('"invoice"');
    const sflIdx = src.lastIndexOf('"sfl"');
    const shipIdx = src.lastIndexOf('"shipment"');
    const flIdx = src.lastIndexOf('"finished_lot"');
    const wfIdx = src.lastIndexOf('"workflow_bags"');
    expect(allocIdx).toBeGreaterThan(0);
    expect(lineIdx).toBeGreaterThan(allocIdx);
    expect(invIdx).toBeGreaterThan(lineIdx);
    expect(sflIdx).toBeGreaterThan(invIdx);
    expect(shipIdx).toBeGreaterThan(sflIdx);
    expect(flIdx).toBeGreaterThan(shipIdx);
    expect(wfIdx).toBeGreaterThan(flIdx);
  });

  it("does not import zoho gateway or Zoho fetch helpers", () => {
    const src = read();
    expect(src).not.toMatch(/@\/lib\/integrations\/zoho\/gateway/);
    expect(src).not.toMatch(/fetchZohoInvoices/);
    expect(src).not.toMatch(/checkZohoGatewayHealth/);
  });

  it("does not make outbound HTTP fetch calls to external services", () => {
    const src = read();
    // No method: POST / PUT / PATCH / DELETE (would imply mutating an external system).
    expect(src).not.toMatch(/method:\s*["'](POST|PUT|PATCH|DELETE)/);
    // No raw fetch() to Nexus endpoints.
    expect(src).not.toMatch(/fetch\([^)]*nexus/i);
  });

  it("customer-scope batch assertion names all five CSR-only fields", () => {
    const src = read();
    for (const field of ["supplier_lot_number", "internal_receipt_number", "raw_bag_qr", "operator_name", "machine_id"]) {
      expect(src).toContain(field);
    }
    expect(src).toContain("CSR-only field");
  });

  it("confirms HIGH confidence is only set after explicit operator confirm, never by engine", () => {
    const src = read();
    // The confirmed allocation insert hard-codes HIGH after the operator confirm step.
    expect(src).toContain('"HIGH"');
    // Suggestion engine path is not present (we use direct insert for the verify).
    expect(src).not.toContain("suggestAllocationsForInvoiceLine");
  });

  it("401 or token security is not relevant (walkthrough uses DB helpers, not HTTP endpoints)", () => {
    // This verify script uses DB helpers directly, not HTTP — no token exposure risk.
    const src = read();
    expect(src).not.toMatch(/Authorization.*Bearer/i);
  });

  it("no complaint tables or Nexus complaint webhook references", () => {
    const src = read();
    expect(src).not.toContain("nexus_complaints");
    expect(src).not.toContain("complaint_webhook");
    expect(src).not.toContain("nexus_rma");
  });

  it("recall passport asserts shipment links (customer delivery traceability)", () => {
    const src = read();
    expect(src).toContain("shipmentLinks.length === 0");
    expect(src).toContain("customer delivery traceability broken");
  });
});
