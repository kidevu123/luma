import { describe, expect, it, vi } from "vitest";
import {
  assertPreviewCommitIdempotencyKeysDistinct,
  buildProductionOutputPreviewIdempotencyKeyV2,
  hashProductionOutputServicePayload,
  isZohoCommitSuccessBody,
  parseZohoGatewayErrorCode,
  shouldAttemptProductionOutputIdempotencyReplay,
} from "@/lib/zoho/production-output-idempotency";
import {
  buildLumaProductionOutputStableCommitIdempotencyKey,
} from "@/lib/zoho/luma-production-output-payload";
import { buildProductionOutputPreviewIdempotencyKey } from "@/lib/zoho/production-output-preview";
import type { ProductionOutputPreviewPayload } from "@/lib/zoho/production-output-preview";

const FIX_RELAX_LOT = "61c0ad45-dd1a-4764-b560-57291cf35022";
const SWEET_TRIP_LOT = "79c41fa1-7267-4911-9017-8565039290be";
const FIX_RELAX_BUNDLE = "5254962000006741002";
const SWEET_TRIP_BUNDLE = "5254962000006782128";

const baseServicePayload: ProductionOutputPreviewPayload = {
  purchaseorder_id: "5254962000005946455",
  purchaseorder_line_item_id: "5254962000005946461",
  quantity_good: 10,
  receive_date: "2026-06-15",
  warehouse_id: "",
  unit_composite_item_id: "5254962000006219038",
  unit_assembly_quantity: 10,
  luma_operation_id: `luma-production-output:${SWEET_TRIP_LOT}`,
  quantity_damaged: 0,
  quantity_ripped: 0,
  quantity_loose: 0,
  display_assembly_quantity: 0,
  case_assembly_quantity: 0,
  assembly_only: true,
};

describe("preview vs commit idempotency keys", () => {
  it("uses distinct stable namespaces for preview and commit", () => {
    const previewKey = buildProductionOutputPreviewIdempotencyKey(
      SWEET_TRIP_LOT,
      baseServicePayload,
    );
    const commitKey =
      buildLumaProductionOutputStableCommitIdempotencyKey(SWEET_TRIP_LOT);
    expect(previewKey).toMatch(/^luma-production-output-preview:/);
    expect(commitKey).toBe(`luma-production-output:${SWEET_TRIP_LOT}`);
    expect(previewKey).not.toBe(commitKey);
    assertPreviewCommitIdempotencyKeysDistinct(SWEET_TRIP_LOT, previewKey);
  });

  it("preview key changes when service payload mapping changes", () => {
    const first = buildProductionOutputPreviewIdempotencyKey(
      SWEET_TRIP_LOT,
      baseServicePayload,
    );
    const second = buildProductionOutputPreviewIdempotencyKey(SWEET_TRIP_LOT, {
      ...baseServicePayload,
      unit_assembly_quantity: 11,
    });
    expect(second).not.toBe(first);
  });

  it("commit key is stable per finished lot (Sweet Trip + FIX Relax regression)", () => {
    expect(
      buildLumaProductionOutputStableCommitIdempotencyKey(SWEET_TRIP_LOT),
    ).toBe("luma-production-output:79c41fa1-7267-4911-9017-8565039290be");
    expect(
      buildLumaProductionOutputStableCommitIdempotencyKey(FIX_RELAX_LOT),
    ).toBe("luma-production-output:61c0ad45-dd1a-4764-b560-57291cf35022");
  });
});

describe("gateway error parsing", () => {
  it("parses ZOHO_IDEMPOTENCY_CONFLICT from nested detail", () => {
    expect(
      parseZohoGatewayErrorCode({
        detail: {
          error: { code: "ZOHO_IDEMPOTENCY_CONFLICT" },
        },
      }),
    ).toBe("ZOHO_IDEMPOTENCY_CONFLICT");
  });

  it("detects assembly success bodies from steps[]", () => {
    expect(
      isZohoCommitSuccessBody({
        committed: true,
        steps: [
          {
            step: "unit_assembly",
            status: "succeeded",
            zoho_entity_id: SWEET_TRIP_BUNDLE,
          },
        ],
      }),
    ).toBe(true);
    expect(
      isZohoCommitSuccessBody({
        steps: [
          {
            step: "unit_assembly",
            status: "succeeded",
            zoho_entity_id: FIX_RELAX_BUNDLE,
          },
        ],
      }),
    ).toBe(true);
  });
});

describe("reconcile eligibility", () => {
  it("attempts replay on network failure", () => {
    expect(
      shouldAttemptProductionOutputIdempotencyReplay({
        ok: false,
        kind: "network",
        httpStatus: null,
        body: null,
        message: "fetch failed",
        idempotencyReplay: null,
      }),
    ).toBe(true);
  });

  it("does not replay on guard/config blocks", () => {
    expect(
      shouldAttemptProductionOutputIdempotencyReplay({
        ok: false,
        kind: "guard",
        httpStatus: null,
        body: null,
        message: "disabled",
        idempotencyReplay: null,
      }),
    ).toBe(false);
  });

  it("attempts replay on 409 idempotency conflict", () => {
    expect(
      shouldAttemptProductionOutputIdempotencyReplay({
        ok: false,
        kind: "service",
        httpStatus: 409,
        body: { detail: { error: { code: "ZOHO_IDEMPOTENCY_CONFLICT" } } },
        message: "conflict",
        idempotencyReplay: null,
      }),
    ).toBe(true);
  });
});

describe("service payload hash stability", () => {
  it("hashes identically for the same mapped service payload", () => {
    const a = hashProductionOutputServicePayload(baseServicePayload);
    const b = hashProductionOutputServicePayload({ ...baseServicePayload });
    expect(a).toBe(b);
  });

  it("V2 preview key builder matches canonical preview helper", () => {
    expect(buildProductionOutputPreviewIdempotencyKeyV2(SWEET_TRIP_LOT, baseServicePayload)).toBe(
      buildProductionOutputPreviewIdempotencyKey(SWEET_TRIP_LOT, baseServicePayload),
    );
  });
});
