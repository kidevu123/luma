import { describe, expect, it } from "vitest";
import {
  KIOSK_BUILD_POLL_INTERVAL_MS,
  shouldReloadForDeployDrift,
} from "./deploy-drift";

describe("shouldReloadForDeployDrift", () => {
  it("returns false when SHAs match", () => {
    expect(shouldReloadForDeployDrift("abc1234", "abc1234")).toBe(false);
  });

  it("returns true when SHAs differ", () => {
    expect(shouldReloadForDeployDrift("abc1234", "def5678")).toBe(true);
  });

  it("returns false when served SHA is empty", () => {
    expect(shouldReloadForDeployDrift("", "abc1234")).toBe(false);
    expect(shouldReloadForDeployDrift("   ", "abc1234")).toBe(false);
  });

  it("returns false when remote SHA is empty", () => {
    expect(shouldReloadForDeployDrift("abc1234", "")).toBe(false);
    expect(shouldReloadForDeployDrift("abc1234", "  ")).toBe(false);
  });

  it("trims whitespace before comparing", () => {
    expect(shouldReloadForDeployDrift(" abc1234 ", "abc1234")).toBe(false);
    expect(shouldReloadForDeployDrift("abc1234", " def5678 ")).toBe(true);
  });
});

describe("KIOSK_BUILD_POLL_INTERVAL_MS", () => {
  it("is three minutes", () => {
    expect(KIOSK_BUILD_POLL_INTERVAL_MS).toBe(3 * 60 * 1000);
  });
});
