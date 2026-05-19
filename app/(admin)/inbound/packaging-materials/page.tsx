// LUMA-UI-FINAL-1 — packaging / material receiving.
//
// Chrome rebuilt on the standard design system.
// Data loading, actions, and QA filter logic are unchanged.

import Link from "next/link";
import { db } from "@/lib/db";
import { eq, asc, desc, sql, ne } from "drizzle-orm";
import { packagingMaterials, packagingLots } from "@/lib/db/schema";
import { requireAdmin } from "@/lib/auth-guards";
import {
  receivePackagingMaterialAction,
  receiveRollAction,
  voidPackagingLotAction,
} from "./actions";
import { isQaTestMaterial } from "@/lib/production/material-filters";
import {
  AlertTriangle,
  Box,
  Layers,
  Inbox,
  PackageCheck,
  Trash2,
} from "lucide-react";
import { ReceivingTabs } from "@/components/ui/receiving-tabs";
import { PageHeader } from "@/components/ui/page-header";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

const COUNT_KINDS_SQL = sql`(
  'DISPLAY','CASE','LABEL','BOTTLE','CAP','INDUCTION_SEAL','INSERT','SHRINK_BAND','OTHER',
  'HEAT_SEAL_FILM','DESICCANT','COTTON'
)`;
const ROLL_KINDS_SQL = sql`('PVC_ROLL','FOIL_ROLL','BLISTER_FOIL')`;

type SearchParams = Promise<{ tab?: string; show_qa?: string }>;

export default async function ReceivePackagingPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  await requireAdmin();
  const sp = await searchParams;
  const tab = sp.tab === "roll" ? "roll" : "count";
  const showQa = sp.show_qa === "true";

  const [countMaterialsRaw, rollMaterialsRaw, recentLots] = await Promise.all([
    db
      .select({
        id: packagingMaterials.id,
        sku: packagingMaterials.sku,
        name: packagingMaterials.name,
        kind: packagingMaterials.kind,
        uom: packagingMaterials.uom,
      })
      .from(packagingMaterials)
      .where(
        sql`${packagingMaterials.isActive} = true AND ${packagingMaterials.kind} IN ${COUNT_KINDS_SQL}`,
      )
      .orderBy(asc(packagingMaterials.name)),
    db
      .select({
        id: packagingMaterials.id,
        sku: packagingMaterials.sku,
        name: packagingMaterials.name,
        kind: packagingMaterials.kind,
      })
      .from(packagingMaterials)
      .where(
        sql`${packagingMaterials.isActive} = true AND ${packagingMaterials.kind} IN ${ROLL_KINDS_SQL}`,
      )
      .orderBy(asc(packagingMaterials.name)),
    db
      .select({
        id: packagingLots.id,
        rollNumber: packagingLots.rollNumber,
        qtyReceived: packagingLots.qtyReceived,
        netWeightGrams: packagingLots.netWeightGrams,
        receivedAt: packagingLots.receivedAt,
        status: packagingLots.status,
        confidence: packagingLots.confidence,
        materialName: packagingMaterials.name,
        materialKind: packagingMaterials.kind,
        sourceSystem: packagingLots.sourceSystem,
      })
      .from(packagingLots)
      .leftJoin(
        packagingMaterials,
        eq(packagingMaterials.id, packagingLots.packagingMaterialId),
      )
      .where(ne(packagingLots.status, "SCRAPPED"))
      .orderBy(desc(packagingLots.receivedAt))
      .limit(20),
  ]);

  const countMaterials = showQa
    ? countMaterialsRaw
    : countMaterialsRaw.filter((m) => !isQaTestMaterial(m));
  const rollMaterials = showQa
    ? rollMaterialsRaw
    : rollMaterialsRaw.filter((m) => !isQaTestMaterial(m));
  const countHiddenCount = countMaterialsRaw.length - countMaterials.length;
  const rollHiddenCount = rollMaterialsRaw.length - rollMaterials.length;
  const totalHidden = countHiddenCount + rollHiddenCount;

  const tabHref = (next: "count" | "roll") =>
    `/inbound/packaging-materials?tab=${next}${showQa ? "&show_qa=true" : ""}`;
  const qaToggleHref = `/inbound/packaging-materials?tab=${tab}${showQa ? "" : "&show_qa=true"}`;

  return (
    <div className="space-y-5">
      <ReceivingTabs />
      <PageHeader
        title="Receive packaging"
        description="Separate flows for count-based packaging (bottles, caps, labels, displays, cases) and roll materials (PVC, foil). PackTrack receipts arrive automatically when configured."
      />

      {/* Stats row */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="rounded-xl border border-border bg-surface px-4 py-3">
          <p className="text-[10px] uppercase tracking-wider text-text-subtle font-medium">Count materials</p>
          <p className="text-2xl font-mono tabular-nums text-text-strong mt-1">{countMaterials.length}</p>
          <p className="text-[11px] text-text-muted mt-0.5">Bottles, caps, labels, displays, cases</p>
        </div>
        <div className="rounded-xl border border-border bg-surface px-4 py-3">
          <p className="text-[10px] uppercase tracking-wider text-text-subtle font-medium">Roll materials</p>
          <p className="text-2xl font-mono tabular-nums text-text-strong mt-1">{rollMaterials.length}</p>
          <p className="text-[11px] text-text-muted mt-0.5">PVC, foil, blister film</p>
        </div>
        <div className="rounded-xl border border-border bg-surface px-4 py-3">
          <p className="text-[10px] uppercase tracking-wider text-text-subtle font-medium">Recent receipts</p>
          <p className="text-2xl font-mono tabular-nums text-text-strong mt-1">{recentLots.length}</p>
          <p className="text-[11px] text-text-muted mt-0.5">Last 20 across both types</p>
        </div>
        <div className="rounded-xl border border-border bg-surface px-4 py-3">
          <p className="text-[10px] uppercase tracking-wider text-text-subtle font-medium">Source</p>
          <p className="text-2xl font-mono tabular-nums text-text-strong mt-1">
            {recentLots.some((l) => l.sourceSystem === "PACKTRACK") ? "PackTrack" : "Manual"}
          </p>
          <p className="text-[11px] text-text-muted mt-0.5">Most recent receipt source</p>
        </div>
      </div>

      {countMaterialsRaw.length === 0 && rollMaterialsRaw.length === 0 ? (
        <div className="rounded-xl border border-warn-200 bg-warn-50/60 px-4 py-3 text-[12px] text-warn-800 flex items-start gap-2.5">
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
          <div>
            <p className="font-semibold">No active material items configured</p>
            <p className="mt-0.5">
              Create materials at{" "}
              <Link
                href="/settings/materials"
                className="underline underline-offset-2"
              >
                Settings → Materials
              </Link>{" "}
              before receiving.
            </p>
          </div>
        </div>
      ) : null}

      {/* Tab + form section */}
      <div className="rounded-xl border border-border bg-surface overflow-hidden">
        {/* Tab bar */}
        <div className="flex items-center gap-1 px-4 pt-4 pb-0">
          <Link
            href={tabHref("count")}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12px] font-medium border transition-colors",
              tab === "count"
                ? "bg-brand-600 border-brand-700 text-white shadow-sm"
                : "border-border bg-surface text-text-muted hover:bg-surface-2 hover:text-text",
            )}
          >
            <Box className="h-3.5 w-3.5" />
            Count-based ({countMaterials.length})
          </Link>
          <Link
            href={tabHref("roll")}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12px] font-medium border transition-colors",
              tab === "roll"
                ? "bg-brand-600 border-brand-700 text-white shadow-sm"
                : "border-border bg-surface text-text-muted hover:bg-surface-2 hover:text-text",
            )}
          >
            <Layers className="h-3.5 w-3.5" />
            Roll materials ({rollMaterials.length})
          </Link>
          <div className="ml-auto">
            <Link
              href={qaToggleHref}
              className="text-[11px] text-text-subtle hover:text-text-muted underline underline-offset-2 transition-colors"
            >
              {showQa
                ? "Hide QA / test materials"
                : totalHidden > 0
                  ? `${totalHidden} QA/test hidden · show`
                  : "No QA materials"}
            </Link>
          </div>
        </div>

        {/* Section header */}
        <div className="px-4 pt-4 pb-2">
          <p className="text-sm font-semibold text-text-strong">
            {tab === "count"
              ? "Bottles, caps, labels, display boxes, master cases"
              : "PVC rolls and foil rolls"}
          </p>
          <p className="text-[11px] text-text-muted mt-0.5">
            {tab === "count"
              ? "Tracked by units of measure. Consumed during packaging, not by roll weight."
              : "Each roll has a roll number, gross/net weight, and is consumed gradually through roll-usage events at the blister machine."}
          </p>
        </div>

        {/* Form content */}
        <div className="px-4 pb-4">
          {tab === "count" ? (
            countMaterialsRaw.length === 0 ? (
              <div className="px-4 py-8 text-center">
                <PackageCheck className="h-8 w-8 mx-auto mb-2 text-text-subtle" />
                <p className="text-sm font-medium text-text-muted">No count-based materials configured</p>
                <p className="text-[11px] text-text-subtle mt-1">Add materials at Settings → Materials.</p>
              </div>
            ) : (
              <form
                action={async (fd) => {
                  "use server";
                  await receivePackagingMaterialAction(fd);
                }}
                className="grid grid-cols-1 sm:grid-cols-2 gap-3"
              >
                <FormField
                  name="packagingMaterialId"
                  label="Material"
                  required
                  type="select"
                  options={countMaterialsRaw.map((m) => ({
                    value: m.id,
                    label: `${m.sku} — ${m.name} (${m.kind} · ${m.uom})`,
                  }))}
                />
                <FormField
                  name="qtyReceived"
                  label="Quantity received"
                  type="number"
                  min={1}
                  required
                />
                <FormField
                  name="uom"
                  label="Unit"
                  defaultValue="each"
                  required
                />
                <FormField
                  name="lotNumber"
                  label="Lot number"
                  placeholder="auto-generated if blank"
                />
                <FormField name="supplier" label="Supplier" />
                <FormField
                  name="receiptNumber"
                  label="PO / receipt reference"
                />
                <FormField
                  name="location"
                  label="Storage location"
                  placeholder="warehouse / aisle / bin"
                />
                <FormField name="notes" label="Notes" />
                <div className="sm:col-span-2 flex items-center justify-between pt-1">
                  <p className="text-[11px] text-text-muted">
                    Manual receipt.{" "}
                    <span className="font-mono text-[10px] bg-surface-2 border border-border rounded px-1">
                      PackTrack
                    </span>{" "}
                    receipts arrive automatically via webhook when configured.
                  </p>
                  <FormSubmit label="Save material receipt" />
                </div>
              </form>
            )
          ) : (
            <>
              <div className="mb-4 rounded-xl border border-sky-200 bg-sky-50/60 px-4 py-3 text-[12px] text-sky-800 leading-relaxed">
                Rolls are not packaging boxes. Each roll has a roll number, a
                gross/net weight, optional width and thickness, and is consumed
                gradually through roll-usage events at the blister machine.
              </div>
              {rollMaterialsRaw.length === 0 ? (
                <div className="px-4 py-8 text-center">
                  <Layers className="h-8 w-8 mx-auto mb-2 text-text-subtle" />
                  <p className="text-sm font-medium text-text-muted">No PVC/foil materials configured</p>
                  <p className="text-[11px] text-text-subtle mt-1">Add roll materials at Settings → Materials.</p>
                </div>
              ) : (
                <form
                  action={async (fd) => {
                    "use server";
                    await receiveRollAction(fd);
                  }}
                  className="grid grid-cols-1 sm:grid-cols-2 gap-3"
                >
                  <FormField
                    name="packagingMaterialId"
                    label="Roll material"
                    required
                    type="select"
                    options={rollMaterialsRaw.map((m) => ({
                      value: m.id,
                      label: `${m.sku} — ${m.name} (${m.kind})`,
                    }))}
                  />
                  <FormField
                    name="rollNumber"
                    label="Roll number"
                    required
                    placeholder="e.g. PVC-23-A-04"
                  />
                  <FormField
                    name="grossWeightGrams"
                    label="Gross weight (g)"
                    type="number"
                    min={0}
                  />
                  <FormField
                    name="tareWeightGrams"
                    label="Tare weight (g)"
                    type="number"
                    min={0}
                  />
                  <FormField
                    name="netWeightGrams"
                    label="Net weight (g — only if no tare)"
                    type="number"
                    min={0}
                  />
                  <FormField
                    name="weightUnit"
                    label="Weight unit"
                    required
                    type="select"
                    options={[
                      { value: "g", label: "grams" },
                      { value: "kg", label: "kg" },
                      { value: "lb", label: "lb" },
                    ]}
                  />
                  <FormField
                    name="widthMm"
                    label="Width (mm)"
                    type="number"
                    min={0}
                  />
                  <FormField
                    name="thicknessMicrons"
                    label="Thickness (μm)"
                    type="number"
                    min={0}
                  />
                  <FormField
                    name="materialSpec"
                    label="Material spec"
                    placeholder="PVC clear 250μ"
                  />
                  <FormField
                    name="coreWeightGrams"
                    label="Core weight (g)"
                    type="number"
                    min={0}
                  />
                  <FormField name="supplier" label="Supplier" />
                  <FormField
                    name="receiptNumber"
                    label="PO / receipt reference"
                  />
                  <FormField name="lotNumber" label="Supplier lot number" />
                  <FormField name="location" label="Storage location" />
                  <FormField name="notes" label="Notes" />
                  <div className="sm:col-span-2 flex items-center justify-between pt-1">
                    <p className="text-[11px] text-text-muted">
                      Net weight = gross − tare. If you only know the net weight,
                      enter it directly — the lot is tagged{" "}
                      <span className="font-semibold">confidence MEDIUM</span>.
                    </p>
                    <FormSubmit label="Receive roll" />
                  </div>
                </form>
              )}
            </>
          )}
        </div>
      </div>

      {/* Recent receipts */}
      <div className="rounded-xl border border-border bg-surface overflow-hidden">
        <div className="px-4 pt-4 pb-2">
          <p className="text-sm font-semibold text-text-strong">Recent receipts</p>
          <p className="text-[11px] text-text-muted mt-0.5">Last 20 packaging lots across both types.</p>
        </div>
        <div className="px-4 pb-4">
          {recentLots.length === 0 ? (
            <div className="px-4 py-8 text-center">
              <Inbox className="h-8 w-8 mx-auto mb-2 text-text-subtle" />
              <p className="text-sm font-medium text-text-muted">No lots received yet</p>
              <p className="text-[11px] text-text-subtle mt-1">Receipts appear here after saving a count-based or roll material form above.</p>
            </div>
          ) : (
            <div className="overflow-x-auto -mx-1">
              <table className="min-w-full text-[12px]">
                <thead>
                  <tr className="border-b border-border/60">
                    <th className="text-left px-3 py-2 text-[10px] uppercase tracking-[0.12em] text-text-subtle font-semibold">
                      Received
                    </th>
                    <th className="text-left px-3 py-2 text-[10px] uppercase tracking-[0.12em] text-text-subtle font-semibold">
                      Material
                    </th>
                    <th className="text-left px-3 py-2 text-[10px] uppercase tracking-[0.12em] text-text-subtle font-semibold">
                      Kind
                    </th>
                    <th className="text-left px-3 py-2 text-[10px] uppercase tracking-[0.12em] text-text-subtle font-semibold">
                      Roll #
                    </th>
                    <th className="text-right px-3 py-2 text-[10px] uppercase tracking-[0.12em] text-text-subtle font-semibold">
                      Qty
                    </th>
                    <th className="text-right px-3 py-2 text-[10px] uppercase tracking-[0.12em] text-text-subtle font-semibold">
                      Net g
                    </th>
                    <th className="text-left px-3 py-2 text-[10px] uppercase tracking-[0.12em] text-text-subtle font-semibold">
                      Source
                    </th>
                    <th className="text-left px-3 py-2 text-[10px] uppercase tracking-[0.12em] text-text-subtle font-semibold">
                      Conf.
                    </th>
                    <th className="px-3 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {recentLots.map((l) => (
                    <tr
                      key={l.id}
                      className="border-b border-border/30 hover:bg-surface-2/40 transition-colors"
                    >
                      <td className="px-3 py-2.5 font-mono text-[10.5px] text-text-muted">
                        {l.receivedAt instanceof Date
                          ? l.receivedAt
                              .toISOString()
                              .slice(0, 16)
                              .replace("T", " ")
                          : String(l.receivedAt).slice(0, 16)}
                      </td>
                      <td className="px-3 py-2.5 font-medium text-text-strong">
                        {l.materialName ?? "—"}
                      </td>
                      <td className="px-3 py-2.5 text-text-muted">
                        {l.materialKind ?? "—"}
                      </td>
                      <td className="px-3 py-2.5 font-mono text-[11px]">
                        {l.rollNumber ?? "—"}
                      </td>
                      <td className="px-3 py-2.5 text-right font-mono tabular-nums">
                        {l.qtyReceived ?? "—"}
                      </td>
                      <td className="px-3 py-2.5 text-right font-mono tabular-nums text-text-muted">
                        {l.netWeightGrams ?? "—"}
                      </td>
                      <td className="px-3 py-2.5">
                        <span
                          className={cn(
                            "inline-flex items-center h-5 px-2 rounded border text-[10px] font-mono",
                            l.sourceSystem === "PACKTRACK"
                              ? "border-sky-200 bg-sky-50/60 text-sky-800"
                              : "border-border bg-surface-2/60 text-text-muted",
                          )}
                        >
                          {l.sourceSystem === "PACKTRACK"
                            ? "PackTrack"
                            : l.sourceSystem === "MANUAL_LUMA"
                              ? "Manual"
                              : (l.sourceSystem ?? "—")}
                        </span>
                      </td>
                      <td className="px-3 py-2.5">
                        <ConfidenceChip value={l.confidence} />
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        <form
                          action={async (fd) => {
                            "use server";
                            await voidPackagingLotAction(fd);
                          }}
                        >
                          <input type="hidden" name="id" value={l.id} />
                          <button
                            type="submit"
                            className="inline-flex items-center gap-1 text-[11px] text-text-subtle hover:text-red-600 transition-colors px-1 py-0.5 rounded"
                            title="Delete this lot"
                          >
                            <Trash2 className="h-3 w-3" />
                            Delete
                          </button>
                        </form>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Local form primitives
// ─────────────────────────────────────────────────────────────────────

function FormField({
  name,
  label,
  type = "text",
  required,
  placeholder,
  defaultValue,
  min,
  max,
  step,
  options,
}: {
  name: string;
  label: string;
  type?: string;
  required?: boolean;
  placeholder?: string;
  defaultValue?: string;
  min?: number;
  max?: number;
  step?: string;
  options?: ReadonlyArray<{ value: string; label: string }>;
}) {
  const inputClass =
    "mt-1 w-full h-9 px-2.5 rounded-lg border border-border bg-surface-2/60 text-[12.5px] text-text-strong placeholder:text-text-subtle focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20 focus:outline-none transition-colors";

  if (type === "select" && options) {
    return (
      <label className="block">
        <span className="text-[11px] text-text-muted font-medium">{label}</span>
        <select
          name={name}
          required={required}
          defaultValue=""
          className={inputClass}
        >
          <option value="">— select —</option>
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
    );
  }

  return (
    <label className="block">
      <span className="text-[11px] text-text-muted font-medium">{label}</span>
      <input
        name={name}
        type={type}
        required={required}
        placeholder={placeholder}
        defaultValue={defaultValue}
        {...(min != null ? { min } : {})}
        {...(max != null ? { max } : {})}
        {...(step ? { step } : {})}
        className={inputClass}
      />
    </label>
  );
}

function FormSubmit({ label }: { label: string }) {
  return (
    <button
      type="submit"
      className="h-9 px-5 rounded-lg bg-brand-600 hover:bg-brand-700 active:bg-brand-800 text-white text-[12.5px] font-semibold tracking-tight shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/60 shrink-0"
    >
      {label}
    </button>
  );
}

function ConfidenceChip({ value }: { value: string | null | undefined }) {
  if (!value) return <span className="text-text-subtle italic text-[11px]">—</span>;
  const map: Record<string, string> = {
    HIGH: "bg-good-50/80 text-good-700 border-good-500/30",
    MEDIUM: "bg-warn-50/80 text-warn-700 border-warn-500/30",
    LOW: "bg-crit-50/80 text-crit-700 border-crit-500/30",
    MISSING: "bg-surface-2 text-text-subtle border-border",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center h-5 px-1.5 rounded border text-[10px] font-semibold uppercase tracking-wider",
        map[value] ?? map["MISSING"],
      )}
    >
      {value}
    </span>
  );
}
