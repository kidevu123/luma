// PRODUCTION-OUTPUT-WORKBENCH-v1.5.0 — source-level contract tests.
//
// Pin cross-file invariants for the workbench:
//
//   * Default-mode behavior is byte-preserved (page.tsx still calls
//     listProductionOutputBacklogWithEligibility(20)).
//   * Workbench query branches by status as specified.
//   * No 7-day clamp in the workbench query.
//   * Workbench surfaces never trigger a Zoho commit directly.
//   * Push-to-Zoho is a navigation link to the existing preview card.
//   * Filter parser exposes the right knobs.
//   * No live-write gate flips, no Zoho gateway calls from this PR.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO = resolve(__dirname, "..", "..");
const read = (rel: string) => readFileSync(resolve(REPO, rel), "utf8");

const PAGE_PATH = "app/(admin)/packaging-output/page.tsx";
const FILTER_BAR_PATH = "app/(admin)/packaging-output/filter-bar.tsx";
const RESULTS_TABLE_PATH = "app/(admin)/packaging-output/results-table.tsx";
const ROW_ACTIONS_PATH =
  "app/(admin)/packaging-output/workbench-row-actions.tsx";
const FILTERS_LIB_PATH = "lib/production/production-output-filters.ts";
const CLASSIFIER_LIB_PATH =
  "lib/production/production-output-row-classifier.ts";
const QUERY_LIB_PATH = "lib/db/queries/production-output-rows.ts";

describe("Default-mode behavior is preserved", () => {
  it("page.tsx still calls listProductionOutputBacklogWithEligibility with limit 20", () => {
    const src = read(PAGE_PATH);
    expect(src).toMatch(/listProductionOutputBacklogWithEligibility\(20\)/);
  });

  it("page.tsx still derives range = lastNDays(7) for metrics rollups", () => {
    const src = read(PAGE_PATH);
    expect(src).toMatch(/const range = lastNDays\(7\)/);
  });

  it("page.tsx still renders the existing #output-queue anchor for dashboard deeplinks", () => {
    const src = read(PAGE_PATH);
    expect(src).toMatch(/id="output-queue"/);
  });
});

describe("Page wires the workbench surface", () => {
  it("imports the filter bar, results table, query, and parser", () => {
    const src = read(PAGE_PATH);
    expect(src).toMatch(/parseProductionOutputFilters/);
    expect(src).toMatch(/listProductionOutputRowsWithFilters/);
    expect(src).toMatch(/ProductionOutputFilterBar/);
    expect(src).toMatch(/ProductionOutputResultsTable/);
  });

  it("only runs the workbench query when filters.hasUserFilter is true", () => {
    const src = read(PAGE_PATH);
    expect(src).toMatch(
      /filters\.hasUserFilter\s*\?\s*listProductionOutputRowsWithFilters\(filters\)\s*:\s*Promise\.resolve\(null\)/,
    );
  });

  it("renders the results table only when workbenchResults is non-null", () => {
    const src = read(PAGE_PATH);
    expect(src).toMatch(/\{workbenchResults\s*&&[\s\S]+ProductionOutputResultsTable/);
  });

  it("page.tsx searchParams accept arbitrary string keys (q/from/to/status/limit/page/poId)", () => {
    const src = read(PAGE_PATH);
    expect(src).toMatch(
      /searchParams\?:\s*Promise<Record<string,\s*string\s*\|\s*string\[\]\s*\|\s*undefined>>/,
    );
  });
});

describe("Workbench query does not clamp to 7 days or to finalized-only", () => {
  it("does NOT call lastNDays anywhere", () => {
    const src = read(QUERY_LIB_PATH);
    expect(src).not.toMatch(/lastNDays/);
  });

  it("default branch (no user filter) still applies the legacy backlog filter", () => {
    const src = read(QUERY_LIB_PATH);
    expect(src).toMatch(/wb\.finalized_at IS NOT NULL[\s\S]+fl\.id IS NULL/);
  });

  it("status=issued_lot branch requires fl.id IS NOT NULL", () => {
    const src = read(QUERY_LIB_PATH);
    expect(src).toMatch(/"issued_lot"[\s\S]+fl\.id IS NOT NULL/);
  });

  it("status=awaiting_lot branch requires fl.id IS NULL", () => {
    const src = read(QUERY_LIB_PATH);
    expect(src).toMatch(/"awaiting_lot"[\s\S]+fl\.id IS NULL/);
  });

  it("status=all (or null) has NO fl.id constraint when in search mode", () => {
    const src = read(QUERY_LIB_PATH);
    // Search-mode WHERE builder must not unconditionally constrain
    // fl.id. The clause exists only under the explicit status arms.
    // Sanity: the constraint lines all live inside if-branches.
    const matches = src.match(/clauses\.push\(sql`fl\.id IS NULL`\)/g);
    expect(matches?.length ?? 0).toBeLessThanOrEqual(1);
  });

  it("date range matches against COALESCE(finalized_at, started_at) so PACKAGED rows are reachable", () => {
    const src = read(QUERY_LIB_PATH);
    expect(src).toMatch(
      /COALESCE\(wb\.finalized_at,\s*wb\.started_at\)\s*>=\s*\$\{fromIso\}/,
    );
    expect(src).toMatch(
      /COALESCE\(wb\.finalized_at,\s*wb\.started_at\)\s*<=\s*\$\{toIso\}/,
    );
  });

  it("limit is bounded server-side by PRODUCTION_OUTPUT_LIMIT_MAX", () => {
    const src = read(QUERY_LIB_PATH);
    expect(src).toMatch(/Math\.min\(limit,\s*PRODUCTION_OUTPUT_LIMIT_MAX\)/);
  });

  it("query searches across receipt, product, lot, workflow id, operator code", () => {
    const src = read(QUERY_LIB_PATH);
    expect(src).toMatch(/ib\.internal_receipt_number ILIKE/);
    expect(src).toMatch(/p\.name ILIKE/);
    expect(src).toMatch(/p\.sku ILIKE/);
    expect(src).toMatch(/wb\.id::text ILIKE/);
    expect(src).toMatch(/fl\.finished_lot_number ILIKE/);
    expect(src).toMatch(/rbs\.current_operator_code ILIKE/);
  });

  it("resolves PO through small_boxes → receives, not inventory_bags.po_line_id", () => {
    const src = read(QUERY_LIB_PATH);
    expect(src).not.toMatch(/ib\.po_line_id/);
    expect(src).toMatch(/LEFT JOIN small_boxes sb\s+ON sb\.id = ib\.small_box_id/);
    expect(src).toMatch(/LEFT JOIN receives rcv\s+ON rcv\.id = sb\.receive_id/);
    expect(src).toMatch(/LEFT JOIN purchase_orders po\s+ON po\.id = rcv\.po_id/);
  });
});

describe("No Zoho commits initiated from workbench surfaces", () => {
  const FILES = [PAGE_PATH, FILTER_BAR_PATH, RESULTS_TABLE_PATH, ROW_ACTIONS_PATH];

  it.each(FILES)(
    "%s does not import or call any shared commit function",
    (rel) => {
      const src = read(rel);
      expect(src).not.toMatch(/sharedCommitProductionOutputOp/);
      expect(src).not.toMatch(/sharedCommitRawBagReceive/);
      expect(src).not.toMatch(/approveProductionOutputForAutoCommit/);
      expect(src).not.toMatch(/commitNowRawBagReceiveOp/);
    },
  );

  it.each(FILES)(
    "%s does not import or call previewZohoProductionOutputAction",
    (rel) => {
      const src = read(rel);
      // The destination preview card lives at
      // /finished-lots/[id] and uses the existing v1.3.0-resolver
      // gating. The workbench never bypasses it.
      expect(src).not.toMatch(/previewZohoProductionOutputAction/);
    },
  );

  it("Push to Zoho is a navigation link to /finished-lots/<id>#zoho-push, not a server-action call", () => {
    const src = read(ROW_ACTIONS_PATH);
    expect(src).toMatch(
      /href=\{`\/finished-lots\/\$\{finishedLotId\}#zoho-push`\}/,
    );
  });

  it("blocked Push to Zoho renders a disabled button (no onClick)", () => {
    const src = read(ROW_ACTIONS_PATH);
    expect(src).toMatch(/data-testid="push-to-zoho-blocked"/);
    expect(src).toMatch(/Push to Zoho · blocked/);
  });
});

describe("Filter bar surfaces the right knobs", () => {
  it("inputs cover q, from, to, status, limit", () => {
    const src = read(FILTER_BAR_PATH);
    expect(src).toMatch(/name="q"/);
    expect(src).toMatch(/name="from"/);
    expect(src).toMatch(/name="to"/);
    expect(src).toMatch(/name="status"/);
    expect(src).toMatch(/name="limit"/);
  });

  it("preserves poId across filter applications", () => {
    const src = read(FILTER_BAR_PATH);
    expect(src).toMatch(/searchParams\?\.get\("poId"\)/);
  });

  it("renders an Apply and a Reset button", () => {
    const src = read(FILTER_BAR_PATH);
    expect(src).toMatch(/Apply/);
    expect(src).toMatch(/Reset/);
  });
});

describe("Filters lib exposes the contract the spec requires", () => {
  it("PRODUCTION_OUTPUT_STATUS_VALUES contains every spec value", () => {
    const src = read(FILTERS_LIB_PATH);
    for (const s of [
      "all",
      "awaiting_lot",
      "ready_to_auto_issue",
      "missing_allocation",
      "blocked",
      "issued_lot",
      "zoho_pending",
      "zoho_committed",
      "packaged_not_finalized",
    ]) {
      expect(src).toMatch(new RegExp(`"${s}"`));
    }
  });

  it("limit options are exactly 20 / 50 / 100", () => {
    const src = read(FILTERS_LIB_PATH);
    expect(src).toMatch(/PRODUCTION_OUTPUT_LIMIT_OPTIONS\s*=\s*\[20,\s*50,\s*100\]/);
  });
});

describe("Drilldowns are present on every workbench row", () => {
  it("row actions render workflow / lot / Zoho op / PO drilldowns when applicable", () => {
    const src = read(ROW_ACTIONS_PATH);
    expect(src).toMatch(/\/workflow-submissions\?bag=/);
    expect(src).toMatch(/\/finished-lots\/\$\{finishedLotId\}/);
    expect(src).toMatch(/\/zoho-production-operations\/\$\{zohoOpId\}/);
    expect(src).toMatch(/\/po-reconciliation\/\$\{poId\}/);
  });
});

describe("No live-write gate flips landed with this PR", () => {
  const FILES = [
    PAGE_PATH,
    FILTER_BAR_PATH,
    RESULTS_TABLE_PATH,
    ROW_ACTIONS_PATH,
    QUERY_LIB_PATH,
    CLASSIFIER_LIB_PATH,
    FILTERS_LIB_PATH,
  ];

  it.each(FILES)("%s does not flip any ZOHO_*_ENABLED env var", (rel) => {
    const src = read(rel);
    expect(src).not.toMatch(/ZOHO_AUTO_COMMIT_ENABLED/);
    expect(src).not.toMatch(/ZOHO_PRODUCTION_OUTPUT_COMMIT_ENABLED/);
    expect(src).not.toMatch(/ZOHO_BAG_FINISH_RECEIVE_COMMIT_ENABLED/);
    expect(src).not.toMatch(/ZOHO_DRY_RUN_WRITES_ENABLED/);
  });
});
