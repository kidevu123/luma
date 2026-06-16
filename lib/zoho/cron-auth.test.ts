import { describe, expect, it } from "vitest";
import { cronAuthHttpStatus, validateCronBearer } from "./cron-auth";

const ENV_WITH_SECRET = { LUMA_CRON_SECRET: "the-correct-secret-1234567890" };

describe("validateCronBearer — env config", () => {
  it("rejects when LUMA_CRON_SECRET is unset, even if a valid-looking header is sent", () => {
    // Fail-closed: a missing secret env means the endpoint is mis-
    // configured. Better to 503 than accidentally accept any request.
    const result = validateCronBearer("Bearer anything", {});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("NOT_CONFIGURED");
  });

  it("rejects when LUMA_CRON_SECRET is empty / whitespace", () => {
    expect(validateCronBearer("Bearer x", { LUMA_CRON_SECRET: "" }).ok).toBe(false);
    expect(validateCronBearer("Bearer x", { LUMA_CRON_SECRET: "   " }).ok).toBe(false);
  });

  it("503 is the correct status for NOT_CONFIGURED (infra problem, not auth problem)", () => {
    expect(cronAuthHttpStatus("NOT_CONFIGURED")).toBe(503);
  });
});

describe("validateCronBearer — header parsing", () => {
  it("rejects a request with no Authorization header", () => {
    const result = validateCronBearer(undefined, ENV_WITH_SECRET);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("MISSING_HEADER");
  });

  it("rejects an empty Authorization header", () => {
    const result = validateCronBearer("", ENV_WITH_SECRET);
    if (result.ok) throw new Error("expected reject");
    expect(result.reason).toBe("MISSING_HEADER");
  });

  it("rejects a non-Bearer scheme (Basic / Token / etc)", () => {
    const result = validateCronBearer(
      "Basic dXNlcjpwYXNzd29yZA==",
      ENV_WITH_SECRET,
    );
    if (result.ok) throw new Error("expected reject");
    expect(result.reason).toBe("BAD_SCHEME");
  });

  it("accepts case-insensitive 'Bearer' / 'bearer' / 'BEARER'", () => {
    expect(
      validateCronBearer(
        `BEARER ${ENV_WITH_SECRET.LUMA_CRON_SECRET}`,
        ENV_WITH_SECRET,
      ).ok,
    ).toBe(true);
    expect(
      validateCronBearer(
        `bearer ${ENV_WITH_SECRET.LUMA_CRON_SECRET}`,
        ENV_WITH_SECRET,
      ).ok,
    ).toBe(true);
  });

  it("rejects a Bearer header with no token", () => {
    const result = validateCronBearer("Bearer    ", ENV_WITH_SECRET);
    if (result.ok) throw new Error("expected reject");
    // Whitespace-only token after Bearer → regex doesn't capture a
    // non-empty group → bad scheme.
    expect(["BAD_SCHEME", "BAD_SECRET"]).toContain(result.reason);
  });

  it("401 is the status for auth failures", () => {
    expect(cronAuthHttpStatus("MISSING_HEADER")).toBe(401);
    expect(cronAuthHttpStatus("BAD_SCHEME")).toBe(401);
    expect(cronAuthHttpStatus("BAD_SECRET")).toBe(401);
  });
});

describe("validateCronBearer — secret comparison", () => {
  it("accepts the exact secret", () => {
    expect(
      validateCronBearer(
        `Bearer ${ENV_WITH_SECRET.LUMA_CRON_SECRET}`,
        ENV_WITH_SECRET,
      ).ok,
    ).toBe(true);
  });

  it("rejects a wrong-but-same-length secret", () => {
    const wrong = "X".repeat(ENV_WITH_SECRET.LUMA_CRON_SECRET.length);
    const result = validateCronBearer(`Bearer ${wrong}`, ENV_WITH_SECRET);
    if (result.ok) throw new Error("expected reject");
    expect(result.reason).toBe("BAD_SECRET");
  });

  it("rejects a wrong-and-different-length secret", () => {
    expect(
      validateCronBearer("Bearer too-short", ENV_WITH_SECRET).ok,
    ).toBe(false);
    expect(
      validateCronBearer(
        `Bearer ${ENV_WITH_SECRET.LUMA_CRON_SECRET}-extra`,
        ENV_WITH_SECRET,
      ).ok,
    ).toBe(false);
  });

  it("does not leak prefix matches (timing-constant compare)", () => {
    // We can't strictly assert timing-constant behavior in a unit
    // test, but we CAN assert that a token that shares a long prefix
    // with the secret is still rejected.
    expect(
      validateCronBearer(
        `Bearer ${ENV_WITH_SECRET.LUMA_CRON_SECRET.slice(0, -1)}X`,
        ENV_WITH_SECRET,
      ).ok,
    ).toBe(false);
  });
});
