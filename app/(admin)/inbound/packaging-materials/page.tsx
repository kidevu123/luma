// WORKFLOW-CLEANUP-2 — material receiving with clear separation between
// count-based packaging and PVC/foil rolls. Two tabs, no side-by-side
// confusion. QA/test materials hidden by default.

import Link from "next/link";
import { db } from "@/lib/db";
import { eq, asc, desc, sql } from "drizzle-orm";
import { packagingMaterials, packagingLots } from "@/lib/db/schema";
import { requireAdmin } from "@/lib/auth-guards";
import { PageHeader } from "@/components/ui/page-header";
import {
  ProductionAlertCard,
  ProductionSection,
} from "@/components/production/ui";
import {
  receivePackagingMaterialAction,
  receiveRollAction,
} from "./actions";
import { isQaTestMaterial } from "@/lib/production/material-filters";

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

  const tabHref = (next: "count" | "roll") =>
    `/inbound/packaging-materials?tab=${next}${showQa ? "&show_qa=true" : ""}`;
  const qaToggleHref = `/inbound/packaging-materials?tab=${tab}${showQa ? "" : "&show_qa=true"}`;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Receive packaging / materials"
        description="Separate flows for count-based packaging (bottles, caps, labels, displays, cases) and roll materials (PVC, foil). Each save fires a MATERIAL_RECEIVED inventory event the read models pick up on next rebuild."
      />

      {countMaterialsRaw.length === 0 && rollMaterialsRaw.length === 0 ? (
        <ProductionAlertCard
          tone="WARN"
          title="No active material items"
          body={
            <>
              Create materials at <Link href="/settings/materials" className="underline">/settings/materials</Link> before
              receiving.
            </>
          }
        />
      ) : null}

      {/* Tab switcher */}
      <div className="flex items-center gap-2 border-b border-border/60 pb-1">
        <Link
          href={tabHref("count")}
          className={`px-3 py-1.5 rounded-t-md text-sm border-b-2 ${
            tab === "count"
              ? "border-brand-500 text-brand-800 font-medium"
              : "border-transparent text-text-muted hover:bg-surface-2"
          }`}
        >
          Count-based packaging ({countMaterials.length})
        </Link>
        <Link
          href={tabHref("roll")}
          className={`px-3 py-1.5 rounded-t-md text-sm border-b-2 ${
            tab === "roll"
              ? "border-brand-500 text-brand-800 font-medium"
              : "border-transparent text-text-muted hover:bg-surface-2"
          }`}
        >
          Roll materials ({rollMaterials.length})
        </Link>
        <div className="ml-auto text-xs">
          <Link
            href={qaToggleHref}
            className="text-text-muted hover:text-text"
            title={
              showQa
                ? "Hide QA / test materials from the picker"
                : "Show QA / test materials (for staging verification)"
            }
          >
            {showQa
              ? `Hiding none · click to hide QA`
              : `Hiding ${countHiddenCount + rollHiddenCount} QA / test material${
                  countHiddenCount + rollHiddenCount === 1 ? "" : "s"
                } · click to show`}
          </Link>
        </div>
      </div>

      {tab === "count" ? (
        <ProductionSection
          title="Count-based packaging"
          subtitle="Bottles, caps, labels, displays, cases, induction seals. Tracked by units of measure (each / kg / box). PVC and foil rolls are on the other tab."
          tone="INFO"
        >
          {countMaterials.length === 0 ? (
            <p className="text-sm text-text-muted">
              {showQa
                ? "No count-based materials configured."
                : "No active count-based materials. Add one at /settings/materials, or toggle QA visibility above."}
            </p>
          ) : (
            <form
              action={async (fd) => {
                "use server";
                await receivePackagingMaterialAction(fd);
              }}
              className="grid grid-cols-1 sm:grid-cols-2 gap-3"
            >
              <SelectField
                name="packagingMaterialId"
                label="Material"
                required
                options={countMaterials.map((m) => ({
                  value: m.id,
                  label: `${m.sku} — ${m.name} (${m.kind} · ${m.uom})`,
                }))}
              />
              <Field name="qtyReceived" label="Quantity received" type="number" min={1} required />
              <Field name="uom" label="Unit" defaultValue="each" required />
              <Field name="lotNumber" label="Lot # (optional)" placeholder="auto if blank" />
              <Field name="supplier" label="Supplier (optional)" />
              <Field name="receiptNumber" label="PO / receipt reference (optional)" />
              <Field name="location" label="Storage location (optional)" placeholder="warehouse / aisle / bin" />
              <Field name="notes" label="Notes (optional)" />
              <div className="sm:col-span-2 flex justify-end">
                <SubmitButton label="Receive count-based material" />
              </div>
              <p className="sm:col-span-2 text-[11px] text-text-muted">
                Manual material receipt. PackTrack-origin receipts arrive via the webhook
                at <code>/api/integrations/packtrack/receipts</code> when configured.
              </p>
            </form>
          )}
        </ProductionSection>
      ) : (
        <ProductionSection
          title="Roll materials"
          subtitle="PVC rolls and foil rolls. Tracked per-roll with gross/net weight and roll number. Consumed through roll-usage on the floor, not by unit count."
          tone="INFO"
        >
          <ProductionAlertCard
            tone="INFO"
            title="Roll inventory model"
            body="Rolls are not packaging boxes. Each roll has a roll number, a gross/net weight, optional width / thickness, and is consumed gradually through roll-usage events at the blister machine."
          />
          {rollMaterials.length === 0 ? (
            <p className="mt-3 text-sm text-text-muted">
              {showQa
                ? "No PVC/foil materials configured."
                : "No active roll materials. Add one at /settings/materials, or toggle QA visibility above."}
            </p>
          ) : (
            <form
              action={async (fd) => {
                "use server";
                await receiveRollAction(fd);
              }}
              className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3"
            >
              <SelectField
                name="packagingMaterialId"
                label="Roll material"
                required
                options={rollMaterials.map((m) => ({
                  value: m.id,
                  label: `${m.sku} — ${m.name} (${m.kind})`,
                }))}
              />
              <Field name="rollNumber" label="Roll number" required placeholder="e.g. PVC-23-A-04" />
              <Field name="grossWeightGrams" label="Gross weight (g)" type="number" min={0} />
              <Field name="tareWeightGrams" label="Tare weight (g, optional)" type="number" min={0} />
              <Field
                name="netWeightGrams"
                label="Net weight (g — only if no tare)"
                type="number"
                min={0}
              />
              <SelectField
                name="weightUnit"
                label="Weight unit"
                required
                options={[
                  { value: "g", label: "grams" },
                  { value: "kg", label: "kg" },
                  { value: "lb", label: "lb" },
                ]}
              />
              <Field name="widthMm" label="Width (mm, optional)" type="number" min={0} />
              <Field name="thicknessMicrons" label="Thickness (μm, optional)" type="number" min={0} />
              <Field name="materialSpec" label="Material spec (optional)" placeholder="PVC clear 250μ" />
              <Field name="coreWeightGrams" label="Core weight (g, optional)" type="number" min={0} />
              <Field name="supplier" label="Supplier (optional)" />
              <Field name="receiptNumber" label="PO / receipt reference (optional)" />
              <Field name="lotNumber" label="Supplier lot # (optional)" />
              <Field name="location" label="Storage location (optional)" />
              <Field name="notes" label="Notes (optional)" />
              <div className="sm:col-span-2 flex justify-end">
                <SubmitButton label="Receive roll" />
              </div>
              <p className="sm:col-span-2 text-[11px] text-text-muted">
                Net weight = gross − tare. If you only know the net weight,
                enter it directly — the lot is tagged confidence MEDIUM.
              </p>
            </form>
          )}
        </ProductionSection>
      )}

      {/* Recent lots (shared across both tabs) */}
      <ProductionSection title="Recent receipts" subtitle="Last 20 packaging lots across both modes.">
        <div className="overflow-x-auto rounded-md border border-border/60">
          <table className="min-w-full text-sm">
            <thead className="bg-surface-2 text-[10px] uppercase tracking-wider text-text-muted">
              <tr>
                <th className="text-left px-3 py-2">Received</th>
                <th className="text-left px-3 py-2">Material</th>
                <th className="text-left px-3 py-2">Kind</th>
                <th className="text-left px-3 py-2">Roll #</th>
                <th className="text-right px-3 py-2">Qty</th>
                <th className="text-right px-3 py-2">Net g</th>
                <th className="text-left px-3 py-2">Source</th>
                <th className="text-left px-3 py-2">Conf.</th>
              </tr>
            </thead>
            <tbody>
              {recentLots.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-3 py-6 text-center text-text-muted">
                    No lots received yet.
                  </td>
                </tr>
              ) : (
                recentLots.map((l) => (
                  <tr key={l.id} className="border-t border-border/40">
                    <td className="px-3 py-2 font-mono text-[11px]">
                      {l.receivedAt instanceof Date
                        ? l.receivedAt.toISOString().slice(0, 16).replace("T", " ")
                        : String(l.receivedAt).slice(0, 16)}
                    </td>
                    <td className="px-3 py-2">{l.materialName ?? "—"}</td>
                    <td className="px-3 py-2 text-text-muted">{l.materialKind ?? "—"}</td>
                    <td className="px-3 py-2 font-mono">{l.rollNumber ?? "—"}</td>
                    <td className="px-3 py-2 text-right font-mono">{l.qtyReceived}</td>
                    <td className="px-3 py-2 text-right font-mono">{l.netWeightGrams ?? "—"}</td>
                    <td className="px-3 py-2 font-mono text-[11px]">
                      {l.sourceSystem === "PACKTRACK"
                        ? "PackTrack"
                        : l.sourceSystem === "MANUAL_LUMA"
                          ? "Manual"
                          : (l.sourceSystem ?? "—")}
                    </td>
                    <td className="px-3 py-2 font-mono text-[11px]">{l.confidence ?? "—"}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </ProductionSection>
    </div>
  );
}

function Field({
  name,
  label,
  type = "text",
  required,
  placeholder,
  defaultValue,
  min,
  max,
  step,
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
}) {
  return (
    <label className="block">
      <span className="text-[10px] uppercase tracking-[0.10em] text-text-muted">{label}</span>
      <input
        name={name}
        type={type}
        required={required}
        placeholder={placeholder}
        defaultValue={defaultValue}
        {...(min != null ? { min } : {})}
        {...(max != null ? { max } : {})}
        {...(step ? { step } : {})}
        className="mt-1 w-full h-9 px-2 rounded-md border border-border bg-surface text-sm focus:border-brand-500 focus:outline-none"
      />
    </label>
  );
}

function SelectField({
  name,
  label,
  options,
  required,
}: {
  name: string;
  label: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  required?: boolean;
}) {
  return (
    <label className="block">
      <span className="text-[10px] uppercase tracking-[0.10em] text-text-muted">{label}</span>
      <select
        name={name}
        required={required}
        defaultValue=""
        className="mt-1 w-full h-9 px-2 rounded-md border border-border bg-surface text-sm focus:border-brand-500 focus:outline-none"
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

function SubmitButton({ label }: { label: string }) {
  return (
    <button
      type="submit"
      className="h-9 px-4 rounded-md bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium"
    >
      {label}
    </button>
  );
}
