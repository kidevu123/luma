import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildProductionOutputPreviewPayload,
  buildProductionOutputPreviewRequestHash,
  type ProductionOutputPreviewBuildInput,
} from "@/lib/zoho/production-output-preview";
import { buildZohoProductionOutputPreviewOpValues } from "./zoho-production-output";

const root = process.cwd();
const migrationSrc = readFileSync(
  join(root, "drizzle/0049_zoho_production_output_ops.sql"),
  "utf8",
);
const schemaSrc = readFileSync(join(root, "lib/db/schema.ts"), "utf8");
const journalSrc = readFileSync(
  join(root, "drizzle/meta/_journal.json"),
  "utf8",
);

const BASE_INPUT: ProductionOutputPreviewBuildInput = {
  finishedLotId: "11111111-1111-4111-8111-111111111111",
  workflowBagId: "22222222-2222-4222-8222-222222222222",
  producedOn: "2026-05-28",
  unitsProduced: 100,
  displaysProduced: 0,
  casesProduced: 0,
  product: {
    zohoItemIdUnit: "unit-composite-1",
    zohoItemIdDisplay: null,
    zohoItemIdCase: null,
  },
  metrics: null,
  mapping: {
    purchaseorderId: "po-1",
    purchaseorderLineItemId: "line-1",
    warehouseId: "warehouse-1",
    notes: null,
  },
};

describe("zoho production output durable preview schema", () => {
  it("adds the durable preview table with active-per-finished-lot uniqueness", () => {
    expect(migrationSrc).toContain(
      'CREATE TABLE IF NOT EXISTS "zoho_production_output_ops"',
    );
    expect(migrationSrc).toContain('"request_payload" jsonb NOT NULL');
    expect(migrationSrc).toContain('"preview_response" jsonb');
    expect(migrationSrc).toContain('"metrics_state" text NOT NULL');
    expect(migrationSrc).toContain('"genealogy_state" text NOT NULL');
    expect(migrationSrc).toContain("\"status\" IN ('DRAFT', 'PREVIEWED')");
    expect(migrationSrc).toContain('"zoho_prod_output_ops_active_lot_unique"');
    expect(migrationSrc).toContain('WHERE "voided_at" IS NULL');

    expect(schemaSrc).toContain("export const zohoProductionOutputOps");
    expect(schemaSrc).toContain(
      'uniqueIndex("zoho_prod_output_ops_active_lot_unique")',
    );
    expect(journalSrc).toContain('"tag": "0049_zoho_production_output_ops"');
  });
});

describe("buildZohoProductionOutputPreviewOpValues", () => {
  it("stores missing metrics as MISSING and nullable quantities, not actual zero", () => {
    const result = buildProductionOutputPreviewPayload(BASE_INPUT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.payload.quantity_damaged).toBe(0);
    const values = buildZohoProductionOutputPreviewOpValues({
      finishedLotId: BASE_INPUT.finishedLotId,
      workflowBagId: BASE_INPUT.workflowBagId,
      lumaOperationId: result.payload.luma_operation_id,
      status: "PREVIEWED",
      payload: result.payload,
      requestHash: buildProductionOutputPreviewRequestHash(result.payload),
      previewIdempotencyKey: "idem-1",
      previewHttpStatus: 200,
      previewResponse: { preview: true },
      metricsState: "MISSING",
      genealogyState: "LOW",
      userId: "33333333-3333-4333-8333-333333333333",
    });

    expect(values.metricsState).toBe("MISSING");
    expect(values.quantityDamaged).toBeNull();
    expect(values.quantityRipped).toBeNull();
    expect(values.quantityLoose).toBeNull();
  });

  it("keeps measured metric quantities when metrics are high-confidence", () => {
    const result = buildProductionOutputPreviewPayload({
      ...BASE_INPUT,
      metrics: {
        damagedPackaging: 2,
        rippedCards: 3,
        looseCards: 4,
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const values = buildZohoProductionOutputPreviewOpValues({
      finishedLotId: BASE_INPUT.finishedLotId,
      workflowBagId: BASE_INPUT.workflowBagId,
      lumaOperationId: result.payload.luma_operation_id,
      status: "PREVIEWED",
      payload: result.payload,
      requestHash: buildProductionOutputPreviewRequestHash(result.payload),
      previewIdempotencyKey: "idem-1",
      previewHttpStatus: 200,
      previewResponse: { preview: true },
      metricsState: "HIGH",
      genealogyState: "HIGH",
      userId: "33333333-3333-4333-8333-333333333333",
    });

    expect(values.quantityDamaged).toBe(2);
    expect(values.quantityRipped).toBe(3);
    expect(values.quantityLoose).toBe(4);
  });

  it("changes request_hash when mapping inputs change for an active preview row update", () => {
    const first = buildProductionOutputPreviewPayload(BASE_INPUT);
    const second = buildProductionOutputPreviewPayload({
      ...BASE_INPUT,
      mapping: { ...BASE_INPUT.mapping, purchaseorderLineItemId: "line-2" },
    });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    expect(buildProductionOutputPreviewRequestHash(second.payload)).not.toBe(
      buildProductionOutputPreviewRequestHash(first.payload),
    );
  });

  it("does not reference live commit endpoints", () => {
    const helperSrc = readFileSync(
      join(root, "lib/db/queries/zoho-production-output.ts"),
      "utf8",
    );
    expect(helperSrc).not.toContain("/commit");
    expect(migrationSrc).not.toContain("/commit");
  });
});
