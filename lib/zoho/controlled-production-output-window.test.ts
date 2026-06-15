import { describe, expect, it } from "vitest";
import {
  closeProductionOutputCommitWindow,
  openProductionOutputCommitWindow,
  withProductionOutputCommitWindow,
} from "@/lib/zoho/controlled-production-output-window";

describe("controlled production-output commit window", () => {
  it("opens commit gate and keeps bag-finish disabled", () => {
    const env: Record<string, string | undefined> = {
      ZOHO_PRODUCTION_OUTPUT_COMMIT_ENABLED: "false",
      ZOHO_BAG_FINISH_RECEIVE_COMMIT_ENABLED: "false",
      ZOHO_ALLOW_SCRIPT_COMMIT_BYPASS: "false",
    };
    openProductionOutputCommitWindow(env);
    expect(env.ZOHO_PRODUCTION_OUTPUT_COMMIT_ENABLED).toBe("true");
    expect(env.ZOHO_BAG_FINISH_RECEIVE_COMMIT_ENABLED).toBe("false");
    expect(env.ZOHO_ALLOW_SCRIPT_COMMIT_BYPASS).toBe("false");
  });

  it("closes gates in finally even when fn throws", async () => {
    const env: Record<string, string | undefined> = {
      ZOHO_PRODUCTION_OUTPUT_COMMIT_ENABLED: "false",
    };
    await expect(
      withProductionOutputCommitWindow(env, async () => {
        expect(env.ZOHO_PRODUCTION_OUTPUT_COMMIT_ENABLED).toBe("true");
        throw new Error("commit failed");
      }),
    ).rejects.toThrow("commit failed");
    expect(env.ZOHO_PRODUCTION_OUTPUT_COMMIT_ENABLED).toBe("false");
    expect(env.ZOHO_BAG_FINISH_RECEIVE_COMMIT_ENABLED).toBe("false");
  });

  it("restores prior env values after close", () => {
    const env: Record<string, string | undefined> = {
      ZOHO_PRODUCTION_OUTPUT_COMMIT_ENABLED: "maybe",
    };
    const snap = openProductionOutputCommitWindow(env);
    closeProductionOutputCommitWindow(env, snap);
    expect(env.ZOHO_PRODUCTION_OUTPUT_COMMIT_ENABLED).toBe("false");
  });
});
