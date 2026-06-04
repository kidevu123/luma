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
