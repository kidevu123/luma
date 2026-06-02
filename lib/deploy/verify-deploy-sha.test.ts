import { describe, expect, it } from "vitest";
import { evaluateDeployShaMatch } from "./verify-deploy-sha";

describe("evaluateDeployShaMatch", () => {
  const full = "66b0db0db401d9c71da58f820e2d1278a6d0b627";

  it("passes when health ok and SHAs match", () => {
    expect(evaluateDeployShaMatch(full, full, "ok")).toEqual({
      ok: true,
      comparable: true,
    });
  });

  it("fails on sha mismatch", () => {
    expect(
      evaluateDeployShaMatch(
        full,
        "d720e0cdd5c38cfe1c37575d1d91304f1af700ae",
        "ok",
      ),
    ).toEqual({ ok: false, comparable: true, reason: "sha_mismatch" });
  });

  it("fails when health is not ok", () => {
    expect(evaluateDeployShaMatch(full, full, "degraded")).toEqual({
      ok: false,
      comparable: false,
      reason: "health_not_ok",
      status: "degraded",
    });
  });

  it("skips compare for dev builds", () => {
    expect(evaluateDeployShaMatch(full, "dev", "ok")).toEqual({
      ok: true,
      comparable: false,
      reason: "dev_build",
    });
  });
});
