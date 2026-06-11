import { describe, expect, it } from "vitest";
import { parseZohoCommitResponseIds } from "@/lib/zoho/production-output-source-allocations";

const FIX_RELAX_BUNDLE_ID = "5254962000006741002";

const fixRelaxAssemblyOnlySuccess = {
  committed: true,
  partial_failure: false,
  human_review_required: false,
  commit_sequence_policy: "assembly_only",
  planned_commit_sequence: ["unit_assembly"],
  steps: [
    {
      step: "unit_assembly",
      status: "succeeded",
      zoho_entity_id: FIX_RELAX_BUNDLE_ID,
      zoho_entity_type: "bundle",
    },
  ],
};

describe("parseZohoCommitResponseIds", () => {
  it("parses FIX Relax bundle id from steps[]", () => {
    const parsed = parseZohoCommitResponseIds(fixRelaxAssemblyOnlySuccess);
    expect(parsed.bundleIds).toEqual([FIX_RELAX_BUNDLE_ID]);
    expect(parsed.receiveId).toBeNull();
    expect(parsed.partialFailure).toBe(false);
    expect(parsed.humanReviewRequired).toBe(false);
  });

  it("ignores non-bundle steps for zoho_bundle_ids", () => {
    const parsed = parseZohoCommitResponseIds({
      steps: [
        {
          step: "receive",
          status: "skipped",
          zoho_entity_id: "5254962000006735004",
          zoho_entity_type: "purchase_receive",
        },
        {
          step: "unit_assembly",
          status: "succeeded",
          zoho_entity_id: FIX_RELAX_BUNDLE_ID,
          zoho_entity_type: "bundle",
        },
      ],
    });
    expect(parsed.bundleIds).toEqual([FIX_RELAX_BUNDLE_ID]);
    expect(parsed.receiveId).toBe("5254962000006735004");
  });

  it("does not treat failed bundle steps as bundle ids", () => {
    const parsed = parseZohoCommitResponseIds({
      steps: [
        {
          step: "unit_assembly",
          status: "failed",
          zoho_entity_id: FIX_RELAX_BUNDLE_ID,
          zoho_entity_type: "bundle",
        },
      ],
    });
    expect(parsed.bundleIds).toEqual([]);
  });

  it("assembly-only success has no receive id when receive step absent", () => {
    const parsed = parseZohoCommitResponseIds(fixRelaxAssemblyOnlySuccess);
    expect(parsed.receiveId).toBeNull();
  });

  it("dedupes bundle ids from steps and top-level fields", () => {
    const parsed = parseZohoCommitResponseIds({
      bundle_id: FIX_RELAX_BUNDLE_ID,
      steps: [
        {
          step: "unit_assembly",
          status: "succeeded",
          zoho_entity_id: FIX_RELAX_BUNDLE_ID,
          zoho_entity_type: "bundle",
        },
      ],
    });
    expect(parsed.bundleIds).toEqual([FIX_RELAX_BUNDLE_ID]);
  });
});
