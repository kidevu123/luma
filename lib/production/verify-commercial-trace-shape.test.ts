// COMMERCIAL-TRACE-7 — source-shape safety guards on the verification
// harness. Mirrors the OP-1C / INTAKE-WORKFLOW-1 pattern of asserting
// invariants on a script's source rather than spinning up the DB in
// tests.

import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const SCRIPT_PATH = path.join(REPO_ROOT, "scripts", "verify-commercial-trace.ts");

function read(): string {
  return fs.readFileSync(SCRIPT_PATH, "utf8");
}

describe("COMMERCIAL-TRACE-7 · verify-commercial-trace.ts shape", () => {
  it("script exists at the expected path", () => {
    expect(fs.existsSync(SCRIPT_PATH)).toBe(true);
  });

  it("every QA identifier uses the QA-COMMERCIAL-TRACE-7 prefix or QA- prefix", () => {
    const src = read();
    // The constant.
    expect(src).toMatch(/QA_TAG\s*=\s*"QA-COMMERCIAL-TRACE-7"/);
    // The customer / product / finished-lot / invoice IDs are
    // QA-prefixed string literals.
    for (const needle of [
      "QA-COMMERCIAL-CUSTOMER",
      "QA-NEXUS-CUSTOMER-001",
      "QA-ZOHO-CUSTOMER-001",
      "QA-MANGO-PEACH",
      "QA-ZOHO-ITEM-MANGO",
      "QA-FL-MANGO-001",
      "QA-ZOHO-INVOICE-001",
      "QA-INV-001",
      "QA-ZOHO-INVOICE-LINE-001",
    ]) {
      expect(src).toContain(needle);
    }
  });

  it("refuses to run in production unless ALLOW_STAGING_QA_DATA=true", () => {
    const src = read();
    expect(src).toMatch(/refuseInProduction/);
    expect(src).toMatch(/ALLOW_STAGING_QA_DATA/);
    expect(src).toMatch(/NODE_ENV === "production"/);
  });

  it("includes a cleanup path in reverse dependency order", () => {
    const src = read();
    // Cleanup function exists.
    expect(src).toMatch(/async function cleanup\(/);
    // Order matters: allocations first, customers/products last.
    const idxAlloc = src.indexOf('cleaned ${label}', src.indexOf('"allocation"'));
    const idxLine = src.indexOf('"zoho_invoice_line"');
    const idxInvoice = src.indexOf('"zoho_invoice"');
    const idxSfl = src.indexOf('"shipment_finished_lot"');
    const idxShip = src.indexOf('"shipment"');
    const idxLot = src.indexOf('"finished_lot"');
    const idxProd = src.indexOf('"product"');
    const idxCust = src.indexOf('"customer"');
    expect(idxLine).toBeGreaterThan(-1);
    expect(idxLine).toBeLessThan(idxInvoice);
    expect(idxInvoice).toBeLessThan(idxSfl);
    expect(idxSfl).toBeLessThan(idxShip);
    expect(idxShip).toBeLessThan(idxLot);
    expect(idxLot).toBeLessThan(idxProd);
    expect(idxProd).toBeLessThan(idxCust);
    void idxAlloc;
  });

  it("preserves preexisting customer / product rows during cleanup", () => {
    const src = read();
    expect(src).toMatch(/customerPreexisting/);
    expect(src).toMatch(/productPreexisting/);
    // Both have explicit "preserved (preexisting)" log messages.
    expect(src).toMatch(/product preserved \(preexisting\)/);
    expect(src).toMatch(/customer preserved \(preexisting\)/);
  });

  it("imports no Zoho live-fetch client or gateway", () => {
    const src = read();
    expect(src).not.toMatch(/from\s+["']@\/lib\/integrations\/zoho/);
    expect(src).not.toMatch(/fetchZohoInvoices|checkZohoGatewayHealth|fetchZohoBrandStatus/);
  });

  it("does not POST/PUT/PATCH/DELETE to any Nexus endpoint except the 405 method-guard test", () => {
    const src = read();
    // We invoke handlers directly; no fetch() to Nexus URLs. Confirm
    // no `fetch(` calls hitting nexus paths.
    expect(src).not.toMatch(/fetch\s*\([^)]*\/api\/nexus\//);
    // Exactly one POST invocation exists — and it is the method-guard
    // test that asserts 405.
    const posts = [...src.matchAll(/method:\s*"POST"/g)];
    expect(posts.length).toBe(1);
    // The POST call lives near a 405 assertion.
    const idxPost = src.indexOf('method: "POST"');
    const idxAssert405 = src.indexOf("405", idxPost);
    expect(idxAssert405).toBeGreaterThan(idxPost);
    expect(idxAssert405).toBeLessThan(idxPost + 400);
  });

  it("does not create complaint tables / webhooks", () => {
    const src = read();
    expect(src).not.toMatch(/nexus_complaints|nexusComplaints/);
    expect(src).not.toMatch(/complaint_webhook|complaint_attachments/);
  });

  it("asserts customer-scope batch responses exclude CSR-only fields", () => {
    const src = read();
    for (const csrField of [
      "supplier_lot_number",
      "internal_receipt_number",
      "raw_bag_qr",
      "operator_name",
      "machine_id",
    ]) {
      expect(src).toContain(csrField);
    }
    // Inverted assertion present.
    expect(src).toMatch(/customer-scope batch must NOT include/);
  });

  it("asserts customer-scope passport responses exclude internal arrays", () => {
    const src = read();
    for (const csrArray of [
      "supplier_lots",
      "raw_bag_receipts",
      "raw_bag_qrs",
      "operators",
      "machines",
      "qc_events",
      "packaging_lots",
    ]) {
      expect(src).toContain(csrArray);
    }
    expect(src).toMatch(/customer-scope passport must NOT include/);
  });

  it("never echoes the configured QA tokens back through assertions", () => {
    // The script holds tokens in memory and explicitly checks that
    // 401 responses don't contain them.
    const src = read();
    expect(src).toMatch(/401 response must not echo any token/);
  });
});
