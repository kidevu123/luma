// Tests for the shared raw-bag commit function. Pure-function units
// (idempotency key derivation, mapping-blocker parsing) only — the
// stateful end-to-end is covered by integration tests in a later phase
// that need a real DB.

import { describe, expect, it } from "vitest";
import {
  buildRawBagCommitIdempotencyKey,
  classifyBlockers,
  extractMappingBlockers,
  NEEDS_REVIEW_BLOCKER_CODES,
} from "./shared-raw-bag-receive-commit";

describe("buildRawBagCommitIdempotencyKey", () => {
  const BASE = {
    opId: "11111111-1111-4111-8111-111111111111",
    zohoPoId: "po-1",
    zohoLineItemId: "line-1",
    receivedQuantity: 500,
    receiveDate: "2026-06-15",
  };

  it("produces a stable key — same input always returns same key", () => {
    expect(buildRawBagCommitIdempotencyKey(BASE)).toBe(
      buildRawBagCommitIdempotencyKey({ ...BASE }),
    );
  });

  it("differs when the op id changes", () => {
    expect(buildRawBagCommitIdempotencyKey(BASE)).not.toBe(
      buildRawBagCommitIdempotencyKey({
        ...BASE,
        opId: "22222222-2222-4222-8222-222222222222",
      }),
    );
  });

  it("differs when received quantity changes", () => {
    expect(buildRawBagCommitIdempotencyKey(BASE)).not.toBe(
      buildRawBagCommitIdempotencyKey({ ...BASE, receivedQuantity: 501 }),
    );
  });

  it("differs when zoho PO id changes", () => {
    expect(buildRawBagCommitIdempotencyKey(BASE)).not.toBe(
      buildRawBagCommitIdempotencyKey({ ...BASE, zohoPoId: "po-2" }),
    );
  });

  it("differs when zoho line item changes", () => {
    expect(buildRawBagCommitIdempotencyKey(BASE)).not.toBe(
      buildRawBagCommitIdempotencyKey({ ...BASE, zohoLineItemId: "line-2" }),
    );
  });

  it("differs when receive date changes", () => {
    expect(buildRawBagCommitIdempotencyKey(BASE)).not.toBe(
      buildRawBagCommitIdempotencyKey({ ...BASE, receiveDate: "2026-06-16" }),
    );
  });

  it("starts with the rbg- namespace prefix so logs distinguish key kinds", () => {
    expect(buildRawBagCommitIdempotencyKey(BASE)).toMatch(/^rbg-[0-9a-f]{32}$/);
  });

  it("is bounded — fits in a database text column without surprises", () => {
    expect(buildRawBagCommitIdempotencyKey(BASE).length).toBe(36);
  });
});

describe("extractMappingBlockers", () => {
  it("returns an empty array when body is null / undefined / non-object", () => {
    expect(extractMappingBlockers(null)).toEqual([]);
    expect(extractMappingBlockers(undefined)).toEqual([]);
    expect(extractMappingBlockers("a string")).toEqual([]);
    expect(extractMappingBlockers(42)).toEqual([]);
  });

  it("returns an empty array when the body has no mapping_blockers key", () => {
    expect(extractMappingBlockers({ something: "else" })).toEqual([]);
  });

  it("returns an empty array when mapping_blockers is not an array", () => {
    expect(extractMappingBlockers({ mapping_blockers: "oops" })).toEqual([]);
    expect(extractMappingBlockers({ mapping_blockers: {} })).toEqual([]);
  });

  it("parses well-formed mapping_blockers", () => {
    const result = extractMappingBlockers({
      mapping_blockers: [
        { code: "PO_NOT_FOUND", message: "Purchase order not found in Zoho." },
        { code: "LINE_MISMATCH", message: "Line item does not belong to the PO." },
      ],
    });
    expect(result).toEqual([
      { code: "PO_NOT_FOUND", message: "Purchase order not found in Zoho." },
      { code: "LINE_MISMATCH", message: "Line item does not belong to the PO." },
    ]);
  });

  it("falls back to the 'blockers' key when 'mapping_blockers' is absent", () => {
    const result = extractMappingBlockers({
      blockers: [{ code: "X", message: "y" }],
    });
    expect(result).toEqual([{ code: "X", message: "y" }]);
  });

  it("drops malformed entries that lack code or message", () => {
    const result = extractMappingBlockers({
      mapping_blockers: [
        { code: "OK", message: "real" },
        { code: 42, message: "non-string code" },
        { code: "X", message: null },
        { onlyOneField: true },
      ],
    });
    expect(result).toEqual([{ code: "OK", message: "real" }]);
  });
});

describe("classifyBlockers — routing receiving exceptions vs product gaps", () => {
  it("treats unknown codes as product-mapping gaps (the default routing bucket)", () => {
    const result = classifyBlockers([
      { code: "PO_NOT_FOUND", message: "PO not found." },
      { code: "LINE_MISMATCH", message: "Line mismatch." },
    ]);
    expect(result.needsReview).toEqual([]);
    expect(result.needsMapping).toHaveLength(2);
  });

  it("routes OVER_RECEIVE_EXCEEDS_PO_REMAINING to the NEEDS_REVIEW bucket", () => {
    // The whole point of the new state: an overage is a business
    // decision (adjust qty / hold / overs PO / split / void /
    // reconcile-with-note), not a product-setup gap.
    const result = classifyBlockers([
      {
        code: "OVER_RECEIVE_EXCEEDS_PO_REMAINING",
        message: "Receive qty (530) > PO line remaining (500).",
      },
    ]);
    expect(result.needsReview).toHaveLength(1);
    expect(result.needsMapping).toEqual([]);
  });

  it("partitions a mixed batch into both buckets", () => {
    const result = classifyBlockers([
      { code: "OVER_RECEIVE_EXCEEDS_PO_REMAINING", message: "overage" },
      { code: "PO_NOT_FOUND", message: "missing PO" },
    ]);
    expect(result.needsReview).toHaveLength(1);
    expect(result.needsMapping).toHaveLength(1);
  });

  it("the NEEDS_REVIEW code set is closed and well-known", () => {
    // Pin the membership so a future contributor can't quietly add a
    // new code that silently changes queue routing. New codes must be
    // a deliberate edit here AND in the operator-facing copy.
    expect(NEEDS_REVIEW_BLOCKER_CODES.has("OVER_RECEIVE_EXCEEDS_PO_REMAINING")).toBe(
      true,
    );
    expect(NEEDS_REVIEW_BLOCKER_CODES.has("PO_NOT_FOUND")).toBe(false);
    expect(NEEDS_REVIEW_BLOCKER_CODES.has("MISSING_ZOHO_ITEM_ID")).toBe(false);
  });
});
