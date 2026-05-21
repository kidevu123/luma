// WORKFLOW-CLEANUP-2 — material filter tests.

import { describe, expect, it } from "vitest";
import { isQaTestMaterial } from "@/lib/production/material-filters";

describe("isQaTestMaterial", () => {
  it("flags QA_TEST_ prefix on sku", () => {
    expect(isQaTestMaterial({ sku: "QA_TEST_FOIL_ROLL", name: "Test foil" })).toBe(true);
  });
  it("flags QA- prefix on sku (covers QA_TEST_FOIL_ROLL and QA-FOIL aliases)", () => {
    expect(isQaTestMaterial({ sku: "QA-FOIL-01" })).toBe(true);
  });
  it("flags QA-TEST- prefix on sku", () => {
    expect(isQaTestMaterial({ sku: "QA-TEST-FOIL" })).toBe(true);
  });
  it("flags 'QA TEST' substring on name", () => {
    expect(isQaTestMaterial({ sku: "X1", name: "Pretty QA Test foil" })).toBe(true);
  });
  it("flags 'QA_TEST_' substring on name", () => {
    expect(isQaTestMaterial({ name: "Something QA_TEST_FOO" })).toBe(true);
  });
  it("does not flag legitimate production sku", () => {
    expect(isQaTestMaterial({ sku: "FOIL-PVC-001", name: "Blister foil" })).toBe(false);
  });
  it("does not flag empty inputs", () => {
    expect(isQaTestMaterial({})).toBe(false);
    expect(isQaTestMaterial({ sku: null, name: null })).toBe(false);
  });
  it("is case-insensitive on sku", () => {
    expect(isQaTestMaterial({ sku: "qa_test_lower" })).toBe(true);
  });
});
