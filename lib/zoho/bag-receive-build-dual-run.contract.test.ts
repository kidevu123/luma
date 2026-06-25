// Z-4 · Dual-run equivalence: Luma local builder vs service /bag-receive/build.
//
// Two layers:
//   1. DETERMINISTIC — compares Luma's real builder/freeze outputs against a
//      fixture that encodes the S-1 *documented* build contract (including the
//      known mismatches the brief enumerated). No network, runs in CI.
//   2. LIVE (env-gated) — calls the real service build endpoint and runs the
//      same diff. SKIPPED unless ZOHO_SERVICE_BEARER_SECRET (+ base URL) are
//      present, so it never fakes equivalence and never flakes in CI.
//
// No runtime preview/commit/freeze behavior is touched. Luma's two
// idempotency namespaces are NOT collapsed; mismatches are recorded, not fixed.

import { describe, expect, it } from "vitest";
import { readRepoSource } from "@/lib/test/source-scan";
import {
  buildBagFinishReceivePayload,
  type BagFinishReceiveBuildInput,
} from "./bag-finish-receive";
import { buildBagFinishReceiveIdempotencyKey } from "./source-receipt-evidence";
import { buildRawBagCommitIdempotencyKey } from "./shared-raw-bag-receive-commit";
import { buildRawBagReceiveNotes } from "./zoho-commit-notes";
import {
  bagFinishReceiveBuildInputToDomainRequest,
  buildBagReceiveBuildRequestBody,
  callBagReceiveBuildService,
  diffBagReceiveBuild,
  parseBagReceiveBuildResponse,
  type BagReceiveBuildServiceResponse,
  type LumaBagReceiveBuildSnapshot,
  type ProposedBagReceiveDomainRequest,
} from "./bag-receive-build-service-client";
import { validateAssemblyServiceConfig } from "./assembly-service-client";

const BAG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OP_ID = "11111111-1111-4111-8111-111111111111";

const CANONICAL_BUILD_INPUT: BagFinishReceiveBuildInput = {
  inventoryBagId: BAG_A,
  lumaReceiveId: "recv-1",
  internalReceiptNumber: "352176",
  humanLotNumber: "152-000166",
  receivedQuantity: 7219,
  quantitySource: "declared_pill_count",
  zohoPoId: "5254962000000123456",
  zohoLineItemId: "5254962000000123457",
  zohoTabletItemId: "5254962000004758398",
  receiveDate: "2026-06-09",
  siblingBagsOnPoLine: 2,
};

// ─── Luma snapshot (real function outputs) ─────────────────────────────────

function buildLumaSnapshot(
  input: BagFinishReceiveBuildInput,
): LumaBagReceiveBuildSnapshot {
  const domain = bagFinishReceiveBuildInputToDomainRequest(input);
  const previewIdempotencyKey = buildBagFinishReceiveIdempotencyKey(
    input.inventoryBagId,
  );
  const commitIdempotencyKey = buildRawBagCommitIdempotencyKey({
    opId: OP_ID,
    zohoPoId: input.zohoPoId,
    zohoLineItemId: input.zohoLineItemId,
    receivedQuantity: input.receivedQuantity,
    receiveDate: input.receiveDate,
  });
  const notes = buildRawBagReceiveNotes({
    lumaOperationId: OP_ID,
    lumaReceiveId: input.lumaReceiveId,
    internalReceiptNumber: input.internalReceiptNumber,
    receivedQuantity: input.receivedQuantity,
    receiveDate: input.receiveDate,
    tabletType: "Choco Drift",
  });
  return {
    domain,
    previewIdempotencyKey,
    commitIdempotencyKey,
    receiveIdempotencyKey: previewIdempotencyKey,
    notes,
  };
}

// ─── Documented S-2 service fixture ────────────────────────────────────────
//
// Faithful encoding of the build contract after service S-2:
//   - normalized_request echoes the domain request values
//   - preview key is ECHOED from the request's optional
//     preview_idempotency_key when supplied (S-2). When omitted, the
//     service falls back to its own luma-bag-receive-preview:<receive>.
//   - notes still include luma_receive_id + quantity_source (UNCHANGED
//     by S-2 — different from Luma; recorded as a remaining mismatch)
//   - commit/receive keys UNCHANGED by S-2 (service per-receive)
//   - internal_receipt_number is allowed to be null
// The exact Zoho payload structure + commit/receive key formats are only
// fully knowable from a live capture; placeholders are clearly marked.

function buildDocumentedServiceFixture(
  domain: ProposedBagReceiveDomainRequest,
  opts?: { suppliedPreviewKey?: string },
): BagReceiveBuildServiceResponse {
  const previewKey =
    opts?.suppliedPreviewKey ?? `luma-bag-receive-preview:${domain.luma_receive_id}`;
  return {
    zoho_purchase_receive_payload: {
      purchaseorder_id: domain.zoho_purchaseorder_id,
      line_items: [
        {
          line_item_id: domain.zoho_purchaseorder_line_item_id,
          item_id: domain.zoho_raw_item_id,
          quantity: domain.received_quantity,
        },
      ],
      date: domain.receive_date,
      notes: `luma_receive_id: ${domain.luma_receive_id}\nquantity_source: ${domain.quantity_source}`,
    },
    // S-2: service echoes the supplied preview key verbatim.
    preview_idempotency_key: previewKey,
    commit_idempotency_key: `luma-bag-receive-commit:${domain.luma_receive_id}`,
    receive_idempotency_key: `luma-bag-receive:${domain.inventory_bag_id}`,
    normalized_request: { ...domain },
    blockers: [],
    warnings: [],
    meta: { capability: "luma.raw_intake.build", read_only: true },
  };
}

// ─── Mapper unit ───────────────────────────────────────────────────────────

describe("Z-4 · domain request mapper", () => {
  it("maps every BagFinishReceiveBuildInput field to the domain request", () => {
    const domain = bagFinishReceiveBuildInputToDomainRequest(CANONICAL_BUILD_INPUT);
    expect(domain).toEqual({
      inventory_bag_id: BAG_A,
      luma_receive_id: "recv-1",
      internal_receipt_number: "352176",
      human_lot_number: "152-000166",
      received_quantity: 7219,
      quantity_source: "declared_pill_count",
      receive_date: "2026-06-09",
      zoho_purchaseorder_id: "5254962000000123456",
      zoho_purchaseorder_line_item_id: "5254962000000123457",
      zoho_raw_item_id: "5254962000004758398",
    });
  });

  it("preserves nullable internal_receipt_number and human_lot_number", () => {
    const domain = bagFinishReceiveBuildInputToDomainRequest({
      ...CANONICAL_BUILD_INPUT,
      internalReceiptNumber: null,
      humanLotNumber: null,
    });
    expect(domain.internal_receipt_number).toBeNull();
    expect(domain.human_lot_number).toBeNull();
  });
});

// ─── Deterministic dual-run (fixture = documented S-1 contract) ─────────────

describe("Z-5 · dual-run vs documented S-2 build contract", () => {
  const luma = buildLumaSnapshot(CANONICAL_BUILD_INPUT);
  // Luma now supplies its per-bag preview key; S-2 echoes it verbatim.
  const requestBody = buildBagReceiveBuildRequestBody(luma.domain);
  const service = buildDocumentedServiceFixture(luma.domain, {
    suppliedPreviewKey: requestBody.preview_idempotency_key,
  });
  const diff = diffBagReceiveBuild(luma, service);

  it("service normalized_request echoes every Luma domain value (core MATCH)", () => {
    expect(diff.normalizedRequestMatches).toBe(true);
    for (const fd of diff.normalizedRequestFieldDiffs) {
      expect(fd.equal, `field ${fd.field} mismatch`).toBe(true);
    }
  });

  it("core Zoho purchase receive values agree (PO / line / item / qty / date)", () => {
    const payload = service.zoho_purchase_receive_payload;
    expect(payload.purchaseorder_id).toBe(luma.domain.zoho_purchaseorder_id);
    const lineItems = payload.line_items as Array<Record<string, unknown>>;
    expect(lineItems[0]?.line_item_id).toBe(
      luma.domain.zoho_purchaseorder_line_item_id,
    );
    expect(lineItems[0]?.item_id).toBe(luma.domain.zoho_raw_item_id);
    expect(lineItems[0]?.quantity).toBe(luma.domain.received_quantity);
    expect(payload.date).toBe(luma.domain.receive_date);
  });

  it("M1 RESOLVED — preview idempotency key now MATCHES exactly (S-2 echo)", () => {
    expect(diff.previewKey.equal).toBe(true);
    expect(diff.previewKey.luma).toBe(`luma-bag-finish-receive:${BAG_A}`);
    expect(diff.previewKey.service).toBe(`luma-bag-finish-receive:${BAG_A}`);
  });

  it("the request body carries Luma's per-bag preview key (no namespace collapse)", () => {
    expect(requestBody.preview_idempotency_key).toBe(
      `luma-bag-finish-receive:${BAG_A}`,
    );
    // Domain fields are unchanged by adding the preview key.
    expect(requestBody.inventory_bag_id).toBe(BAG_A);
    expect(requestBody.zoho_purchaseorder_id).toBe(luma.domain.zoho_purchaseorder_id);
  });

  it("M2 STILL OPEN — commit idempotency key DIFFERS (Luma rbg-* stays local)", () => {
    expect(diff.commitKey.equal).toBe(false);
    expect(diff.commitKey.luma).toMatch(/^rbg-[0-9a-f]{32}$/);
  });

  it("M3 STILL OPEN — receive/source-receipt key DIFFERS (stays Luma-owned)", () => {
    expect(diff.receiveKey.equal).toBe(false);
    expect(diff.receiveKey.luma).toBe(`luma-bag-finish-receive:${BAG_A}`);
  });

  it("M4 STILL OPEN — notes format DIFFERS (unchanged by S-2; approval-gated)", () => {
    expect(diff.notesEqual).toBe(false);
    expect(luma.notes).toContain("Luma op:");
    expect(luma.notes).toContain("Internal receipt #: 352176");
    const serviceNotes = service.zoho_purchase_receive_payload.notes as string;
    expect(serviceNotes).toContain("luma_receive_id:");
    expect(serviceNotes).toContain("quantity_source:");
  });

  it("happy-path build returns no blockers or warnings", () => {
    expect(service.blockers).toEqual([]);
    expect(service.warnings).toEqual([]);
  });

  it("preview payload (Luma builder) carries core values matching the service", () => {
    const previewPayload = buildBagFinishReceivePayload(CANONICAL_BUILD_INPUT);
    expect(previewPayload.purchaseorder_id).toBe(
      service.zoho_purchase_receive_payload.purchaseorder_id,
    );
    expect(previewPayload.raw_item_id).toBe(luma.domain.zoho_raw_item_id);
    expect(previewPayload.received_quantity).toBe(luma.domain.received_quantity);
    expect(previewPayload.receive_date).toBe(luma.domain.receive_date);
    // Luma's preview payload idempotency_key equals the echoed service key.
    expect(previewPayload.idempotency_key).toBe(service.preview_idempotency_key);
  });

  it("without a supplied preview key, S-2 still falls back to its own namespace (regression guard)", () => {
    const fallback = buildDocumentedServiceFixture(luma.domain);
    const fallbackDiff = diffBagReceiveBuild(luma, fallback);
    expect(fallbackDiff.previewKey.equal).toBe(false);
    expect(fallback.preview_idempotency_key).toBe("luma-bag-receive-preview:recv-1");
  });
});

// ─── Response parser ───────────────────────────────────────────────────────

describe("Z-4 · build response parser", () => {
  it("parses a well-formed body (top-level or under data)", () => {
    const fixture = buildDocumentedServiceFixture(
      bagFinishReceiveBuildInputToDomainRequest(CANONICAL_BUILD_INPUT),
    );
    expect(parseBagReceiveBuildResponse(fixture)).not.toBeNull();
    expect(parseBagReceiveBuildResponse({ data: fixture })).not.toBeNull();
  });

  it("returns null when required keys are missing", () => {
    expect(parseBagReceiveBuildResponse(null)).toBeNull();
    expect(parseBagReceiveBuildResponse({})).toBeNull();
    expect(
      parseBagReceiveBuildResponse({ preview_idempotency_key: "x" }),
    ).toBeNull();
  });
});

// ─── Isolation guards ──────────────────────────────────────────────────────

describe("Z-4 · build client isolation", () => {
  it("is not imported by any runtime preview/commit/freeze module", () => {
    const runtimeModules = [
      "lib/zoho/bag-finish-receive.ts",
      "lib/zoho/raw-bag-intake-receive.ts",
      "lib/zoho/freeze-raw-bag-receive-payload.ts",
      "lib/zoho/shared-raw-bag-receive-commit.ts",
      "lib/zoho/auto-commit-sweep.ts",
    ];
    for (const mod of runtimeModules) {
      const src = readRepoSource(mod);
      expect(
        src.includes("bag-receive-build-service-client"),
        `${mod} must not import the Z-4 build client`,
      ).toBe(false);
    }
  });

  it("build client makes no direct Zoho calls and does no DB/audit work", () => {
    const src = readRepoSource("lib/zoho/bag-receive-build-service-client.ts");
    expect(src).not.toMatch(/zohoapis\.com/);
    expect(src).not.toMatch(/Zoho-oauthtoken/);
    expect(src).not.toMatch(/@\/lib\/db\b/);
    expect(src).not.toMatch(/writeAudit/);
  });

  it("build client targets the read-only build path", () => {
    const src = readRepoSource("lib/zoho/bag-receive-build-service-client.ts");
    expect(src).toMatch(/\/zoho\/luma\/bag-receive\/build/);
    expect(src).toMatch(/luma\.raw_intake\.build/);
  });
});

// ─── Live dual-run (env-gated; skipped without credentials) ─────────────────

function liveCredsPresent(): boolean {
  return validateAssemblyServiceConfig(process.env).ok;
}

describe("Z-4 · live dual-run (env-gated)", () => {
  it.skipIf(!liveCredsPresent())(
    "service build response matches Luma domain values for canonical input",
    async () => {
      const luma = buildLumaSnapshot(CANONICAL_BUILD_INPUT);
      const result = await callBagReceiveBuildService(luma.domain);
      expect(result.ok, result.ok ? "" : (result as { message: string }).message).toBe(
        true,
      );
      if (!result.ok) return;
      const parsed = parseBagReceiveBuildResponse(result.body);
      expect(parsed, "service build response did not parse").not.toBeNull();
      if (!parsed) return;
      const diff = diffBagReceiveBuild(luma, parsed);
      // Core domain values MUST match for migration to be viable.
      expect(
        diff.normalizedRequestMatches,
        `normalized_request mismatches: ${JSON.stringify(
          diff.normalizedRequestFieldDiffs.filter((d) => !d.equal),
        )}`,
      ).toBe(true);
      // S-2: the supplied preview key must be echoed verbatim (M1 resolved).
      expect(
        diff.previewKey.equal,
        `preview key not echoed: luma=${diff.previewKey.luma} service=${diff.previewKey.service}`,
      ).toBe(true);
    },
  );
});
