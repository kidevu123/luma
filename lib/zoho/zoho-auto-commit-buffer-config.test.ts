import { describe, expect, it } from "vitest";
import {
  deriveAutoCommitEligibleAt,
  resolveZohoAutoCommitBufferConfig,
} from "./zoho-auto-commit-buffer-config";

const NOW = new Date("2026-06-15T12:00:00Z");

describe("resolveZohoAutoCommitBufferConfig", () => {
  it("defaults to disabled when the master switch is unset", () => {
    // Conservative default: a brand-new env with no Zoho config
    // should NEVER auto-commit. The operator opts in by setting
    // ZOHO_AUTO_COMMIT_ENABLED=true.
    expect(resolveZohoAutoCommitBufferConfig({}).enabled).toBe(false);
  });

  it("respects the master switch when set to true", () => {
    expect(
      resolveZohoAutoCommitBufferConfig({ ZOHO_AUTO_COMMIT_ENABLED: "true" })
        .enabled,
    ).toBe(true);
  });

  it("treats every non-'true' value as disabled (no accidental 1/yes/on aliases)", () => {
    for (const value of ["1", "yes", "on", "TRUE", "True", "false", "0", " ", ""]) {
      expect(
        resolveZohoAutoCommitBufferConfig({ ZOHO_AUTO_COMMIT_ENABLED: value })
          .enabled,
      ).toBe(false);
    }
  });

  it("defaults to 24-hour buffer", () => {
    expect(resolveZohoAutoCommitBufferConfig({}).bufferHours).toBe(24);
  });

  it("respects 0 for immediate (the staging/test signal)", () => {
    expect(
      resolveZohoAutoCommitBufferConfig({ ZOHO_AUTO_COMMIT_BUFFER_HOURS: "0" })
        .bufferHours,
    ).toBe(0);
  });

  it("caps the buffer at one week to catch misconfiguration", () => {
    expect(
      resolveZohoAutoCommitBufferConfig({
        ZOHO_AUTO_COMMIT_BUFFER_HOURS: "9999",
      }).bufferHours,
    ).toBe(24);
  });

  it("ignores non-numeric values and falls back to the default", () => {
    expect(
      resolveZohoAutoCommitBufferConfig({
        ZOHO_AUTO_COMMIT_BUFFER_HOURS: "soon",
      }).bufferHours,
    ).toBe(24);
  });

  it("ignores negative values and falls back to the default", () => {
    expect(
      resolveZohoAutoCommitBufferConfig({
        ZOHO_AUTO_COMMIT_BUFFER_HOURS: "-5",
      }).bufferHours,
    ).toBe(24);
  });

  it("floors fractional hours", () => {
    expect(
      resolveZohoAutoCommitBufferConfig({
        ZOHO_AUTO_COMMIT_BUFFER_HOURS: "1.7",
      }).bufferHours,
    ).toBe(1);
  });
});

describe("deriveAutoCommitEligibleAt", () => {
  it("returns null when auto-commit is disabled (the cron-skip signal)", () => {
    expect(
      deriveAutoCommitEligibleAt(NOW, { enabled: false, bufferHours: 24 }),
    ).toBeNull();
  });

  it("returns now when buffer = 0 (immediate auto-commit for staging tests)", () => {
    const eligible = deriveAutoCommitEligibleAt(NOW, {
      enabled: true,
      bufferHours: 0,
    });
    expect(eligible).not.toBeNull();
    expect(eligible!.getTime()).toBe(NOW.getTime());
  });

  it("returns now + 24h when buffer = 24 (the production default)", () => {
    const eligible = deriveAutoCommitEligibleAt(NOW, {
      enabled: true,
      bufferHours: 24,
    });
    expect(eligible!.getTime() - NOW.getTime()).toBe(24 * 60 * 60 * 1000);
  });

  it("scales linearly for arbitrary buffer hours", () => {
    expect(
      deriveAutoCommitEligibleAt(NOW, { enabled: true, bufferHours: 6 })!
        .getTime() - NOW.getTime(),
    ).toBe(6 * 60 * 60 * 1000);
  });
});
