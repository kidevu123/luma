import { describe, expect, it } from "vitest";
import {
  deriveProductionOutputUiCommitState,
  productionOutputUiCommitStateLabel,
} from "@/lib/zoho/production-output-ui-state";

const FIX_RELAX_OP = "f0256ebc-5f3c-4d54-aff8-3e76228a3847";
const SWEET_TRIP_OP = "7bef5edc-2010-4834-815c-8fcc999e4945";

describe("deriveProductionOutputUiCommitState", () => {
  it("maps READY to READY_TO_COMMIT", () => {
    expect(
      deriveProductionOutputUiCommitState({
        status: "READY",
        previewStatus: "ready",
        commitStatus: null,
        commitError: null,
        commitResponse: null,
        zohoBundleIds: [],
        humanReviewRequired: false,
        partialFailure: false,
        voidedAt: null,
      }),
    ).toBe("READY_TO_COMMIT");
  });

  it("maps COMMITTING to COMMIT_IN_PROGRESS", () => {
    expect(
      deriveProductionOutputUiCommitState({
        status: "COMMITTING",
        previewStatus: "ready",
        commitStatus: null,
        commitError: null,
        commitResponse: null,
        zohoBundleIds: [],
        humanReviewRequired: false,
        partialFailure: false,
        voidedAt: null,
      }),
    ).toBe("COMMIT_IN_PROGRESS");
  });

  it("never shows plain FAILED when bundle proof exists (Sweet Trip regression shape)", () => {
    const state = deriveProductionOutputUiCommitState({
      status: "FAILED",
      previewStatus: "ready",
      commitStatus: "failed",
      commitError: "HTTP 409",
      commitResponse: {
        steps: [
          {
            step: "unit_assembly",
            status: "succeeded",
            zoho_entity_id: "5254962000006782128",
          },
        ],
      },
      zohoBundleIds: ["5254962000006782128"],
      humanReviewRequired: false,
      partialFailure: false,
      voidedAt: null,
    });
    expect(state).toBe("COMMITTED_IN_ZOHO_NEEDS_LUMA_RECONCILE");
    expect(productionOutputUiCommitStateLabel(state)).toContain("needs Luma reconcile");
  });

  it("FIX Relax committed op maps to COMMITTED", () => {
    expect(
      deriveProductionOutputUiCommitState({
        status: "COMMITTED",
        previewStatus: "ready",
        commitStatus: "committed",
        commitError: null,
        commitResponse: {
          steps: [
            {
              step: "unit_assembly",
              status: "succeeded",
              zoho_entity_id: "5254962000006741002",
            },
          ],
        },
        zohoBundleIds: ["5254962000006741002"],
        humanReviewRequired: false,
        partialFailure: false,
        voidedAt: null,
      }),
    ).toBe("COMMITTED");
  });

  it("ambiguous commit maps to COMMIT_AMBIGUOUS_NEEDS_REVIEW", () => {
    expect(
      deriveProductionOutputUiCommitState({
        status: "FAILED",
        previewStatus: "ready",
        commitStatus: "ambiguous_needs_review",
        commitError: "unknown write status",
        commitResponse: {
          detail: { error: { code: "ZOHO_TIMEOUT_UNKNOWN_WRITE_STATUS" } },
        },
        zohoBundleIds: [],
        humanReviewRequired: true,
        partialFailure: false,
        voidedAt: null,
      }),
    ).toBe("COMMIT_AMBIGUOUS_NEEDS_REVIEW");
  });
});

describe("pilot op ids (documentation anchors)", () => {
  it("FIX Relax + Sweet Trip op ids unchanged", () => {
    expect(FIX_RELAX_OP).toBe("f0256ebc-5f3c-4d54-aff8-3e76228a3847");
    expect(SWEET_TRIP_OP).toBe("7bef5edc-2010-4834-815c-8fcc999e4945");
  });
});
