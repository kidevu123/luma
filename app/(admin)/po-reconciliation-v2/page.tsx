import { formatDateTimeEst } from "@/lib/ui/luma-display";
// PT-6D — 8-bucket reconciliation admin page.
//
// Reads from `read_material_reconciliation_v2`. The math is in PT-6B
// + PT-6C; this page formats only.
//
// Hard rules from the plan §5 (UI rules):
//   - RECEIPT_VARIANCE column NEVER says "production loss"
//   - CYCLE_COUNT_VARIANCE NEVER says "supplier shortage"
//   - estimated values labelled "estimated" with the existing pill
//   - the four variance subtypes stay visually distinct so vendor /
//     count drift / process loss / unknown never collapse into one.

import Link from "next/link";
import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/auth-guards";
import { PageHeader } from "@/components/ui/page-header";
import { ConfidenceBadge } from "@/components/production/confidence-badge";
import {
  listReconciliationV2Rows,
  reconciliationV2HasAnyRows,
  VARIANCE_LABELS,
  type ReconciliationV2BucketView,
  type ReconciliationV2Row,
  type ReconciliationV2VarianceView,
} from "@/lib/production/reconciliation-v2-loader";
import type {
  ReconciliationConfidence,
  VarianceKind,
  VarianceSeverity,
} from "@/lib/production/reconciliation-v2";
import { rebuildAllMaterialProjectionsAction } from "@/lib/admin/rebuild-material-projections-action";

export const dynamic = "force-dynamic";

const SCOPE_TYPES = [
  "PACKAGING_LOT",
  "ROLL",
  "RAW_BAG",
  "MATERIAL_ITEM",
  "PO",
] as const;
const CONFIDENCES: ReconciliationConfidence[] = [
  "HIGH",
  "MEDIUM",
  "LOW",
  "MISSING",
];
const VARIANCE_KINDS: VarianceKind[] = [
  "RECEIPT_VARIANCE",
  "CYCLE_COUNT_VARIANCE",
  "CONSUMPTION_VARIANCE",
  "UNKNOWN_VARIANCE",
];
const SEVERITIES: VarianceSeverity[] = ["NONE", "LOW", "MEDIUM", "HIGH", "MISSING"];
const SOURCE_SYSTEMS = ["PACKTRACK", "MANUAL_LUMA", "ZOHO", "IMPORT"] as const;

type SearchParams = {
  scope?: string;
  conf?: string;
  vKind?: string;
  vSev?: string;
  varianceOnly?: string;
  missingOnly?: string;
  source?: string;
};

export default async function PoReconciliationV2Page({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  await requireAdmin();
  const sp = await searchParams;
  const filters: Parameters<typeof listReconciliationV2Rows>[1] = {
    ...(SCOPE_TYPES.includes(sp.scope as (typeof SCOPE_TYPES)[number])
      ? { scopeType: sp.scope as (typeof SCOPE_TYPES)[number] }
      : {}),
    ...(CONFIDENCES.includes(sp.conf as ReconciliationConfidence)
      ? { confidence: sp.conf as ReconciliationConfidence }
      : {}),
    ...(VARIANCE_KINDS.includes(sp.vKind as VarianceKind)
      ? { varianceKind: sp.vKind as VarianceKind }
      : {}),
    ...(SEVERITIES.includes(sp.vSev as VarianceSeverity)
      ? { varianceSeverity: sp.vSev as VarianceSeverity }
      : {}),
    ...(sp.varianceOnly === "1" ? { varianceOnly: true } : {}),
    ...(sp.missingOnly === "1" ? { missingOnly: true } : {}),
    ...(SOURCE_SYSTEMS.includes(sp.source as (typeof SOURCE_SYSTEMS)[number])
      ? { sourceSystem: sp.source as (typeof SOURCE_SYSTEMS)[number] }
      : {}),
  };

  const [rows, hasAny] = await Promise.all([
    listReconciliationV2Rows(db, filters),
    reconciliationV2HasAnyRows(db),
  ]);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Reconciliation (8-bucket)"
        description="Per-lot reconciliation across declared / counted / accepted / consumed / scrapped / on-hand, with four parallel variance subtypes that never collapse into one number."
      />

      <div className="flex items-center justify-between gap-3 text-xs">
        <div className="flex items-center gap-3 text-text-muted">
          <span>{rows.length} row(s)</span>
          {!hasAny && (
            <span className="text-amber-700">
              No v2 reconciliation rows yet — run rebuild-read-models.
            </span>
          )}
        </div>
        <Link
          href="/po-reconciliation"
          className="text-cyan-700 hover:text-cyan-800 underline"
        >
          ← Per-PO lens
        </Link>
      </div>

      <FilterBar sp={sp} />

      {rows.length === 0 ? (
        <EmptyState hasAny={hasAny} />
      ) : (
        <div className="space-y-3">
          {rows.map((row) => (
            <ReconciliationRow key={row.id} row={row} />
          ))}
        </div>
      )}

      <DisclosureFooter />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Filter bar
// ─────────────────────────────────────────────────────────────────────────────

function FilterBar({ sp }: { sp: SearchParams }) {
  return (
    <form
      action="/po-reconciliation-v2"
      className="flex flex-wrap items-end gap-2 rounded-md border border-border/60 bg-surface px-3 py-2 text-xs"
    >
      <Filter label="Scope" name="scope" value={sp.scope} options={["", ...SCOPE_TYPES]} />
      <Filter
        label="Overall confidence"
        name="conf"
        value={sp.conf}
        options={["", ...CONFIDENCES]}
      />
      <Filter
        label="Variance type"
        name="vKind"
        value={sp.vKind}
        options={["", ...VARIANCE_KINDS]}
        labels={(o) =>
          o ? VARIANCE_LABELS[o as VarianceKind].title : "any"
        }
      />
      <Filter
        label="Severity"
        name="vSev"
        value={sp.vSev}
        options={["", ...SEVERITIES]}
      />
      <Filter
        label="Source"
        name="source"
        value={sp.source}
        options={["", ...SOURCE_SYSTEMS]}
      />
      <label className="inline-flex items-center gap-1.5 ml-2">
        <input
          type="checkbox"
          name="varianceOnly"
          value="1"
          defaultChecked={sp.varianceOnly === "1"}
        />
        variance only
      </label>
      <label className="inline-flex items-center gap-1.5">
        <input
          type="checkbox"
          name="missingOnly"
          value="1"
          defaultChecked={sp.missingOnly === "1"}
        />
        missing-data only
      </label>
      <button
        type="submit"
        className="rounded bg-brand-700 hover:bg-brand-800 text-white px-3 py-1.5 text-xs font-medium"
      >
        Apply
      </button>
      <Link
        href="/po-reconciliation-v2"
        className="text-text-muted hover:text-text underline"
      >
        clear
      </Link>
    </form>
  );
}

function Filter({
  label,
  name,
  value,
  options,
  labels = (o) => (o === "" ? "any" : o),
}: {
  label: string;
  name: string;
  value: string | undefined;
  options: ReadonlyArray<string>;
  labels?: (option: string) => string;
}) {
  return (
    <label className="flex flex-col text-text-muted">
      <span className="uppercase tracking-wider mb-0.5 text-[10px]">{label}</span>
      <select
        name={name}
        defaultValue={value ?? ""}
        className="bg-surface border border-border/60 rounded px-2 py-1 text-xs text-text"
      >
        {options.map((o) => (
          <option key={o} value={o}>
            {labels(o)}
          </option>
        ))}
      </select>
    </label>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Empty state
// ─────────────────────────────────────────────────────────────────────────────

function EmptyState({ hasAny }: { hasAny: boolean }) {
  return (
    <div className="rounded-md border border-border/60 bg-surface p-5 text-sm text-text-muted">
      {!hasAny ? (
        <>
          <p className="font-medium text-text">
            No 8-bucket reconciliation rows yet.
          </p>
          <p className="mt-1">
            Rebuild from the event ledger (roll changes and packaging now
            refresh automatically; use this once to backfill history).
          </p>
          <form
            action={async () => {
              "use server";
              await rebuildAllMaterialProjectionsAction();
            }}
            className="mt-3"
          >
            <button
              type="submit"
              className="text-sm px-3 py-1.5 rounded border border-brand-accent/40 text-brand-accent hover:bg-brand-accent/10"
            >
              Rebuild material projections
            </button>
          </form>
        </>
      ) : (
        <p>No rows match the current filters.</p>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-row card
// ─────────────────────────────────────────────────────────────────────────────

function ReconciliationRow({ row }: { row: ReconciliationV2Row }) {
  const identityLine = [
    row.materialSku ? row.materialSku : null,
    row.materialName ? row.materialName : null,
    row.lotNumber ? `Lot ${row.lotNumber}` : null,
    row.rollNumber ? `Roll ${row.rollNumber}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <details className="group rounded-md border border-border/60 bg-surface">
      <summary className="cursor-pointer list-none px-4 py-3">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <div>
            <div className="text-[10px] uppercase tracking-wider text-text-muted">
              {row.scopeType} · {row.unit} ·{" "}
              {row.calculatedAt instanceof Date
                ? formatDateTimeEst(row.calculatedAt)
                : formatDateTimeEst(row.calculatedAt)}
            </div>
            <div className="text-sm font-semibold tracking-tight">
              {identityLine || row.scopeId.slice(0, 8)}
            </div>
            {row.materialKind && (
              <div className="text-[11px] text-text-muted">
                kind: <span className="font-mono">{row.materialKind}</span>
              </div>
            )}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[10px] uppercase tracking-wider text-text-muted">
              overall
            </span>
            <ConfidenceBadge confidence={row.overallConfidence} />
            <span className="text-[10px] text-text-muted ml-2 group-open:hidden">
              ▾ details
            </span>
            <span className="text-[10px] text-text-muted ml-2 hidden group-open:inline">
              ▴ collapse
            </span>
          </div>
        </div>

        <BucketGrid row={row} />
        <VarianceGrid row={row} />

        {row.warnings.length > 0 && (
          <div className="mt-2 rounded border border-amber-300 bg-amber-50 px-2 py-1 text-[11px] text-amber-900">
            <span className="font-semibold">Warnings:</span>{" "}
            {row.warnings.join(" · ")}
          </div>
        )}
      </summary>

      <DetailPanel row={row} />
    </details>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Bucket grid (7 typed buckets)
// ─────────────────────────────────────────────────────────────────────────────

function BucketGrid({ row }: { row: ReconciliationV2Row }) {
  return (
    <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2">
      <BucketCell title="Declared" subtitle="Supplier / box label" b={row.declared} />
      <BucketCell title="Counted" subtitle="Physical count" b={row.counted} />
      <BucketCell title="Accepted" subtitle="Inventory anchor" b={row.accepted} />
      <BucketCell
        title="Consumed (est.)"
        subtitle="BOM × output"
        b={row.consumedEstimated}
        estimatedHint
      />
      <BucketCell
        title="Consumed (actual)"
        subtitle="Weigh-back / depletion"
        b={row.consumedActual}
      />
      <BucketCell
        title="Scrapped / damaged"
        subtitle="Explicit unusable"
        b={row.scrappedOrDamaged}
      />
      <BucketCell title="On hand" subtitle="Remaining" b={row.onHand} />
    </div>
  );
}

function BucketCell({
  title,
  subtitle,
  b,
  estimatedHint,
}: {
  title: string;
  subtitle: string;
  b: ReconciliationV2BucketView;
  estimatedHint?: boolean;
}) {
  const isMissing = b.confidence === "MISSING" || b.value === null;
  return (
    <div
      className={`rounded border px-2 py-1.5 text-xs ${
        isMissing
          ? "border-slate-200 bg-slate-50/40 text-text-muted"
          : "border-border/60 bg-page"
      }`}
    >
      <div className="flex items-center justify-between gap-1">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-text-muted">
          {title}
        </div>
        <ConfidenceBadge confidence={b.confidence} />
      </div>
      <div className="text-[9px] text-text-subtle">{subtitle}</div>
      <div className="mt-1 font-mono tabular-nums">
        {isMissing ? (
          <span className="text-text-muted">—</span>
        ) : (
          <>
            {formatValue(b.value!)}{" "}
            <span className="text-[9px] text-text-muted">{b.unit}</span>
          </>
        )}
      </div>
      {b.source && (
        <div className="text-[10px] text-text-subtle truncate" title={b.source}>
          src: {b.source}
        </div>
      )}
      {estimatedHint && b.value !== null && (
        <div className="text-[9px] text-amber-700 mt-0.5">estimated, not measured</div>
      )}
      {b.missingInputs.length > 0 && (
        <div className="text-[9px] text-text-muted mt-0.5 truncate">
          missing: {b.missingInputs.join(", ")}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Variance grid — 4 PARALLEL columns, never collapsed
// ─────────────────────────────────────────────────────────────────────────────

function VarianceGrid({ row }: { row: ReconciliationV2Row }) {
  return (
    <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
      {VARIANCE_KINDS.map((kind) => (
        <VarianceCell key={kind} kind={kind} v={row.variances[kind]} unit={row.unit} />
      ))}
    </div>
  );
}

function VarianceCell({
  kind,
  v,
  unit,
}: {
  kind: VarianceKind;
  v: ReconciliationV2VarianceView;
  unit: string;
}) {
  const labels = VARIANCE_LABELS[kind];
  const sevColor: Record<VarianceSeverity, string> = {
    NONE: "border-emerald-200 bg-emerald-50/40 text-emerald-900",
    LOW: "border-emerald-300 bg-emerald-50 text-emerald-900",
    MEDIUM: "border-amber-300 bg-amber-50 text-amber-900",
    HIGH: "border-rose-300 bg-rose-50 text-rose-900",
    MISSING: "border-slate-200 bg-slate-50/40 text-text-muted",
  };
  return (
    <div className={`rounded border px-2 py-1.5 text-xs ${sevColor[v.severity]}`}>
      <div className="flex items-center justify-between gap-1">
        <div className="text-[10px] font-semibold uppercase tracking-wider">
          {labels.title}
        </div>
        <ConfidenceBadge confidence={v.confidence} />
      </div>
      <div className="text-[9px] opacity-80">{labels.subtitle}</div>
      <div className="mt-1 font-mono tabular-nums">
        {v.value === null ? (
          <span className="opacity-60">—</span>
        ) : (
          <>
            {v.value > 0 ? "+" : ""}
            {formatValue(v.value)}{" "}
            <span className="text-[9px] opacity-70">{unit}</span>
          </>
        )}
      </div>
      <div className="text-[10px] mt-0.5 opacity-80">severity: {v.severity}</div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Detail panel (expandable)
// ─────────────────────────────────────────────────────────────────────────────

function DetailPanel({ row }: { row: ReconciliationV2Row }) {
  return (
    <div className="border-t border-border/60 px-4 py-3 space-y-3">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 text-xs">
        <DetailKv label="scope_type" value={row.scopeType} />
        <DetailKv label="scope_id" value={row.scopeId} mono />
        <DetailKv label="unit" value={row.unit} />
        <DetailKv
          label="calculated_at"
          value={
            row.calculatedAt instanceof Date
              ? row.calculatedAt.toISOString()
              : new Date(row.calculatedAt).toISOString()
          }
          mono
        />
        {row.packagingLotId && (
          <DetailKv label="packaging_lot_id" value={row.packagingLotId} mono />
        )}
        {row.poId && <DetailKv label="po_id" value={row.poId} mono />}
        {row.materialKind && <DetailKv label="material_kind" value={row.materialKind} />}
      </div>

      <div className="text-[11px] text-text-muted leading-relaxed">
        <strong className="text-text">Confidence ladder.</strong> HIGH = physical
        count / weigh-back / cycle count. MEDIUM = supplier-declared or BOM-driven.
        LOW = legacy import or unclassifiable residual. MISSING = no source.
      </div>

      {Object.keys(row.sourceSnapshot).length > 0 && (
        <details>
          <summary className="cursor-pointer text-[11px] text-text-muted hover:text-text">
            Source snapshot
          </summary>
          <pre className="mt-1 rounded-md bg-surface-2 border border-border p-2 text-[10px] text-text-muted overflow-x-auto">
            {JSON.stringify(row.sourceSnapshot, null, 2)}
          </pre>
        </details>
      )}
    </div>
  );
}

function DetailKv({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-[10px] uppercase tracking-wider text-text-muted">
        {label}
      </span>
      <span className={mono ? "font-mono text-[11px]" : "text-[11px]"}>{value}</span>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Footer disclosure
// ─────────────────────────────────────────────────────────────────────────────

function DisclosureFooter() {
  return (
    <div className="rounded-md border border-border/60 bg-surface p-3 text-[11px] text-text-muted leading-relaxed">
      <p>
        <strong className="text-text">Reading the variance columns.</strong>{" "}
        The four variance subtypes are independent — they never sum into a single
        loss number.
      </p>
      <ul className="mt-1 list-disc list-inside space-y-0.5">
        <li>
          <strong>Receipt variance</strong> — declared vs counted at receipt.
          Vendor / shipping discrepancy.
        </li>
        <li>
          <strong>Cycle-count variance</strong> — physical count vs system expectation
          mid-life. Drift / shrink / mis-issue.
        </li>
        <li>
          <strong>Consumption variance</strong> — actual use vs BOM-driven expected use.
        </li>
        <li>
          <strong>Unknown variance</strong> — residual when the named buckets do not
          close. Investigate; never auto-classified.
        </li>
      </ul>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure formatters
// ─────────────────────────────────────────────────────────────────────────────

function formatValue(v: number): string {
  // Numeric(20,6) values come back trimmed; show whole numbers when
  // the fractional part is zero, else 2 decimal places. Unit-agnostic.
  if (Number.isInteger(v)) return v.toLocaleString();
  return v.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
}
