import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const pageSrc = readFileSync(join(__dirname, "page.tsx"), "utf8");
const tableSrc = readFileSync(join(__dirname, "workflow-table.tsx"), "utf8");
const helpersSrc = readFileSync(join(__dirname, "workflow-table-helpers.ts"), "utf8");
const inputSrc = readFileSync(join(__dirname, "../../../components/ui/input.tsx"), "utf8");

describe("WORKFLOW-DATA-VISIBILITY-1 · workflow submissions page", () => {
  it("requires session before querying bags", () => {
    expect(pageSrc).toMatch(/requireSession/);
  });

  it("joins read models and serializes rows for the client table", () => {
    expect(pageSrc).toMatch(/readBagState/);
    expect(pageSrc).toMatch(/readBagMetrics/);
    expect(pageSrc).toMatch(/WorkflowTable/);
    expect(pageSrc).toMatch(/toISOString\(\)/);
    expect(pageSrc).toMatch(/coerceEventCount/);
  });

  it("renders empty state when no bags match filters", () => {
    expect(pageSrc).toMatch(/EmptyState/);
    expect(pageSrc).toMatch(/bags\.length === 0/);
  });

  it("client table uses RSC-safe datetime formatters", () => {
    expect(tableSrc).toMatch(/formatWorkflowDatetime/);
    expect(tableSrc).toMatch(/formatWorkflowTimestamp/);
    expect(helpersSrc).toMatch(/Date \| string/);
  });

  it("filter form Input is a client component (onWheel handler)", () => {
    expect(inputSrc).toMatch(/^"use client"/);
    expect(pageSrc).toMatch(/<Input[^>]+type="search"/);
  });
});

describe("WORKFLOW-RECEIPT-DISPLAY-P1 · receipt lineage display", () => {
  it("joins workflow bags to received inventory bags", () => {
    expect(pageSrc).toMatch(/inventoryBags/);
    expect(pageSrc).toMatch(/leftJoin\(inventoryBags,\s*eq\(inventoryBags\.id,\s*workflowBags\.inventoryBagId\)\)/);
  });

  it("loads canonical bag identity context from received-bag lineage", () => {
    expect(pageSrc).toMatch(/tabletTypes/);
    expect(pageSrc).toMatch(/smallBoxes/);
    expect(pageSrc).toMatch(/receives/);
    expect(pageSrc).toMatch(/purchaseOrders/);
    expect(pageSrc).toMatch(/inventoryBagNumber:\s*inventoryBags\.bagNumber/);
    expect(pageSrc).toMatch(/tabletTypeName:\s*tabletTypes\.name/);
    expect(pageSrc).toMatch(/poNumber:\s*purchaseOrders\.poNumber/);
  });

  it("uses inventory_bags.internal_receipt_number as the canonical receipt display", () => {
    expect(pageSrc).toMatch(/inventoryBags\.internalReceiptNumber/);
    expect(pageSrc).toMatch(/COALESCE\(\$\{inventoryBags\.internalReceiptNumber\},\s*\$\{workflowBags\.receiptNumber\}\)/);
  });

  it("keeps legacy workflow receipt as fallback only", () => {
    const coalesceIdx = pageSrc.indexOf("COALESCE(${inventoryBags.internalReceiptNumber}");
    const workflowReceiptIdx = pageSrc.indexOf("${workflowBags.receiptNumber}", coalesceIdx);
    expect(coalesceIdx).toBeGreaterThan(0);
    expect(workflowReceiptIdx).toBeGreaterThan(coalesceIdx);
  });

  it("searches linked inventory receipt numbers as well as legacy workflow receipts", () => {
    const searchBlockStart = pageSrc.indexOf("if (q !== null)");
    const searchBlock = searchBlockStart >= 0 ? pageSrc.slice(searchBlockStart, searchBlockStart + 500) : "";
    expect(searchBlock).toMatch(/ilike\(workflowBags\.receiptNumber/);
    expect(searchBlock).toMatch(/ilike\(inventoryBags\.internalReceiptNumber/);
  });

  it("searches human-readable bag label context without using UUID fragments", () => {
    const searchBlockStart = pageSrc.indexOf("if (q !== null)");
    const searchBlock = searchBlockStart >= 0 ? pageSrc.slice(searchBlockStart, searchBlockStart + 650) : "";
    expect(searchBlock).toMatch(/ilike\(tabletTypes\.name/);
    expect(searchBlock).toMatch(/ilike\(receives\.receiveName/);
    expect(searchBlock).toMatch(/ilike\(purchaseOrders\.poNumber/);
    expect(searchBlock).not.toMatch(/workflowBags\.id|workflowEvents|payload/);
  });

  it("serializes the resolved receipt number without inventing a fallback", () => {
    const mapStart = pageSrc.indexOf("const bags: WorkflowBagRow[] = rows.map");
    const mapBlock = mapStart >= 0 ? pageSrc.slice(mapStart, mapStart + 700) : "";
    const receiptLine = mapBlock
      .split("\n")
      .find((line) => line.includes("receiptNumber:"));
    expect(receiptLine).toMatch(/receiptNumber:\s*r\.receiptNumber\s*\?\?\s*null/);
    expect(receiptLine).not.toMatch(/productName|productSku|bagNumber|workflowEvents|payload/);
  });

  it("table still renders an honest dash when receipt linkage is absent", () => {
    expect(tableSrc).toMatch(/bag\.receiptNumber/);
    expect(tableSrc).toMatch(/<span className="font-mono text-text-subtle">—<\/span>/);
  });

  it("table builds a human-readable bag label and keeps workflow id secondary", () => {
    expect(tableSrc).toMatch(/function buildBagLabel/);
    expect(tableSrc).toMatch(/bag\.inventoryBagNumber \?\? bag\.bagNumber/);
    expect(tableSrc).toMatch(/bag\.tabletTypeName \?\? bag\.productName/);
    expect(tableSrc).toMatch(/bag\.poNumber \? `PO \$\{bag\.poNumber\}` : null/);
    expect(tableSrc).toMatch(/Workflow \$\{shortId\}/);
  });

  it("legacy/unlinked bag label is explicit and does not fabricate a bag number", () => {
    const helperStart = tableSrc.indexOf("function buildBagLabel");
    const helperEnd = tableSrc.indexOf("function extractSubmissionLines", helperStart);
    const helperBlock =
      helperStart >= 0 && helperEnd > helperStart
        ? tableSrc.slice(helperStart, helperEnd)
        : "";
    expect(helperBlock).toMatch(/Legacy bag \$\{shortId\}/);
    expect(helperBlock).toMatch(/Missing received-bag context/);
    expect(helperBlock).not.toMatch(/row order|payload|event payload/);
  });
});
