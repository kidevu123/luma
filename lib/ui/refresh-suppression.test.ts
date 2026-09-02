import { describe, it, expect } from "vitest";
import { acquireRefreshSuppression, isRefreshSuppressed } from "./refresh-suppression";

describe("SIMPLIFY-A: refresh suppression counter", () => {
  it("not suppressed by default", () => {
    expect(isRefreshSuppressed()).toBe(false);
  });
  it("suppressed while any holder is active; released when all release", () => {
    const releaseA = acquireRefreshSuppression();
    const releaseB = acquireRefreshSuppression();
    expect(isRefreshSuppressed()).toBe(true);
    releaseA();
    expect(isRefreshSuppressed()).toBe(true);
    releaseB();
    expect(isRefreshSuppressed()).toBe(false);
  });
  it("double release is harmless (idempotent)", () => {
    const release = acquireRefreshSuppression();
    release();
    release();
    expect(isRefreshSuppressed()).toBe(false);
  });
});
