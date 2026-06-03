import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const scriptSrc = readFileSync(
  join(process.cwd(), "scripts/verify-partial-bag-restart-e2e.ts"),
  "utf8",
);

describe("verify-partial-bag-restart-e2e harness safety", () => {
  it("refuses without ALLOW_STAGING_QA_DATA", () => {
    expect(scriptSrc).toMatch(/ALLOW_STAGING_QA_DATA/);
    expect(scriptSrc).toMatch(/VERIFY_PARTIAL_BAG_RESTART_STAGING_ONLY/);
    expect(scriptSrc).toMatch(/process\.exit\(2\)/);
  });

  it("uses QA-PARTIAL-BAG-RESTART-1 marker", () => {
    expect(scriptSrc).toMatch(/QA-PARTIAL-BAG-RESTART-1/);
    expect(scriptSrc).toContain("export const QA_MARKER");
  });

  it("has finally cleanup and post-cleanup sweep", () => {
    expect(scriptSrc).toMatch(/finally/);
    expect(scriptSrc).toMatch(/async function cleanup/);
    expect(scriptSrc).toMatch(/countQaRows/);
    expect(scriptSrc).toMatch(/cleanup sweep/);
  });

  it("uses distinct Product A and Product B", () => {
    expect(scriptSrc).toMatch(/productA/);
    expect(scriptSrc).toMatch(/productB/);
    expect(scriptSrc).toMatch(/Product A and B must differ/);
  });

  it("does not import Zoho or Nexus", () => {
    expect(scriptSrc).not.toMatch(/zoho/i);
    expect(scriptSrc).not.toMatch(/nexus/i);
  });

  it("does not auto-close raw bag allocation on sealing partial", () => {
    expect(scriptSrc).not.toMatch(/allocation.*auto/i);
    expect(scriptSrc).not.toMatch(/partial_close:\s*true/);
  });

  it("asserts new run does not inherit Product A", () => {
    expect(scriptSrc).toMatch(/not inherited A/);
    expect(scriptSrc).toMatch(/prior workflow bag still Product A/);
  });

  it("checks packaging uses Product B via checkPackagingPrereqs", () => {
    expect(scriptSrc).toMatch(/checkPackagingPrereqs/);
    expect(scriptSrc).toMatch(/readProductId === prodB\.productId/);
  });
});
