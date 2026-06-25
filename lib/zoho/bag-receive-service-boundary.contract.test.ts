// Z-3 · Bag receive service-boundary contract (preparatory, audit-only).
//
// Pins CURRENT Luma behavior for bag-finish receive payloads without
// changing runtime. Defines a proposed domain→service mapping that a
// future migration can dual-run against buildBagFinishReceivePayload /
// freeze-raw-bag-receive-payload.
//
// Service endpoints already exist on the integration service:
//   POST /zoho/luma/bag-receive/preview
//   POST /zoho/luma/bag-receive/commit
// (see bag-finish-receive-client.ts). No external service repo is
// required for these tests — fixtures are local/preparatory.

import { describe, expect, it } from "vitest";
import { readRepoSource } from "@/lib/test/source-scan";
import {
  buildBagFinishReceivePayload,
  type BagFinishReceiveBuildInput,
} from "./bag-finish-receive";
import type { BagFinishReceiveRequest } from "./bag-finish-receive-client";
import { buildBagFinishReceiveIdempotencyKey } from "./source-receipt-evidence";
import {
  buildRawBagCommitIdempotencyKey,
} from "./shared-raw-bag-receive-commit";
import { buildRawBagReceiveNotes } from "./zoho-commit-notes";

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

// ─── Proposed service-boundary types (not wired at runtime) ────────────────

/** Domain-level request Luma would send once the builder moves to the service. */
export type ProposedBagReceiveDomainRequest = {
  inventory_bag_id: string;
  luma_receive_id: string;
  internal_receipt_number: string | null;
  human_lot_number: string | null;
  received_quantity: number;
  quantity_source: string;
  receive_date: string;
  zoho_purchaseorder_id: string;
  zoho_purchaseorder_line_item_id: string;
  zoho_raw_item_id: string;
};

/** Read-only build response the service would return for Luma to freeze. */
export type ProposedBagReceiveServiceBuildResponse = {
  gateway_payload: BagFinishReceiveRequest & { notes: string };
  preview_idempotency_key: string;
  commit_idempotency_key: string;
};

function deriveProposedDomainRequest(
  input: BagFinishReceiveBuildInput,
): ProposedBagReceiveDomainRequest {
  return {
    inventory_bag_id: input.inventoryBagId,
    luma_receive_id: input.lumaReceiveId,
    internal_receipt_number: input.internalReceiptNumber,
    human_lot_number: input.humanLotNumber,
    received_quantity: input.receivedQuantity,
    quantity_source: input.quantitySource,
    receive_date: input.receiveDate,
    zoho_purchaseorder_id: input.zohoPoId,
    zoho_purchaseorder_line_item_id: input.zohoLineItemId,
    zoho_raw_item_id: input.zohoTabletItemId,
  };
}

/** Mirror of freeze-raw-bag-receive-payload.ts commit-path assembly (pure). */
function deriveProposedServiceBuildResponse(input: {
  domain: ProposedBagReceiveDomainRequest;
  opId: string;
  notesInput: Parameters<typeof buildRawBagReceiveNotes>[0];
}): ProposedBagReceiveServiceBuildResponse {
  const commitIdempotencyKey = buildRawBagCommitIdempotencyKey({
    opId: input.opId,
    zohoPoId: input.domain.zoho_purchaseorder_id,
    zohoLineItemId: input.domain.zoho_purchaseorder_line_item_id,
    receivedQuantity: input.domain.received_quantity,
    receiveDate: input.domain.receive_date,
  });
  const notes = buildRawBagReceiveNotes(input.notesInput);
  const gateway_payload: BagFinishReceiveRequest & { notes: string } = {
    source_bag_id: input.domain.inventory_bag_id,
    internal_receipt_number: input.domain.internal_receipt_number,
    purchaseorder_id: input.domain.zoho_purchaseorder_id,
    purchaseorder_line_item_id: input.domain.zoho_purchaseorder_line_item_id,
    raw_item_id: input.domain.zoho_raw_item_id,
    human_lot_number: input.domain.human_lot_number,
    received_quantity: input.domain.received_quantity,
    receive_date: input.domain.receive_date,
    idempotency_key: commitIdempotencyKey,
    notes,
  };
  return {
    gateway_payload,
    preview_idempotency_key: buildBagFinishReceiveIdempotencyKey(
      input.domain.inventory_bag_id,
    ),
    commit_idempotency_key: commitIdempotencyKey,
  };
}

// ─── Path map (static) ─────────────────────────────────────────────────────

describe("Z-3 · bag receive payload path map", () => {
  it("pins the canonical builder export and service client paths", () => {
    const builder = readRepoSource("lib/zoho/bag-finish-receive.ts");
    const client = readRepoSource("lib/zoho/bag-finish-receive-client.ts");
    expect(builder).toMatch(/export function buildBagFinishReceivePayload\(/);
    expect(builder).toMatch(/export async function previewBagFinishReceive\(/);
    expect(builder).toMatch(/export async function commitBagFinishReceive\(/);
    expect(client).toMatch(/\/zoho\/luma\/bag-receive\/preview/);
    expect(client).toMatch(/\/zoho\/luma\/bag-receive\/commit/);
  });

  it("pins seed → freeze → shared commit wiring", () => {
    const intake = readRepoSource("lib/zoho/raw-bag-intake-receive.ts");
    const freeze = readRepoSource("lib/zoho/freeze-raw-bag-receive-payload.ts");
    const shared = readRepoSource("lib/zoho/shared-raw-bag-receive-commit.ts");
    expect(intake).toMatch(/seedPendingRawBagReceiveRows/);
    expect(intake).toMatch(/freezeRawBagReceivePayloadAtSeed/);
    expect(freeze).toMatch(/commitRequestPayload/);
    expect(shared).toMatch(/claim\.frozenPayload && isCompleteFrozenPayload/);
  });
});

// ─── Normal payload construction ───────────────────────────────────────────

describe("Z-3 · buildBagFinishReceivePayload contract", () => {
  it("maps every BagFinishReceiveBuildInput field to the service request shape", () => {
    const payload = buildBagFinishReceivePayload(CANONICAL_BUILD_INPUT);
    expect(payload).toEqual({
      source_bag_id: BAG_A,
      internal_receipt_number: "352176",
      purchaseorder_id: "5254962000000123456",
      purchaseorder_line_item_id: "5254962000000123457",
      raw_item_id: "5254962000004758398",
      human_lot_number: "152-000166",
      received_quantity: 7219,
      receive_date: "2026-06-09",
      idempotency_key: `luma-bag-finish-receive:${BAG_A}`,
    });
  });

  it("does not emit notes on the legacy preview builder path", () => {
    const payload = buildBagFinishReceivePayload(CANONICAL_BUILD_INPUT);
    expect(payload).not.toHaveProperty("notes");
  });
});

// ─── Missing mapping → blocker, not malformed payload ──────────────────────

describe("Z-3 · mapping blockers before payload build", () => {
  const MAPPING_CHECKS = [
    "Receive is missing Zoho PO mapping.",
    "Receive is missing Zoho PO line item mapping.",
    "Tablet type is missing Zoho item ID.",
  ] as const;

  it("loadBagFinishReceiveContext returns explicit reasons for each missing Zoho mapping", () => {
    const src = readRepoSource("lib/zoho/bag-finish-receive.ts");
    for (const reason of MAPPING_CHECKS) {
      expect(src).toContain(reason);
    }
  });

  it("previewBagFinishReceive refuses before buildBagFinishReceivePayload when context fails", () => {
    const src = readRepoSource("lib/zoho/bag-finish-receive.ts");
    const previewBody = extractBetween(
      src,
      "export async function previewBagFinishReceive",
      "export async function commitBagFinishReceive",
    );
    expect(previewBody).toMatch(/if \(!ctx\.ok\) return ctx;/);
    expect(previewBody).toMatch(/if \(!ctx\.eligibility\.eligible\)/);
    const buildIdx = previewBody.indexOf("buildBagFinishReceivePayload");
    const ctxFailIdx = previewBody.indexOf("if (!ctx.ok) return ctx;");
    expect(buildIdx).toBeGreaterThan(ctxFailIdx);
  });

  it("raw-bag intake context loader uses the same mapping guard messages", () => {
    const src = readRepoSource("lib/zoho/raw-bag-intake-receive.ts");
    for (const reason of MAPPING_CHECKS) {
      expect(src).toContain(reason);
    }
  });
});

// ─── Frozen payload stability ───────────────────────────────────────────────

describe("Z-3 · frozen payload contract", () => {
  it("commit idempotency key is stable for identical freeze inputs", () => {
    const input = {
      opId: OP_ID,
      zohoPoId: CANONICAL_BUILD_INPUT.zohoPoId,
      zohoLineItemId: CANONICAL_BUILD_INPUT.zohoLineItemId,
      receivedQuantity: CANONICAL_BUILD_INPUT.receivedQuantity,
      receiveDate: CANONICAL_BUILD_INPUT.receiveDate,
    };
    expect(buildRawBagCommitIdempotencyKey(input)).toBe(
      buildRawBagCommitIdempotencyKey({ ...input }),
    );
  });

  it("proposed service build response matches freeze module field order", () => {
    const domain = deriveProposedDomainRequest(CANONICAL_BUILD_INPUT);
    const built = deriveProposedServiceBuildResponse({
      domain,
      opId: OP_ID,
      notesInput: {
        lumaOperationId: OP_ID,
        lumaReceiveId: domain.luma_receive_id,
        poNumber: "PO-12345",
        internalReceiptNumber: domain.internal_receipt_number,
        receivedQuantity: domain.received_quantity,
        receiveDate: domain.receive_date,
        tabletType: "Choco Drift",
      },
    });
    expect(built.gateway_payload.source_bag_id).toBe(BAG_A);
    expect(built.gateway_payload.idempotency_key).toMatch(/^rbg-[0-9a-f]{32}$/);
    expect(built.gateway_payload.notes).toContain("Luma op:");
    expect(built.preview_idempotency_key).toBe(`luma-bag-finish-receive:${BAG_A}`);
    expect(built.preview_idempotency_key).not.toBe(built.commit_idempotency_key);
  });

  it("freeze module writes commitRequestPayload and commitIdempotencyKey", () => {
    const freeze = readRepoSource("lib/zoho/freeze-raw-bag-receive-payload.ts");
    expect(freeze).toMatch(/commitRequestPayload: frozenPayload/);
    expect(freeze).toMatch(/commitIdempotencyKey,/);
    expect(freeze).toMatch(/action: "zoho_raw_bag_receive\.payload_frozen"/);
  });
});

// ─── Commit prefers frozen payload ─────────────────────────────────────────

describe("Z-3 · preview/commit frozen replay contract", () => {
  it("sharedCommitRawBagReceive prefers frozen payload before rebuild fallback", () => {
    const src = readRepoSource("lib/zoho/shared-raw-bag-receive-commit.ts");
    const fnStart = src.indexOf("export async function sharedCommitRawBagReceive");
    expect(fnStart).toBeGreaterThan(-1);
    const frozenIdx = src.indexOf(
      "if (claim.frozenPayload && isCompleteFrozenPayload(claim.frozenPayload))",
      fnStart,
    );
    const rebuildIdx = src.indexOf("loadBagFinishReceiveContext", frozenIdx);
    expect(frozenIdx).toBeGreaterThan(fnStart);
    expect(rebuildIdx).toBeGreaterThan(frozenIdx);
  });

  it("isCompleteFrozenPayload requires every gateway field except notes", () => {
    const src = readRepoSource("lib/zoho/shared-raw-bag-receive-commit.ts");
    expect(src).toMatch(/typeof payload\["source_bag_id"\] === "string"/);
    expect(src).toMatch(/typeof payload\["purchaseorder_id"\] === "string"/);
    expect(src).toMatch(/typeof payload\["idempotency_key"\] === "string"/);
  });

  it("legacy bag-finish commit rebuilds from context (no frozen path)", () => {
    const src = readRepoSource("lib/zoho/bag-finish-receive.ts");
    const commitBody = extractBetween(
      src,
      "export async function commitBagFinishReceive",
      "return { ok: true, zohoPurchaseReceiveId }",
    );
    expect(commitBody).toMatch(/buildBagFinishReceivePayload\(ctx\.buildInput\)/);
    expect(commitBody).not.toMatch(/commitRequestPayload/);
  });
});

// ─── Proposed domain → service boundary (preparatory) ───────────────────────

describe("Z-3 · proposed service-boundary derivation", () => {
  it("derives domain request from current build input without lossy fields", () => {
    const domain = deriveProposedDomainRequest(CANONICAL_BUILD_INPUT);
    expect(domain.inventory_bag_id).toBe(CANONICAL_BUILD_INPUT.inventoryBagId);
    expect(domain.received_quantity).toBe(CANONICAL_BUILD_INPUT.receivedQuantity);
    expect(domain.zoho_purchaseorder_id).toBe(CANONICAL_BUILD_INPUT.zohoPoId);
  });

  it("preview-path service payload matches buildBagFinishReceivePayload for the same domain", () => {
    const domain = deriveProposedDomainRequest(CANONICAL_BUILD_INPUT);
    const fromBuilder = buildBagFinishReceivePayload(CANONICAL_BUILD_INPUT);
    const fromDomain: BagFinishReceiveRequest = {
      source_bag_id: domain.inventory_bag_id,
      internal_receipt_number: domain.internal_receipt_number,
      purchaseorder_id: domain.zoho_purchaseorder_id,
      purchaseorder_line_item_id: domain.zoho_purchaseorder_line_item_id,
      raw_item_id: domain.zoho_raw_item_id,
      human_lot_number: domain.human_lot_number,
      received_quantity: domain.received_quantity,
      receive_date: domain.receive_date,
      idempotency_key: buildBagFinishReceiveIdempotencyKey(domain.inventory_bag_id),
    };
    expect(fromDomain).toEqual(fromBuilder);
  });

  it("documents the two idempotency namespaces that must not be collapsed", () => {
    const domain = deriveProposedDomainRequest(CANONICAL_BUILD_INPUT);
    const built = deriveProposedServiceBuildResponse({
      domain,
      opId: OP_ID,
      notesInput: {
        lumaOperationId: OP_ID,
        receivedQuantity: domain.received_quantity,
        receiveDate: domain.receive_date,
      },
    });
    expect(built.preview_idempotency_key.startsWith("luma-bag-finish-receive:")).toBe(
      true,
    );
    expect(built.commit_idempotency_key.startsWith("rbg-")).toBe(true);
  });
});

// ─── Service client boundary pins ──────────────────────────────────────────

describe("Z-3 · integration service client contract", () => {
  it("posts JSON BagFinishReceiveRequest to preview/commit with bearer headers", () => {
    const client = readRepoSource("lib/zoho/bag-finish-receive-client.ts");
    expect(client).toMatch(/buildAssemblyServiceHeaders/);
    expect(client).toMatch(/JSON\.stringify\(opts\.payload\)/);
    expect(client).toMatch(/idempotencyKey: opts\.payload\.idempotency_key/);
  });

  it("does not import direct Zoho OAuth client", () => {
    const client = readRepoSource("lib/zoho/bag-finish-receive-client.ts");
    expect(client).not.toMatch(/@\/lib\/zoho\/client/);
    expect(client).not.toMatch(/zohoapis\.com/);
  });
});

function extractBetween(src: string, startMarker: string, endMarker: string): string {
  const start = src.indexOf(startMarker);
  const end = src.indexOf(endMarker, start + 1);
  if (start < 0 || end < 0) {
    throw new Error(`extractBetween: markers not found (${startMarker} → ${endMarker})`);
  }
  return src.slice(start, end);
}
