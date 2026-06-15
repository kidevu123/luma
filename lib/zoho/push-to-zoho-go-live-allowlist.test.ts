import { describe, expect, it } from "vitest";
import { isBagFinishReceiveCommitEnabled } from "@/lib/zoho/bag-finish-receive-client";
import { isProductionOutputCommitEnabled } from "@/lib/zoho/production-output-config";
import { buildLumaProductionOutputStableCommitIdempotencyKey } from "@/lib/zoho/luma-production-output-payload";
import { buildRawBagReceiveIdempotencyKey } from "@/lib/zoho/source-receipt-evidence";
import {
  FIX_RELAX_FINISHED_LOT_ID,
  FIX_RELAX_SOURCE_BAG_ID,
} from "@/lib/zoho/v1206-fix-relax-pilot-contract";
import {
  SWEET_TRIP_SOURCE_BAG_ID,
} from "@/lib/zoho/v1206-sweet-trip-pilot-contract";

const SWEET_TRIP_FINISHED_LOT_ID = "79c41fa1-7267-4911-9017-8565039290be";
import {
  isProductIdApprovedForLiveZohoCommit,
  PUSH_TO_ZOHO_APPROVED_SKUS,
} from "@/lib/zoho/push-to-zoho-go-live-allowlist";

describe("Push to Zoho go-live allowlist", () => {
  it("lists exactly FIX Relax and Sweet Trip for day 1", () => {
    expect(PUSH_TO_ZOHO_APPROVED_SKUS).toHaveLength(2);
    expect(PUSH_TO_ZOHO_APPROVED_SKUS.map((s) => s.displayName)).toEqual([
      "FIX Relax 1ct",
      "Hyroxi MIT B - Sweet Trip",
    ]);
  });

  it("recognizes approved product IDs only", () => {
    expect(
      isProductIdApprovedForLiveZohoCommit("95c61efe-a36a-44df-8fee-8e66d659ed80"),
    ).toBe(true);
    expect(
      isProductIdApprovedForLiveZohoCommit("510ab906-32b9-4082-b678-5d35ced9c4b8"),
    ).toBe(true);
    expect(isProductIdApprovedForLiveZohoCommit("00000000-0000-4000-8000-000000000099")).toBe(
      false,
    );
  });
});

describe("Dry-run launch simulation (gates closed)", () => {
  const closedEnv = {
    ZOHO_BAG_FINISH_RECEIVE_COMMIT_ENABLED: "false",
    ZOHO_PRODUCTION_OUTPUT_COMMIT_ENABLED: "false",
    ZOHO_ALLOW_SCRIPT_COMMIT_BYPASS: "false",
  };

  it("blocks bag receive commit when Luma gate is closed", () => {
    expect(isBagFinishReceiveCommitEnabled(closedEnv)).toBe(false);
  });

  it("blocks production-output commit when Luma gate is closed", () => {
    expect(isProductionOutputCommitEnabled(closedEnv)).toBe(false);
  });

  it("uses stable idempotency keys for approved SKU pilot bags and lots", () => {
    expect(buildRawBagReceiveIdempotencyKey(FIX_RELAX_SOURCE_BAG_ID)).toBe(
      `luma-bag-finish-receive:${FIX_RELAX_SOURCE_BAG_ID}`,
    );
    expect(buildRawBagReceiveIdempotencyKey(SWEET_TRIP_SOURCE_BAG_ID)).toBe(
      `luma-bag-finish-receive:${SWEET_TRIP_SOURCE_BAG_ID}`,
    );
    expect(buildLumaProductionOutputStableCommitIdempotencyKey(FIX_RELAX_FINISHED_LOT_ID)).toBe(
      `luma-production-output:${FIX_RELAX_FINISHED_LOT_ID}`,
    );
    expect(
      buildLumaProductionOutputStableCommitIdempotencyKey(SWEET_TRIP_FINISHED_LOT_ID),
    ).toBe(`luma-production-output:${SWEET_TRIP_FINISHED_LOT_ID}`);
  });
});
