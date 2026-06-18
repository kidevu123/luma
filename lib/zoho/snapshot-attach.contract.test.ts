// SNAPSHOT-ATTACH-v1.4.1 — source-level contract tests for the
// admin preview-action's snapshot attach.
//
// Pins the cross-file invariants so future edits can't silently drop
// the snapshot attachment and re-introduce LUMA_OPERATION_NOT_PERSISTED.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO = resolve(__dirname, "..", "..");
const read = (rel: string) => readFileSync(resolve(REPO, rel), "utf8");

const ACTION_PATH =
  "app/(admin)/finished-lots/[id]/zoho-production-output-preview-actions.ts";
const UPSERT_PATH = "lib/db/queries/zoho-production-output.ts";

describe("Preview action attaches a snapshot before calling the gateway", () => {
  const src = read(ACTION_PATH);

  it("imports buildLumaOperationSnapshotFromOpRow and attachSnapshotToPayload from the canonical helper module", () => {
    expect(src).toMatch(
      /buildLumaOperationSnapshotFromOpRow[\s\S]+attachSnapshotToPayload/,
    );
    expect(src).toMatch(
      /from\s*"@\/lib\/zoho\/luma-operation-snapshot"/,
    );
  });

  it("imports buildSourceAllocationsForFinishedLot + persistSourceAllocationsForOp from the canonical helper module", () => {
    expect(src).toMatch(
      /from\s*"@\/lib\/zoho\/production-output-source-allocations"/,
    );
    expect(src).toMatch(/buildSourceAllocationsForFinishedLot/);
    expect(src).toMatch(/persistSourceAllocationsForOp/);
  });

  it("calls buildSourceAllocationsForFinishedLot BEFORE callProductionOutputPreview", () => {
    const allocIdx = src.indexOf("await buildSourceAllocationsForFinishedLot(");
    const callIdx = src.indexOf("await callProductionOutputPreview(");
    expect(allocIdx).toBeGreaterThan(-1);
    expect(callIdx).toBeGreaterThan(allocIdx);
  });

  it("attaches snapshot AND sets verification.mode = \"snapshot\" on the payload", () => {
    expect(src).toMatch(
      /attachSnapshotToPayload\(\s*buildResult\.payload,\s*snapshotBuilt\.snapshot,?\s*\)/,
    );
    expect(src).toMatch(/verification\s*=\s*\{\s*mode:\s*"snapshot"\s*\}/);
  });

  it("returns PAYLOAD_BLOCKED when source allocations cannot be built (does not call the gateway)", () => {
    expect(src).toMatch(/!sourceBuilt\.ok[\s\S]+kind:\s*"PAYLOAD_BLOCKED"/);
  });

  it("returns PAYLOAD_BLOCKED when the snapshot cannot be built (does not call the gateway)", () => {
    expect(src).toMatch(/!snapshotBuilt\.ok[\s\S]+kind:\s*"PAYLOAD_BLOCKED"/);
  });

  it("passes snapshotSource to upsertZohoProductionOutputPreviewOp on both PREVIEWED and DRAFT branches", () => {
    const occurrences = src.match(/snapshotSource,?/g) ?? [];
    // Two upsert call sites (PREVIEWED + DRAFT) plus the local definition.
    expect(occurrences.length).toBeGreaterThanOrEqual(3);
  });

  it("persists source allocations after the upsert returns", () => {
    expect(src).toMatch(
      /persistSourceAllocationsForOp\(persistedPreview\.id,\s*sourceBuilt\.rows\)/,
    );
  });

  it("v1.4.0 warehouse capability + decision logic is still present and runs before the snapshot build", () => {
    expect(src).toMatch(/fetchWarehouseCapability/);
    expect(src).toMatch(/decideWarehouseInclusion/);
    const capIdx = src.indexOf("await fetchWarehouseCapability");
    const allocIdx = src.indexOf("await buildSourceAllocationsForFinishedLot(");
    expect(capIdx).toBeGreaterThan(-1);
    expect(allocIdx).toBeGreaterThan(capIdx);
  });
});

describe("Upsert persists snapshot-source fields on the op row", () => {
  const src = read(UPSERT_PATH);

  it("UpsertZohoProductionOutputPreviewOpInput declares the snapshotSource field", () => {
    expect(src).toMatch(/snapshotSource\?:\s*\{/);
    expect(src).toMatch(/finalizedAt:\s*Date\s*\|\s*null/);
    expect(src).toMatch(/productId:\s*string\s*\|\s*null/);
    expect(src).toMatch(/productFamily:\s*string\s*\|\s*null/);
    expect(src).toMatch(/finishedSku:\s*string\s*\|\s*null/);
  });

  it("buildZohoProductionOutputPreviewOpValues sets finalizedAt/productId/productFamily/finishedSku from snapshotSource", () => {
    expect(src).toMatch(/finalizedAt:\s*input\.snapshotSource\?\.finalizedAt/);
    expect(src).toMatch(/productId:\s*input\.snapshotSource\?\.productId/);
    expect(src).toMatch(/productFamily:\s*input\.snapshotSource\?\.productFamily/);
    expect(src).toMatch(/finishedSku:\s*input\.snapshotSource\?\.finishedSku/);
  });
});

describe("SNAPSHOT-OP-ID-MATCH-v1.4.17 — envelope and snapshot luma_operation_id must match", () => {
  // BlueRaz #36 deploy of v1.4.12 surfaced the gateway's
  // LUMA_OPERATION_NOT_PERSISTED blocker: the envelope's
  // luma_operation_id (built by buildProductionOutputOperationId,
  // returning "luma-production-output-preview:${id}") did not match
  // the snapshot's luma_operation_id (built by
  // buildLumaProductionOutputOperationId, returning the non-preview
  // variant "luma-production-output:${id}"). The fix sources the
  // snapshot's id from buildResult.payload.luma_operation_id directly,
  // so the two can never drift again.

  const src = read(ACTION_PATH);

  it("admin action does NOT use buildLumaProductionOutputOperationId for the snapshot", () => {
    // The non-preview helper is retained in payload code for a future
    // commit path, but the preview admin action must not call it —
    // doing so re-introduces the prefix-mismatch bug.
    expect(src).not.toMatch(
      /buildLumaProductionOutputOperationId\(\s*lot\.finishedLot\.id\s*\)/,
    );
  });

  it("admin action sources the snapshot's lumaOperationId from buildResult.payload.luma_operation_id", () => {
    // Pin the exact wire so the snapshot can't accidentally pick up
    // a different value (e.g., the lot id, the workflow bag id, or
    // any non-preview-prefixed variant).
    expect(src).toMatch(
      /buildLumaOperationSnapshotFromOpRow\([\s\S]{0,400}lumaOperationId:\s*buildResult\.payload\.luma_operation_id/,
    );
  });

  it("envelope id builder returns the -preview prefix (pinned at source)", () => {
    const previewSrc = read("lib/zoho/production-output-preview.ts");
    expect(previewSrc).toMatch(
      /export function buildProductionOutputOperationId\([\s\S]{0,200}return\s+`luma-production-output-preview:\$\{finishedLotId\}`/,
    );
  });

  it("non-preview helper buildLumaProductionOutputOperationId is still exported (not deleted by this patch)", () => {
    const payloadSrc = read("lib/zoho/luma-production-output-payload.ts");
    expect(payloadSrc).toMatch(/export function buildLumaProductionOutputOperationId/);
  });
});

describe("No live-write gate references introduced by v1.4.1 patch", () => {
  // The consolidated.ts file legitimately *reads* gates to enforce
  // commit-blocked behavior (the v1.20.6 contract). It is allowed to
  // mention gate names. This block guards only the files the v1.4.1
  // patch newly touched for snapshot attach — the admin preview-action
  // and the upsert helper. Neither needs to know about gates.
  const FILES = [ACTION_PATH, UPSERT_PATH];

  it.each(FILES)("%s does not reference any ZOHO_*_ENABLED env var", (rel) => {
    const src = read(rel);
    expect(src).not.toMatch(/ZOHO_AUTO_COMMIT_ENABLED/);
    expect(src).not.toMatch(/ZOHO_PRODUCTION_OUTPUT_COMMIT_ENABLED/);
    expect(src).not.toMatch(/ZOHO_BAG_FINISH_RECEIVE_COMMIT_ENABLED/);
    expect(src).not.toMatch(/ZOHO_DRY_RUN_WRITES_ENABLED/);
  });
});
