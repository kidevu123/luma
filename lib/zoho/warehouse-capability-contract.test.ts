// WAREHOUSE-CAPABILITY-v1.4.0 — source-level contract tests.
//
// Pin cross-file invariants for the capability phase:
//
//   * The preview action calls fetchWarehouseCapability and decides via decideWarehouseInclusion.
//   * UNKNOWN -> OPTIONAL fallback exists nowhere.
//   * No env var like LUMA_ASSUME_NO_WAREHOUSE.
//   * No /zoho/cached/* paths used (re-pin from v1.3).
//   * Payload builder uses spread-on-truthy for warehouse_id.
//   * Audit row write includes the four capability fields.
//   * No live-write gate flips in this PR.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO = resolve(__dirname, "..", "..");
const read = (rel: string) => readFileSync(resolve(REPO, rel), "utf8");

const CLIENT_PATH = "lib/zoho/brand-capabilities-client.ts";
const DECISION_PATH = "lib/zoho/warehouse-decision.ts";
const PREVIEW_LIB_PATH = "lib/zoho/production-output-preview.ts";
const PREVIEW_ACTION_PATH =
  "app/(admin)/finished-lots/[id]/zoho-production-output-preview-actions.ts";
const PREVIEW_CARD_PATH =
  "app/(admin)/finished-lots/[id]/zoho-production-output-preview-card.tsx";
const QUERY_LIB_PATH = "lib/db/queries/zoho-production-output.ts";

describe("Preview action wires capability + decision", () => {
  it("imports fetchWarehouseCapability and decideWarehouseInclusion", () => {
    const src = read(PREVIEW_ACTION_PATH);
    expect(src).toMatch(
      /import\s*\{\s*fetchWarehouseCapability\s*\}\s*from\s*"@\/lib\/zoho\/brand-capabilities-client"/,
    );
    expect(src).toMatch(/decideWarehouseInclusion/);
    expect(src).toMatch(/capabilitySourceLabel/);
  });

  it("calls fetchWarehouseCapability AFTER warehouse resolution and BEFORE payload build", () => {
    const src = read(PREVIEW_ACTION_PATH);
    // Use the CALL-site signatures (open paren) so we don't get
    // tripped up by the import line at the top of the file.
    const resolveIdx = src.indexOf("resolveProductionOutputWarehouseId({");
    const fetchIdx = src.indexOf("await fetchWarehouseCapability()");
    const buildIdx = src.indexOf("buildProductionOutputPreviewPayload({");
    expect(resolveIdx).toBeGreaterThan(-1);
    expect(fetchIdx).toBeGreaterThan(resolveIdx);
    expect(buildIdx).toBeGreaterThan(fetchIdx);
  });

  it("decision.kind === 'block' returns PAYLOAD_BLOCKED with the decision reason verbatim", () => {
    const src = read(PREVIEW_ACTION_PATH);
    expect(src).toMatch(/decision\.kind\s*===\s*"block"/);
    expect(src).toMatch(/message:\s*decision\.reason/);
  });

  it("passes allowWarehouseOmission to the payload builder when decision is omit", () => {
    const src = read(PREVIEW_ACTION_PATH);
    expect(src).toMatch(/allowWarehouseOmission\s*=\s*decision\.kind\s*===\s*"omit"/);
    expect(src).toMatch(/allowWarehouseOmission,?/);
  });

  it("upsert call sites include the warehouseAudit payload", () => {
    const src = read(PREVIEW_ACTION_PATH);
    // Both PREVIEWED and DRAFT branches must persist the audit.
    const occurrences = src.match(/warehouseAudit/g) ?? [];
    expect(occurrences.length).toBeGreaterThanOrEqual(2);
  });

  it("audit field warehouseRequired is set from capability.state", () => {
    const src = read(PREVIEW_ACTION_PATH);
    expect(src).toMatch(/capability\.state\s*===\s*"REQUIRED"/);
    expect(src).toMatch(/capability\.state\s*===\s*"OPTIONAL"/);
  });

  it("audit capabilityGatewayRequestId is null when state is UNKNOWN", () => {
    const src = read(PREVIEW_ACTION_PATH);
    expect(src).toMatch(
      /capabilityGatewayRequestId:\s*\n?\s*capability\.state\s*===\s*"UNKNOWN"\s*\?\s*null\s*:\s*capability\.gatewayRequestId/,
    );
  });
});

describe("Payload contract — warehouse_id key absence", () => {
  it("payload uses spread-on-truthy for warehouse_id (no empty string, no null)", () => {
    const src = read(PREVIEW_LIB_PATH);
    expect(src).toMatch(
      /\.\.\.\(warehouseId\s*\?\s*\{\s*warehouse_id:\s*warehouseId\s*\}\s*:\s*\{\}\)/,
    );
  });

  it("ProductionOutputPreviewPayload.warehouse_id is optional", () => {
    const src = read(PREVIEW_LIB_PATH);
    expect(src).toMatch(/warehouse_id\?:\s*string/);
  });

  it("missing-warehouse blocker is gated by !input.allowWarehouseOmission", () => {
    const src = read(PREVIEW_LIB_PATH);
    expect(src).toMatch(/!warehouseId\s*&&\s*!input\.allowWarehouseOmission/);
  });
});

describe("UNKNOWN never falls through to OPTIONAL", () => {
  it("decision module: UNKNOWN branch returns block, never use/omit", () => {
    const src = read(DECISION_PATH);
    // The UNKNOWN branch must short-circuit at the top of
    // decideWarehouseInclusion. Smell-test the flow.
    expect(src).toMatch(
      /capability\.state\s*===\s*"UNKNOWN"[\s\S]+?return\s*\{\s*\n?\s*kind:\s*"block"/,
    );
  });

  it("client module: every UNKNOWN return carries a structured reason field", () => {
    const src = read(CLIENT_PATH);
    expect(src).toMatch(/state:\s*"UNKNOWN",\s*reason:/);
    // No state:"OPTIONAL" branch outside of mapWarehouseCapabilityResponse.
    const optionalLines = src.match(/state:\s*"OPTIONAL"/g) ?? [];
    expect(optionalLines.length).toBeGreaterThan(0);
    // Sanity: client never returns OPTIONAL on a failure path
    // (search for `catch` followed by OPTIONAL — must be empty).
    expect(src).not.toMatch(/catch[\s\S]+state:\s*"OPTIONAL"/);
  });
});

describe("No env-level capability hatch", () => {
  const FILES = [CLIENT_PATH, DECISION_PATH, PREVIEW_ACTION_PATH, PREVIEW_LIB_PATH];
  it.each(FILES)("%s does not introduce a LUMA_ASSUME_* env hatch", (rel) => {
    const src = read(rel);
    expect(src).not.toMatch(/LUMA_ASSUME_NO_WAREHOUSE/);
    expect(src).not.toMatch(/LUMA_FORCE_WAREHOUSE_OPTIONAL/);
    expect(src).not.toMatch(/LUMA_ASSUME_OPTIONAL/);
  });
});

describe("No cached endpoints used yet (Zoho v1.23.0 cached-reads still deferred)", () => {
  const FILES = [
    CLIENT_PATH,
    DECISION_PATH,
    PREVIEW_ACTION_PATH,
    PREVIEW_LIB_PATH,
    PREVIEW_CARD_PATH,
    QUERY_LIB_PATH,
  ];
  it.each(FILES)("%s does not import /zoho/cached/*", (rel) => {
    const src = read(rel);
    expect(src).not.toMatch(/\/zoho\/cached\//);
  });
});

describe("Persisted metadata + jsonb sink record capability audit", () => {
  it("ZohoProductionOutputPreviewMetadata declares warehouseRequired/warehouseOmitted/capabilitySource/capabilityGatewayRequestId", () => {
    const src = read(QUERY_LIB_PATH);
    expect(src).toMatch(/warehouseRequired:\s*boolean\s*\|\s*null/);
    expect(src).toMatch(/warehouseOmitted:\s*boolean/);
    expect(src).toMatch(/capabilitySource:\s*string\s*\|\s*null/);
    expect(src).toMatch(/capabilityGatewayRequestId:\s*string\s*\|\s*null/);
  });

  it("UpsertZohoProductionOutputPreviewOpInput requires warehouseAudit", () => {
    const src = read(QUERY_LIB_PATH);
    expect(src).toMatch(/warehouseAudit:\s*\{/);
  });

  it("quantityBasis jsonb sink carries the four capability fields", () => {
    const src = read(QUERY_LIB_PATH);
    expect(src).toMatch(/warehouse_required:\s*input\.warehouseAudit\.warehouseRequired/);
    expect(src).toMatch(/warehouse_omitted:\s*input\.warehouseAudit\.warehouseOmitted/);
    expect(src).toMatch(/capability_source:\s*input\.warehouseAudit\.capabilitySource/);
    expect(src).toMatch(/capability_gateway_request_id/);
  });

  it("toPreviewMetadata reads the capability fields back out of quantityBasis", () => {
    const src = read(QUERY_LIB_PATH);
    expect(src).toMatch(/basis\.warehouse_required/);
    expect(src).toMatch(/basis\.warehouse_omitted/);
    expect(src).toMatch(/basis\.capability_source/);
    expect(src).toMatch(/basis\.capability_gateway_request_id/);
  });
});

describe("No live-write gate changes in this PR", () => {
  const FILES = [
    CLIENT_PATH,
    DECISION_PATH,
    PREVIEW_LIB_PATH,
    PREVIEW_ACTION_PATH,
    PREVIEW_CARD_PATH,
  ];
  it.each(FILES)("%s does not flip any ZOHO_*_ENABLED env var", (rel) => {
    const src = read(rel);
    expect(src).not.toMatch(/ZOHO_AUTO_COMMIT_ENABLED/);
    expect(src).not.toMatch(/ZOHO_PRODUCTION_OUTPUT_COMMIT_ENABLED/);
    expect(src).not.toMatch(/ZOHO_BAG_FINISH_RECEIVE_COMMIT_ENABLED/);
    expect(src).not.toMatch(/ZOHO_DRY_RUN_WRITES_ENABLED/);
  });
});

describe("Preview card surfaces capability banners + audit summary rows", () => {
  it("renders the OPTIONAL+omit banner via persistedPreview.warehouseOmitted", () => {
    const src = read(PREVIEW_CARD_PATH);
    expect(src).toMatch(/warehouse-omitted-banner/);
    expect(src).toMatch(
      /This Zoho org does not use warehouses;\s*warehouse will be omitted\./,
    );
  });

  it("renders capability summary rows with source + request id", () => {
    const src = read(PREVIEW_CARD_PATH);
    expect(src).toMatch(/warehouse_required/);
    expect(src).toMatch(/capability source/);
    expect(src).toMatch(/capability request/);
  });
});
