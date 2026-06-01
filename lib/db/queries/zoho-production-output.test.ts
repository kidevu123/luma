import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildProductionOutputPreviewPayload,
  buildProductionOutputPreviewRequestHash,
  type ProductionOutputPreviewBuildInput,
} from "@/lib/zoho/production-output-preview";
import {
  buildZohoProductionOutputPreviewOpValues,
} from "./zoho-production-output";
import {
  evaluateZohoProductionOutputApproval,
} from "@/lib/zoho/production-output-approval";

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
const migrationApprovalSrc = readFileSync(
  join(root, "drizzle/0052_zoho_production_output_approval.sql"),
  "utf8",
);
const migrationCommitReadinessSrc = readFileSync(
  join(root, "drizzle/0053_zoho_production_output_commit_readiness.sql"),
  "utf8",
);
const querySrc = readFileSync(
  join(root, "lib/db/queries/zoho-production-output.ts"),
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

  it("extends status and approval/void columns in migration 0052", () => {
    expect(migrationApprovalSrc).toContain("'DRAFT', 'PREVIEWED', 'APPROVED', 'VOIDED'");
    expect(migrationApprovalSrc).toContain('"approved_at"');
    expect(migrationApprovalSrc).toContain('"approved_request_hash"');
    expect(migrationApprovalSrc).toContain('"void_reason"');
    expect(migrationApprovalSrc).not.toContain("/commit");
    expect(journalSrc).toContain('"tag": "0052_zoho_production_output_approval"');

    expect(schemaSrc).toContain("approvedAt:");
    expect(schemaSrc).toContain("approvedRequestHash:");
    expect(schemaSrc).toContain("voidReason:");
  });

  it("adds future commit metadata/status columns in migration 0053", () => {
    expect(migrationCommitReadinessSrc).toContain("'QUEUED'");
    expect(migrationCommitReadinessSrc).toContain("'COMMITTING'");
    expect(migrationCommitReadinessSrc).toContain("'COMMITTED'");
    expect(migrationCommitReadinessSrc).toContain("'FAILED'");
    expect(migrationCommitReadinessSrc).toContain('"commit_idempotency_key" text');
    expect(migrationCommitReadinessSrc).toContain('"commit_requested_at" timestamptz');
    expect(migrationCommitReadinessSrc).toContain('"commit_attempt_count" integer NOT NULL DEFAULT 0');
    expect(migrationCommitReadinessSrc).toContain('"commit_response" jsonb');
    expect(migrationCommitReadinessSrc).toContain('"external_reference_id" text');
    expect(migrationCommitReadinessSrc).toContain('"zoho_prod_output_ops_commit_idem_unique"');
    expect(migrationCommitReadinessSrc).toContain('"zoho_prod_output_ops_committed_lot_unique"');
    expect(migrationCommitReadinessSrc).not.toContain("/commit");
    expect(journalSrc).toContain(
      '"tag": "0053_zoho_production_output_commit_readiness"',
    );

    expect(schemaSrc).toContain("commitIdempotencyKey:");
    expect(schemaSrc).toContain("commitRequestedAt:");
    expect(schemaSrc).toContain("commitAttemptCount:");
    expect(schemaSrc).toContain("externalReferenceId:");
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
    expect(querySrc).not.toContain("/commit");
    expect(querySrc).not.toContain("/apply");
    expect(querySrc).not.toContain("/send");
    expect(migrationSrc).not.toContain("/commit");
    expect(migrationApprovalSrc).not.toContain("/commit");
    expect(migrationCommitReadinessSrc).not.toContain("/commit");
  });

  it("blocks approval for DRAFT, MISSING metrics, and LOW genealogy via shared evaluator", () => {
    expect(
      evaluateZohoProductionOutputApproval({
        status: "DRAFT",
        voidedAt: null,
        previewResponse: null,
        previewHttpStatus: null,
        metricsState: "HIGH",
        genealogyState: "HIGH",
        requestHash: "h",
        approvedRequestHash: null,
      }).eligible,
    ).toBe(false);

    expect(
      evaluateZohoProductionOutputApproval({
        status: "PREVIEWED",
        voidedAt: null,
        previewResponse: { preview: true },
        previewHttpStatus: 200,
        metricsState: "MISSING",
        genealogyState: "HIGH",
        requestHash: "h",
        approvedRequestHash: null,
      }).eligible,
    ).toBe(false);

    expect(
      evaluateZohoProductionOutputApproval({
        status: "PREVIEWED",
        voidedAt: null,
        previewResponse: { preview: true },
        previewHttpStatus: 200,
        metricsState: "HIGH",
        genealogyState: "LOW",
        requestHash: "h",
        approvedRequestHash: null,
      }).eligible,
    ).toBe(false);
  });

  it("guards approved ops from silent re-preview in query layer", () => {
    expect(querySrc).toContain('existing.status !== "DRAFT"');
    expect(querySrc).toContain('existing.status !== "PREVIEWED"');
    expect(querySrc).toContain("approvedRequestHash: row.requestHash");
    expect(querySrc).toContain('status: "VOIDED"');
  });

  it("evaluates future commit readiness with legacy double-post blockers read-only", () => {
    expect(querySrc).toContain("evaluateZohoProductionOutputCommitReadiness");
    expect(querySrc).toContain("zohoAssemblyOps");
    expect(querySrc).toContain("zohoPushes");
    expect(querySrc).toContain('eq(zohoProductionOutputOps.status, "COMMITTED")');
    expect(querySrc).toContain('eq(zohoPushes.status, "SUCCESS")');
    expect(querySrc).not.toContain(".insert(zohoAssemblyOps)");
    expect(querySrc).not.toContain(".update(zohoAssemblyOps)");
    expect(querySrc).not.toContain(".delete(zohoAssemblyOps)");
  });

  it("queues APPROVED ops without live Zoho calls or worker enqueue", () => {
    expect(querySrc).toContain("queueZohoProductionOutputOpForFutureCommit");
    expect(querySrc).toContain("evaluateZohoProductionOutputQueueEligibility");
    expect(querySrc).toContain('status: "QUEUED"');
    expect(querySrc).toContain("commitRequestedAt");
    expect(querySrc).toContain("commitIdempotencyKey");
    expect(querySrc).toContain('action: "zoho_production_output_op.queue"');
    expect(querySrc).toContain("Already queued for future commit.");
    expect(querySrc).not.toContain("pg-boss");
    expect(querySrc).not.toContain("boss.send");
    expect(querySrc).not.toContain("callProductionOutputPreview");
  });

  it("adds C3a mock commit state machine without live HTTP", () => {
    expect(querySrc).toContain("evaluateZohoProductionOutputProcessCommitEligibility");
    expect(querySrc).toContain("claimZohoProductionOutputOpForCommit");
    expect(querySrc).toContain("completeZohoProductionOutputCommitSuccess");
    expect(querySrc).toContain("completeZohoProductionOutputCommitFailure");
    expect(querySrc).toContain("processQueuedZohoProductionOutputCommitWithMockGateway");
    expect(querySrc).toContain("mockCallZohoProductionOutputCommit");
    expect(querySrc).toContain('action: "zoho_production_output_op.commit_started"');
    expect(querySrc).toContain('action: "zoho_production_output_op.commit_succeeded"');
    expect(querySrc).toContain('action: "zoho_production_output_op.commit_failed"');
    expect(querySrc).not.toContain("/commit");
    expect(querySrc).not.toContain("fetch(");
    expect(querySrc).not.toContain(".insert(zohoAssemblyOps)");
    expect(querySrc).not.toContain(".update(zohoAssemblyOps)");
  });
});
