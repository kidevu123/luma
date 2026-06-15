import { describe, expect, it } from "vitest";
import {
  assertStagingPilotApproved,
  withPilotProductionOutputCommitWindow,
} from "@/lib/zoho/pilot-production-output-commit-window";

describe("pilot production-output commit window", () => {
  it("refuses without ALLOW_STAGING_QA_DATA", () => {
    expect(() => assertStagingPilotApproved("test", {})).toThrow(
      /ALLOW_STAGING_QA_DATA/,
    );
  });

  it("refuses when bag-finish gate is open", () => {
    expect(() =>
      assertStagingPilotApproved("test", {
        ALLOW_STAGING_QA_DATA: "true",
        ZOHO_BAG_FINISH_RECEIVE_COMMIT_ENABLED: "true",
      }),
    ).toThrow(/BAG_FINISH/);
  });

  it("closes production-output gate after pilot fn throws", async () => {
    const env: Record<string, string | undefined> = {
      ALLOW_STAGING_QA_DATA: "true",
      ZOHO_PRODUCTION_OUTPUT_COMMIT_ENABLED: "false",
      ZOHO_BAG_FINISH_RECEIVE_COMMIT_ENABLED: "false",
      ZOHO_ALLOW_SCRIPT_COMMIT_BYPASS: "false",
    };
    const prior = process.env;
    process.env = env as NodeJS.ProcessEnv;
    try {
      await expect(
        withPilotProductionOutputCommitWindow("test", async () => {
          expect(env.ZOHO_PRODUCTION_OUTPUT_COMMIT_ENABLED).toBe("true");
          throw new Error("validation failed");
        }),
      ).rejects.toThrow("validation failed");
      expect(env.ZOHO_PRODUCTION_OUTPUT_COMMIT_ENABLED).toBe("false");
    } finally {
      process.env = prior;
    }
  });
});
