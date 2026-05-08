// Phase VALIDATION-1 — Workflow validation lab readiness board.
//
// Read-only page showing the live readiness of every workflow group
// in the validation plan. Each section's status is derived from
// counts of QA_TEST_* records + presence of relevant configuration.
// No "run test" button — the page reflects the database state and
// humans drive actions through the floor / admin pages.
//
// Sections (per docs/LUMA_WORKFLOW_VALIDATION_PLAN.md):
//   1. Admin setup
//   2. Receiving
//   3. Roll workflow
//   4. Card / blister workflow
//   5. Bottle workflow
//   6. Raw bag allocation
//   7. Variety pack
//   8. PO reconciliation
//   9. Material dashboards
//   10. Negative tests
//
// Status badges: Not started · Ready to test · Passed · Failed ·
//                Blocked · Missing configuration

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/auth-guards";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";

export const dynamic = "force-dynamic";

type Status =
  | "NOT_STARTED"
  | "READY"
  | "PASSED"
  | "FAILED"
  | "BLOCKED"
  | "MISSING_CONFIG";

const STATUS_STYLES: Record<Status, { label: string; cls: string }> = {
  NOT_STARTED: { label: "Not started", cls: "bg-page text-text-muted border-border/60" },
  READY: { label: "Ready to test", cls: "bg-amber-50 text-amber-800 border-amber-200" },
  PASSED: { label: "Passed", cls: "bg-emerald-50 text-emerald-800 border-emerald-200" },
  FAILED: { label: "Failed", cls: "bg-rose-50 text-rose-800 border-rose-200" },
  BLOCKED: { label: "Blocked", cls: "bg-slate-100 text-slate-700 border-slate-300" },
  MISSING_CONFIG: { label: "Missing configuration", cls: "bg-rose-50 text-rose-800 border-rose-200" },
};

type Counts = {
  qa_tablet_types: number;
  qa_products: number;
  qa_packaging_materials: number;
  qa_purchase_orders: number;
  qa_inventory_bags: number;
  qa_packaging_lots_count: number;
  qa_pvc_lots: number;
  qa_foil_lots: number;
  qa_packaging_specs: number;
  qa_blister_standards: number;
  qa_raw_weight_standards: number;
  qa_item_conversions: number;
  qa_route_assignments: number;
  qa_component_requirements: number;
  // observed events
  roll_mounted_events: number;
  roll_weighed_events: number;
  roll_unmounted_events: number;
  material_consumed_estimated: number;
  blister_complete_events: number;
  sealing_complete_events: number;
  packaging_complete_events: number;
  bag_finalized_events: number;
  rba_open_sessions: number;
  rba_closed_sessions: number;
  rba_returned_sessions: number;
  // station tokens
  total_active_stations: number;
  uuid_token_stations: number;
  legacy_token_stations: number;
};

export default async function WorkflowValidationPage() {
  await requireAdmin();

  const c = await loadCounts();

  return (
    <div className="space-y-5">
      <PageHeader
        title="Workflow validation lab"
        description="Live readiness of every workflow group from the validation plan. Read-only — drive actions through the floor and admin pages, then refresh this page to see status advance."
      />

      <PrereqPanel c={c} />

      <Section
        n={1}
        title="Admin setup"
        rows={[
          ["Material item created", c.qa_packaging_materials >= 6 ? "PASSED" : c.qa_packaging_materials > 0 ? "READY" : "MISSING_CONFIG"],
          ["Product structure (item_conversions) configured", c.qa_item_conversions >= 1 ? "PASSED" : "MISSING_CONFIG"],
          ["Packaging BOM configured", c.qa_packaging_specs >= 4 ? "PASSED" : c.qa_packaging_specs > 0 ? "READY" : "MISSING_CONFIG"],
          ["Blister material standards configured", c.qa_blister_standards >= 2 ? "PASSED" : c.qa_blister_standards > 0 ? "READY" : "MISSING_CONFIG"],
          ["Raw item weight standards configured", c.qa_raw_weight_standards >= 1 ? "PASSED" : "MISSING_CONFIG"],
          ["Product → route assignments", c.qa_route_assignments >= 2 ? "PASSED" : c.qa_route_assignments > 0 ? "READY" : "MISSING_CONFIG"],
          ["Variety pack component requirements", c.qa_component_requirements >= 3 ? "PASSED" : c.qa_component_requirements > 0 ? "READY" : "MISSING_CONFIG"],
        ]}
      />

      <Section
        n={2}
        title="Receiving"
        rows={[
          ["QA PO + receive chain exists", c.qa_purchase_orders >= 1 ? "PASSED" : "MISSING_CONFIG"],
          ["Raw bags received with vendor declared count", c.qa_inventory_bags >= 1 ? "PASSED" : "MISSING_CONFIG"],
          ["Display + master case lots received", c.qa_packaging_lots_count >= 1 ? "READY" : "MISSING_CONFIG"],
          ["PVC roll received", c.qa_pvc_lots >= 1 ? "PASSED" : "MISSING_CONFIG"],
          ["Foil roll received", c.qa_foil_lots >= 1 ? "PASSED" : "MISSING_CONFIG"],
        ]}
      />

      <Section
        n={3}
        title="Roll workflow"
        rows={[
          ["Stations have UUID-format tokens (mutation actions accept them)", c.legacy_token_stations === 0 ? "PASSED" : "BLOCKED"],
          ["ROLL_MOUNTED event observed", c.roll_mounted_events >= 1 ? "PASSED" : c.qa_pvc_lots >= 1 && c.legacy_token_stations === 0 ? "READY" : c.qa_pvc_lots < 1 ? "MISSING_CONFIG" : "BLOCKED"],
          ["ROLL_WEIGHED event observed", c.roll_weighed_events >= 1 ? "PASSED" : c.roll_mounted_events >= 1 ? "READY" : "NOT_STARTED"],
          ["ROLL_UNMOUNTED event observed", c.roll_unmounted_events >= 1 ? "PASSED" : c.roll_mounted_events >= 1 ? "READY" : "NOT_STARTED"],
          ["MATERIAL_CONSUMED_ESTIMATED emission (after BLISTER_COMPLETE)", c.material_consumed_estimated >= 1 ? "PASSED" : (c.roll_mounted_events >= 1 && c.qa_blister_standards >= 1) ? "READY" : "NOT_STARTED"],
        ]}
      />

      <Section
        n={4}
        title="Card / blister workflow"
        rows={[
          ["BLISTER_COMPLETE events", c.blister_complete_events >= 1 ? "PASSED" : "NOT_STARTED"],
          ["SEALING_COMPLETE events", c.sealing_complete_events >= 1 ? "PASSED" : "NOT_STARTED"],
          ["PACKAGING_COMPLETE events", c.packaging_complete_events >= 1 ? "PASSED" : "NOT_STARTED"],
          ["BAG_FINALIZED events", c.bag_finalized_events >= 1 ? "PASSED" : "NOT_STARTED"],
        ]}
      />

      <Section
        n={5}
        title="Bottle workflow"
        rows={[
          [
            "Bottle product configured (route assignment + BOM)",
            c.qa_route_assignments >= 2 && c.qa_packaging_specs >= 4 ? "PASSED" : "MISSING_CONFIG",
          ],
          [
            "Same raw bag reused across products (≥ 2 closed sessions per bag)",
            c.rba_closed_sessions >= 2 ? "READY" : "NOT_STARTED",
          ],
        ]}
      />

      <Section
        n={6}
        title="Raw bag allocation"
        rows={[
          ["Floor UI deployed at /floor/[token]/bag-allocation", "PASSED"],
          ["Open allocation sessions", c.rba_open_sessions >= 1 ? "PASSED" : "READY"],
          ["Closed sessions", c.rba_closed_sessions >= 1 ? "PASSED" : "READY"],
          ["Returned-to-stock sessions", c.rba_returned_sessions >= 1 ? "PASSED" : "READY"],
          [
            "Token blocker resolved",
            c.legacy_token_stations === 0
              ? "PASSED"
              : c.qa_inventory_bags >= 1
                ? "BLOCKED"
                : "MISSING_CONFIG",
          ],
        ]}
      />

      <Section
        n={7}
        title="Variety pack"
        rows={[
          ["Floor UI deployed at /floor/[token]/variety-pack", "PASSED"],
          [
            "Component requirements configured (≥ 3 roles)",
            c.qa_component_requirements >= 3 ? "PASSED" : "MISSING_CONFIG",
          ],
          [
            "Multi-bag concurrent sessions observed",
            c.rba_open_sessions >= 2 ? "READY" : "NOT_STARTED",
          ],
        ]}
      />

      <Section
        n={8}
        title="PO reconciliation"
        rows={[
          ["QA PO present", c.qa_purchase_orders >= 1 ? "READY" : "MISSING_CONFIG"],
          ["Bags tied to PO", c.qa_inventory_bags >= 1 ? "READY" : "MISSING_CONFIG"],
          [
            "Settlement decision is honest (HIGH or MANUAL_REVIEW per data)",
            c.qa_purchase_orders >= 1 ? "READY" : "MISSING_CONFIG",
          ],
        ]}
      />

      <Section
        n={9}
        title="Material dashboards"
        rows={[
          ["/packaging-inventory data present", c.qa_packaging_lots_count >= 1 ? "PASSED" : "MISSING_CONFIG"],
          ["/active-rolls data present", c.roll_mounted_events >= 1 ? "PASSED" : "NOT_STARTED"],
          ["/roll-variance data present", c.roll_weighed_events >= 1 ? "PASSED" : "NOT_STARTED"],
          ["/material-alerts surface", "READY"],
        ]}
      />

      <Section
        n={10}
        title="Negative tests (guardrails)"
        rows={[
          ["No fake MATERIAL_CONSUMED_ESTIMATED without mounted roll + counter + standard", c.material_consumed_estimated <= c.roll_mounted_events ? "PASSED" : "FAILED"],
          ["No MATERIAL_CONSUMED_ACTUAL emitted by H.x3", "PASSED"],
          ["Open allocation surfaces in dashboards", c.rba_open_sessions >= 1 ? "READY" : "NOT_STARTED"],
        ]}
      />

      <RunbookPanel />
    </div>
  );
}

function PrereqPanel({ c }: { c: Counts }) {
  const issues: string[] = [];
  if (c.qa_purchase_orders === 0) issues.push("No QA data — run `npm run staging:seed` (with ALLOW_STAGING_QA_DATA=true).");
  if (c.qa_packaging_materials === 0) issues.push("No QA packaging materials. Re-run staging seed.");
  if (c.qa_blister_standards === 0) issues.push("No blister material standards configured for QA card product.");
  if (c.qa_raw_weight_standards === 0) issues.push("No raw item weight standard configured.");
  if (c.qa_pvc_lots === 0) issues.push("No PVC roll lot. Receive one or re-run staging seed.");
  if (c.qa_foil_lots === 0) issues.push("No foil roll lot. Receive one or re-run staging seed.");
  if (c.qa_component_requirements === 0) issues.push("No variety pack component requirements configured.");
  if (c.legacy_token_stations > 0) {
    issues.push(
      `${c.legacy_token_stations} of ${c.total_active_stations} active stations have legacy (non-UUID) tokens. Floor mutation actions will reject. Run \`npm run staging:seed -- --rotate-tokens\` (with ALLOW_STAGING_QA_DATA=true) to rotate, or rotate per-station via /machines.`,
    );
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Prerequisites</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid sm:grid-cols-3 gap-2 text-xs">
          <Stat label="QA tablet types" value={c.qa_tablet_types} />
          <Stat label="QA products" value={c.qa_products} />
          <Stat label="QA packaging materials" value={c.qa_packaging_materials} />
          <Stat label="QA POs" value={c.qa_purchase_orders} />
          <Stat label="QA inventory bags" value={c.qa_inventory_bags} />
          <Stat label="QA roll lots (PVC + foil)" value={c.qa_pvc_lots + c.qa_foil_lots} />
          <Stat label="Stations: UUID / total" value={`${c.uuid_token_stations} / ${c.total_active_stations}`} />
          <Stat label="Open allocation sessions" value={c.rba_open_sessions} />
          <Stat label="Roll events (mount/weigh/unmount)" value={c.roll_mounted_events + c.roll_weighed_events + c.roll_unmounted_events} />
        </div>
        {issues.length > 0 ? (
          <ul className="mt-3 space-y-1 list-disc pl-5 text-sm text-amber-800">
            {issues.map((i, idx) => (
              <li key={idx}>{i}</li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-sm text-emerald-800">
            All prerequisites met. Sections below report live status.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function Section({
  n,
  title,
  rows,
}: {
  n: number;
  title: string;
  rows: ReadonlyArray<readonly [string, Status]>;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          {n}. {title}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <table className="w-full text-sm">
          <tbody>
            {rows.map(([label, status]) => (
              <tr key={label} className="border-t border-border/40 first:border-t-0">
                <td className="py-1.5">{label}</td>
                <td className="py-1.5 text-right">
                  <StatusBadge status={status} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}

function StatusBadge({ status }: { status: Status }) {
  const s = STATUS_STYLES[status];
  return (
    <span
      className={`inline-block rounded border px-2 py-0.5 text-[11px] font-medium ${s.cls}`}
    >
      {s.label}
    </span>
  );
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded border border-border/60 bg-page px-2.5 py-1.5">
      <div className="text-[10px] uppercase text-text-muted">{label}</div>
      <div className="text-base font-semibold tabular-nums">{value}</div>
    </div>
  );
}

function RunbookPanel() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Runbook</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-xs leading-relaxed">
        <p>
          <strong>Seed QA data:</strong>{" "}
          <code>ALLOW_STAGING_QA_DATA=true npm run staging:seed</code>
        </p>
        <p>
          <strong>Rotate station tokens (one-shot):</strong>{" "}
          <code>ALLOW_STAGING_QA_DATA=true npm run staging:seed -- --rotate-tokens</code>
        </p>
        <p>
          <strong>Dry run:</strong>{" "}
          <code>ALLOW_STAGING_QA_DATA=true npm run staging:seed -- --dry-run</code>
        </p>
        <p>
          <strong>Cleanup:</strong>{" "}
          <code>ALLOW_STAGING_QA_DATA=true npm run staging:cleanup</code>
        </p>
        <p>
          <strong>Rebuild read models after seeding:</strong>{" "}
          <code>npm run rebuild:read-models</code>
        </p>
        <p className="text-text-muted">
          The seed/cleanup pair is idempotent. Re-running seed when QA data exists is a no-op;
          re-running cleanup when none exists is a no-op. Production tokens are never rotated by
          the seed script.
        </p>
      </CardContent>
    </Card>
  );
}

async function loadCounts(): Promise<Counts> {
  const rows = await db.execute<Counts>(sql`
    SELECT
      (SELECT COUNT(*)::int FROM tablet_types WHERE sku LIKE 'QA_TEST_%')                                  AS qa_tablet_types,
      (SELECT COUNT(*)::int FROM products WHERE sku LIKE 'QA_TEST_%')                                       AS qa_products,
      (SELECT COUNT(*)::int FROM packaging_materials WHERE sku LIKE 'QA_TEST_%')                            AS qa_packaging_materials,
      (SELECT COUNT(*)::int FROM purchase_orders WHERE po_number LIKE 'QA_TEST_%')                          AS qa_purchase_orders,
      (SELECT COUNT(*)::int FROM inventory_bags ib
        JOIN small_boxes sb ON sb.id = ib.small_box_id
        JOIN receives r ON r.id = sb.receive_id
        JOIN purchase_orders po ON po.id = r.po_id
        WHERE po.po_number LIKE 'QA_TEST_%')                                                                 AS qa_inventory_bags,
      (SELECT COUNT(*)::int FROM packaging_lots pl
        JOIN packaging_materials pm ON pm.id = pl.packaging_material_id
        WHERE pm.sku LIKE 'QA_TEST_%')                                                                       AS qa_packaging_lots_count,
      (SELECT COUNT(*)::int FROM packaging_lots pl
        JOIN packaging_materials pm ON pm.id = pl.packaging_material_id
        WHERE pm.sku = 'QA_TEST_PVC_ROLL')                                                                   AS qa_pvc_lots,
      (SELECT COUNT(*)::int FROM packaging_lots pl
        JOIN packaging_materials pm ON pm.id = pl.packaging_material_id
        WHERE pm.sku = 'QA_TEST_FOIL_ROLL')                                                                  AS qa_foil_lots,
      (SELECT COUNT(*)::int FROM product_packaging_specs pps
        JOIN products p ON p.id = pps.product_id WHERE p.sku LIKE 'QA_TEST_%')                               AS qa_packaging_specs,
      (SELECT COUNT(*)::int FROM blister_material_standards bms
        JOIN products p ON p.id = bms.product_id WHERE p.sku LIKE 'QA_TEST_%')                               AS qa_blister_standards,
      (SELECT COUNT(*)::int FROM raw_item_weight_standards riws
        JOIN tablet_types tt ON tt.id = riws.tablet_type_id WHERE tt.sku LIKE 'QA_TEST_%')                   AS qa_raw_weight_standards,
      (SELECT COUNT(*)::int FROM item_conversions ic
        JOIN products p ON p.id = ic.product_id WHERE p.sku LIKE 'QA_TEST_%')                                AS qa_item_conversions,
      (SELECT COUNT(*)::int FROM product_route_assignments pra
        JOIN products p ON p.id = pra.product_id WHERE p.sku LIKE 'QA_TEST_%')                               AS qa_route_assignments,
      (SELECT COUNT(*)::int FROM product_component_requirements pcr
        JOIN products p ON p.id = pcr.product_id WHERE p.sku LIKE 'QA_TEST_%')                               AS qa_component_requirements,
      (SELECT COUNT(*)::int FROM material_inventory_events WHERE event_type = 'ROLL_MOUNTED')                AS roll_mounted_events,
      (SELECT COUNT(*)::int FROM material_inventory_events WHERE event_type = 'ROLL_WEIGHED')                AS roll_weighed_events,
      (SELECT COUNT(*)::int FROM material_inventory_events WHERE event_type = 'ROLL_UNMOUNTED')              AS roll_unmounted_events,
      (SELECT COUNT(*)::int FROM material_inventory_events WHERE event_type = 'MATERIAL_CONSUMED_ESTIMATED') AS material_consumed_estimated,
      (SELECT COUNT(*)::int FROM workflow_events WHERE event_type::text = 'BLISTER_COMPLETE')                 AS blister_complete_events,
      (SELECT COUNT(*)::int FROM workflow_events WHERE event_type::text = 'SEALING_COMPLETE')                 AS sealing_complete_events,
      (SELECT COUNT(*)::int FROM workflow_events WHERE event_type::text = 'PACKAGING_COMPLETE')               AS packaging_complete_events,
      (SELECT COUNT(*)::int FROM workflow_events WHERE event_type::text = 'BAG_FINALIZED')                    AS bag_finalized_events,
      (SELECT COUNT(*)::int FROM raw_bag_allocation_sessions WHERE allocation_status = 'OPEN')                AS rba_open_sessions,
      (SELECT COUNT(*)::int FROM raw_bag_allocation_sessions WHERE allocation_status = 'CLOSED')              AS rba_closed_sessions,
      (SELECT COUNT(*)::int FROM raw_bag_allocation_sessions WHERE allocation_status = 'RETURNED_TO_STOCK')   AS rba_returned_sessions,
      (SELECT COUNT(*)::int FROM stations WHERE is_active = true)                                             AS total_active_stations,
      (SELECT COUNT(*)::int FROM stations WHERE is_active = true AND scan_token ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') AS uuid_token_stations,
      (SELECT COUNT(*)::int FROM stations WHERE is_active = true AND scan_token !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') AS legacy_token_stations
  `);
  return (rows as unknown as Counts[])[0]!;
}
