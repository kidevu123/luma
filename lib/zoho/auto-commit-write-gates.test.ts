import { describe, expect, it } from "vitest";
import { resolveAutoCommitWriteGates } from "./auto-commit-write-gates";

const SAFE_FIRST_DEPLOY_ENV: Record<string, string | undefined> = {
  // First-deploy posture per the v1.1.0 release plan.
  ZOHO_AUTO_COMMIT_ENABLED: "false",
  ZOHO_DRY_RUN_WRITES_ENABLED: "false",
  ZOHO_PRODUCTION_OUTPUT_COMMIT_ENABLED: "false",
  ZOHO_PRODUCTION_OUTPUT_PREVIEW_ENABLED: "false",
  ZOHO_PRODUCTION_OUTPUT_PERSIST_ENABLED: "false",
};

const ALL_GATES_OPEN_ENV: Record<string, string | undefined> = {
  ZOHO_AUTO_COMMIT_ENABLED: "true",
  ZOHO_DRY_RUN_WRITES_ENABLED: "true",
  ZOHO_PRODUCTION_OUTPUT_COMMIT_ENABLED: "true",
  ZOHO_PRODUCTION_OUTPUT_PREVIEW_ENABLED: "true",
  ZOHO_PRODUCTION_OUTPUT_PERSIST_ENABLED: "true",
};

describe("resolveAutoCommitWriteGates — first-deploy posture", () => {
  it("everything is off: cron will skip both surfaces", () => {
    const gates = resolveAutoCommitWriteGates(SAFE_FIRST_DEPLOY_ENV);
    expect(gates.autoCommitEnabled).toBe(false);
    expect(gates.rawBagWritesAllowed).toBe(false);
    expect(gates.productionOutputWritesAllowed).toBe(false);
    expect(gates.reasons.autoCommit).toContain("ZOHO_AUTO_COMMIT_ENABLED");
    expect(gates.reasons.rawBag).toContain("ZOHO_DRY_RUN_WRITES_ENABLED");
    expect(gates.reasons.productionOutput).toContain(
      "ZOHO_PRODUCTION_OUTPUT_COMMIT_ENABLED",
    );
  });
});

describe("resolveAutoCommitWriteGates — fully enabled", () => {
  it("with every flag true, both surfaces are write-allowed", () => {
    const gates = resolveAutoCommitWriteGates(ALL_GATES_OPEN_ENV);
    expect(gates.autoCommitEnabled).toBe(true);
    expect(gates.rawBagWritesAllowed).toBe(true);
    expect(gates.productionOutputWritesAllowed).toBe(true);
    expect(gates.reasons).toEqual({});
  });
});

describe("resolveAutoCommitWriteGates — partial postures", () => {
  it("auto-commit master switch off blocks both even when sub-gates are on", () => {
    const gates = resolveAutoCommitWriteGates({
      ...ALL_GATES_OPEN_ENV,
      ZOHO_AUTO_COMMIT_ENABLED: "false",
    });
    expect(gates.autoCommitEnabled).toBe(false);
    // Sub-gates report their own state independently; the cron's
    // higher-level logic then refuses to attempt anything because
    // autoCommitEnabled is the master switch.
    expect(gates.rawBagWritesAllowed).toBe(true);
    expect(gates.productionOutputWritesAllowed).toBe(true);
  });

  it("raw-bag can be enabled in isolation (production-output stays off)", () => {
    const gates = resolveAutoCommitWriteGates({
      ZOHO_AUTO_COMMIT_ENABLED: "true",
      ZOHO_DRY_RUN_WRITES_ENABLED: "true",
      // production-output gates omitted
    });
    expect(gates.rawBagWritesAllowed).toBe(true);
    expect(gates.productionOutputWritesAllowed).toBe(false);
  });

  it("production-output can be enabled in isolation (raw-bag stays off)", () => {
    const gates = resolveAutoCommitWriteGates({
      ZOHO_AUTO_COMMIT_ENABLED: "true",
      ZOHO_PRODUCTION_OUTPUT_PERSIST_ENABLED: "true",
      ZOHO_PRODUCTION_OUTPUT_PREVIEW_ENABLED: "true",
      ZOHO_PRODUCTION_OUTPUT_COMMIT_ENABLED: "true",
      // ZOHO_DRY_RUN_WRITES_ENABLED omitted
    });
    expect(gates.rawBagWritesAllowed).toBe(false);
    expect(gates.productionOutputWritesAllowed).toBe(true);
  });
});

describe("resolveAutoCommitWriteGates — treats non-'true' as off", () => {
  it("'1' / 'yes' / 'on' are NOT accepted as true", () => {
    for (const value of ["1", "yes", "on", "TRUE"]) {
      const gates = resolveAutoCommitWriteGates({
        ZOHO_AUTO_COMMIT_ENABLED: value,
      });
      expect(gates.autoCommitEnabled).toBe(false);
    }
  });
});
