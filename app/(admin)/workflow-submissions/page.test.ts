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
