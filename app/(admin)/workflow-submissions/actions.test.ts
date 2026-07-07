import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const actionSrc = readFileSync(join(__dirname, "actions.ts"), "utf8");

describe("WORKFLOW-SUBMISSION-ADMIN-REPAIR-1 · server action", () => {
  it("requires an admin actor before repairing a workflow bag", () => {
    expect(actionSrc).toMatch(/requireAdmin/);
    expect(actionSrc).toMatch(/const actor = await requireAdmin\(\)/);
  });

  it("accepts a nonnegative missing blister count and a supervisor note", () => {
    expect(actionSrc).toMatch(/countTotal/);
    expect(actionSrc).toMatch(/z\.number\(\)\.int\(\)\.nonnegative\(\)/);
    expect(actionSrc).toMatch(/notes/);
    expect(actionSrc).toMatch(/min\(10,\s*"Enter a reason for the repair\."\)/);
  });

  it("blocks unsafe bags instead of applying a blind repair", () => {
    expect(actionSrc).toMatch(/Finalized bags cannot be repaired from this tool/);
    expect(actionSrc).toMatch(/This repair only applies to STARTED bags/);
    expect(actionSrc).toMatch(/This bag already has a submission event/);
    expect(actionSrc).toMatch(/No blister station lineage found/);
    expect(actionSrc).toMatch(/Multiple blister stations touched this bag/);
  });

  it("appends workflow events through projectEvent instead of mutating history", () => {
    expect(actionSrc).toMatch(/projectEvent/);
    expect(actionSrc).toMatch(/eventType:\s*"BAG_RESUMED"/);
    expect(actionSrc).toMatch(/eventType:\s*"BLISTER_COMPLETE"/);
    expect(actionSrc).toMatch(/eventType:\s*"BAG_RELEASED"/);
    expect(actionSrc).not.toMatch(/\.update\(workflowEvents\)|\.delete\(workflowEvents\)/);
  });

  it("stores the repaired machine counter as the existing count_total payload key", () => {
    expect(actionSrc).toMatch(/payload:\s*\{\s*count_total:\s*parsed\.data\.countTotal/);
    expect(actionSrc).not.toMatch(/counter_presses|packs_remaining/);
  });

  it("writes an audit log for the repair", () => {
    expect(actionSrc).toMatch(/writeAudit/);
    expect(actionSrc).toMatch(/workflow_submissions\.missing_blister_closeout_repair/);
    expect(actionSrc).toMatch(/targetType:\s*"WorkflowBag"/);
  });
});

describe("ADMIN-CORRECTION-WIZARD-1 · wrong-product correction actions", () => {
  const serviceSrc = readFileSync(
    join(__dirname, "..", "..", "..", "lib/production/wrong-product-correction-service.ts"),
    "utf8",
  );
  const wizardSrc = readFileSync(
    join(__dirname, "_workflow-recovery-form.tsx"),
    "utf8",
  );

  it("gates every correction action behind requireAdmin", () => {
    expect(actionSrc).toMatch(
      /loadWrongProductCorrectionOptionsAction[\s\S]{0,200}await requireAdmin\(\)/,
    );
    expect(actionSrc).toMatch(
      /previewWrongProductCorrectionAction[\s\S]{0,300}await requireAdmin\(\)/,
    );
    expect(actionSrc).toMatch(
      /applyWrongProductCorrectionAction[\s\S]{0,300}await requireAdmin\(\)/,
    );
  });

  it("apply requires an explicit confirmation and a detailed reason", () => {
    expect(actionSrc).toMatch(/wrongProductCorrectionApplySchema[\s\S]*?confirm: z\.literal\("true"\)/);
    expect(actionSrc).toMatch(/reason: z\.string\(\)\.trim\(\)\.min\(10/);
  });

  it("service re-evaluates blockers inside the transaction (fail closed)", () => {
    expect(serviceSrc).toMatch(/const ctx = await loadWrongProductCorrectionContext/);
    expect(serviceSrc).toMatch(/if \(!ctx\.verdict\.allowed\)/);
  });

  it("service remaps via the existing audited PRODUCT_MAPPED pattern", () => {
    expect(serviceSrc).toMatch(/eventType: "PRODUCT_MAPPED"/);
    expect(serviceSrc).toMatch(/WRONG_PRODUCT_CORRECTION_SOURCE/);
    expect(serviceSrc).toMatch(/reprojectBagMetricsForWorkflowBag/);
    expect(serviceSrc).toMatch(/projectFinishedLotPassportForLot/);
  });

  it("service never mutates or deletes workflow event history", () => {
    expect(serviceSrc).not.toMatch(/\.update\(workflowEvents\)|\.delete\(workflowEvents\)/);
    expect(serviceSrc).not.toMatch(/delete\(finishedLots\)|delete\(zohoProductionOutputOps\)/);
  });

  it("service holds the rebuilt lot and voids only uncommitted Zoho ops", () => {
    expect(serviceSrc).toMatch(/status: "ON_HOLD"/);
    expect(serviceSrc).toMatch(/status !== "COMMITTED"/);
    expect(serviceSrc).toMatch(/Voided after wrong-product correction/);
    expect(serviceSrc).not.toMatch(/status:\s*"COMMITTED"/);
  });

  it("service writes the full audit snapshot", () => {
    expect(serviceSrc).toMatch(/workflow_submissions\.wrong_product_correction/);
    expect(serviceSrc).toMatch(/finished_lot\.wrong_product_correction/);
    expect(serviceSrc).toMatch(/raw_bag_allocation\.wrong_product_correction/);
    expect(serviceSrc).toMatch(/voided_zoho_op_ids/);
  });

  it("recovery action now records intended product instead of hardcoding null", () => {
    expect(actionSrc).toMatch(/intended_product_id: intendedProduct\?\.id \?\? null/);
    expect(actionSrc).not.toMatch(/intended_product_id: null,/);
    expect(actionSrc).toMatch(/intended_route: intendedProduct\?\.kind \?\? null/);
    expect(actionSrc).toMatch(/correction_mode:/);
  });

  it("wizard requires a correct product selection and a preview before apply", () => {
    expect(wizardSrc).toMatch(/Correct product/);
    expect(wizardSrc).toMatch(/required[\s\S]{0,120}value=\{selectedProductId\}/);
    expect(wizardSrc).toMatch(/previewWrongProductCorrectionAction/);
    expect(wizardSrc).toMatch(/preview\?\.verdict && allowed \?/);
    expect(wizardSrc).toMatch(/disabled=\{pending \|\| !confirmed\}/);
  });

  it("wizard never offers route conversion and guides to quarantine + restart", () => {
    expect(wizardSrc).toMatch(/mark the wrong workflow output as invalid for normal\s+output/);
    expect(wizardSrc).toMatch(/Direct conversion between routes[\s\S]{0,80}is not allowed/);
    expect(wizardSrc).toMatch(/Start the correct workflow/);
    expect(wizardSrc).toMatch(/QUARANTINE_AND_RESTART/);
  });

  it("wizard keeps wrong-QR correction quarantine-only", () => {
    expect(wizardSrc).toMatch(/WRONG_QR_ASSIGNMENT/);
    expect(wizardSrc).toMatch(/not automated/);
  });
});
