// Phase VALIDATION-2A — Floor variety-pack component allocation UI.
//
// A variety-pack product needs multiple raw components (FLAVOR_A,
// FLAVOR_B, FLAVOR_C, etc.). The operator opens one allocation
// session per slot, each with the right component_role recorded.
// Closing each slot's session captures the consumed quantity and
// links to a finished_lot when one is supplied. The page also shows
// the live reconciliation preview (expected vs actual per role)
// using deriveVarietyPackReconciliation.
//
// Three-state page flow:
//   State A — No product selected: show product picker only.
//   State B — productId in URL, no varietyRunId: show product picker
//             + "Start / Resume Variety Run" panel.
//   State C — productId + varietyRunId in URL: show run info header,
//             component slots, close button.
//
// Empty-state vocabulary:
//   • "No variety pack products configured" (no products with
//     product_component_requirements rows)
//   • "Variety pack component requirements missing" (selected
//     product has no requirements)
//   • "No finished lot yet — preview will populate once one is
//     created" (rec preview when no lot)

import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { QrCode } from "lucide-react";
import { db } from "@/lib/db";
import { stations, machines } from "@/lib/db/schema";
import {
  openAllocationSessionAction,
  closeAllocationSessionAction,
  returnRawBagAction,
  markBagDepletedAction,
} from "../bag-allocation-actions";
import {
  startOrResumeVarietyRunAction,
  closeVarietyRunAction,
} from "../variety-run-actions";
import {
  deriveVarietyPackComponentRequirements,
  deriveVarietyPackReconciliation,
} from "@/lib/production/variety-pack";

export const dynamic = "force-dynamic";

const QTY_SOURCES = [
  ["MACHINE_COUNTER", "Machine counter"],
  ["FINISHED_LOT_INPUT", "Finished lot input"],
  ["MANUAL_ENTRY", "Manual entry"],
  ["ESTIMATED", "Estimated"],
] as const;

export default async function VarietyPackPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ productId?: string; finishedLotId?: string; varietyRunId?: string; error?: string }>;
}) {
  const { token } = await params;
  const sp = await searchParams;

  const [stationRow] = await db
    .select({ station: stations, machine: machines })
    .from(stations)
    .leftJoin(machines, eq(stations.machineId, machines.id))
    .where(eq(stations.scanToken, token));
  if (!stationRow) notFound();
  const { station, machine } = stationRow;

  // Variety-style products = any product with at least one active
  // product_component_requirements row.
  type VarietyProduct = {
    id: string;
    sku: string;
    name: string;
    component_count: number;
  };
  const varietyProducts = (await db.execute<VarietyProduct>(sql`
    SELECT
      p.id::text                             AS id,
      p.sku                                  AS sku,
      p.name                                 AS name,
      COUNT(pcr.id)::int                     AS component_count
    FROM products p
    JOIN product_component_requirements pcr ON pcr.product_id = p.id AND pcr.is_active = true
    WHERE p.is_active = true
    GROUP BY p.id
    ORDER BY p.name
  `)) as unknown as VarietyProduct[];

  const selectedProductId = sp.productId ?? varietyProducts[0]?.id ?? null;

  // ── State C: load and validate variety run ──────────────────────────
  type RunRow = { id: string; parentScanToken: string; status: string; openedAt: string; productId: string | null };
  let activeRun: RunRow | null = null;

  if (sp.varietyRunId && selectedProductId) {
    const runRows = await db.execute<RunRow>(sql`
      SELECT id::text, parent_scan_token AS "parentScanToken", status, opened_at::text AS "openedAt", product_id::text AS "productId"
      FROM variety_runs WHERE id = ${sp.varietyRunId} LIMIT 1
    `);
    const run = runRows[0] ?? null;
    // If not found or already closed/void, redirect back without varietyRunId
    if (!run || run.status === "CLOSED" || run.status === "VOID") {
      redirect(`/floor/${token}/variety-pack?productId=${selectedProductId}`);
    }
    activeRun = run;
  }

  // Per-component allocation state (open sessions + matching available bags).
  let requirements: Awaited<ReturnType<typeof deriveVarietyPackComponentRequirements>> = [];
  let openSessionsByRole: Map<string, OpenSession[]> = new Map();
  let availableBagsByItemId: Map<string, AvailableBag[]> = new Map();
  let reconciliation: Awaited<ReturnType<typeof deriveVarietyPackReconciliation>> = null;

  // Only load sessions and reconciliation in State C (varietyRunId present)
  if (selectedProductId && activeRun) {
    requirements = await deriveVarietyPackComponentRequirements(selectedProductId);

    type SessRow = OpenSession & { component_role: string | null };
    const openRows = (await db.execute<SessRow>(sql`
      SELECT
        s.id::text                       AS session_id,
        s.inventory_bag_id::text         AS inventory_bag_id,
        s.component_role                 AS component_role,
        ib.bag_number                    AS bag_number,
        ib.vendor_barcode                AS vendor_barcode,
        ib.bag_qr_code                   AS bag_qr_code,
        ib.tablet_type_id::text          AS tablet_type_id,
        tt.name                          AS raw_item_name,
        s.starting_balance_qty           AS starting_balance_qty,
        s.consumed_qty                   AS consumed_qty,
        s.opened_at::text                AS opened_at
      FROM raw_bag_allocation_sessions s
      JOIN inventory_bags ib ON ib.id = s.inventory_bag_id
      LEFT JOIN tablet_types tt ON tt.id = ib.tablet_type_id
      WHERE s.variety_run_id = ${activeRun.id}
        AND s.allocation_status = 'OPEN'
      ORDER BY s.opened_at DESC
    `)) as unknown as SessRow[];
    for (const r of openRows) {
      const role = r.component_role ?? "(unassigned)";
      const arr = openSessionsByRole.get(role) ?? [];
      arr.push(r);
      openSessionsByRole.set(role, arr);
    }

    // Available bags grouped by tablet_type → items.id (the same
    // mapping product_component_requirements uses).
    type BagRow = AvailableBag & { item_id: string };
    const bagRows = (await db.execute<BagRow>(sql`
      SELECT
        ib.id::text             AS id,
        ib.bag_number           AS bag_number,
        ib.vendor_barcode       AS vendor_barcode,
        ib.pill_count           AS pill_count,
        ib.tablet_type_id::text AS tablet_type_id,
        tt.name                 AS raw_item_name,
        po.po_number            AS po_number,
        it.id::text             AS item_id
      FROM inventory_bags ib
      LEFT JOIN tablet_types tt ON tt.id = ib.tablet_type_id
      LEFT JOIN small_boxes sb ON sb.id = ib.small_box_id
      LEFT JOIN receives r ON r.id = sb.receive_id
      LEFT JOIN purchase_orders po ON po.id = r.po_id
      LEFT JOIN items it ON it.source_kind = 'TABLET_TYPE' AND it.source_id = ib.tablet_type_id
      WHERE ib.status = 'AVAILABLE'
      ORDER BY tt.name, ib.bag_number
      LIMIT 200
    `)) as unknown as BagRow[];
    for (const b of bagRows) {
      if (!b.item_id) continue;
      const arr = availableBagsByItemId.get(b.item_id) ?? [];
      arr.push(b);
      availableBagsByItemId.set(b.item_id, arr);
    }

    // Reconciliation preview (live, derives from current state).
    reconciliation = await deriveVarietyPackReconciliation(
      sp.finishedLotId
        ? { productId: selectedProductId, finishedLotId: sp.finishedLotId }
        : { productId: selectedProductId },
    );
  }

  // Compute openSessionCount for the Close Variety Run section
  let openSessionCount = 0;
  for (const sessions of openSessionsByRole.values()) {
    openSessionCount += sessions.length;
  }

  return (
    <main className="min-h-dvh bg-page p-4 sm:p-6 max-w-2xl mx-auto space-y-5">
      <header>
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-text-subtle">
          Variety pack allocation
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">{station.label}</h1>
        <p className="text-xs text-text-muted">
          {station.kind}
          {machine ? ` · ${machine.name}` : ""}
        </p>
        <FloorNav token={token} />
      </header>

      {/* Product picker — shown in all states */}
      <Section title="Variety pack product">
        {varietyProducts.length === 0 ? (
          <Empty>
            No variety pack products configured. Add component requirements
            in the admin (table: product_component_requirements).
          </Empty>
        ) : (
          <form action={`/floor/${token}/variety-pack`} method="GET" className="flex gap-2">
            <select
              name="productId"
              defaultValue={selectedProductId ?? ""}
              className="flex-1 bg-surface border border-border/60 rounded px-2 py-2.5 text-sm"
            >
              {varietyProducts.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} · {p.sku} · {p.component_count} components
                </option>
              ))}
            </select>
            <button
              type="submit"
              className="rounded-lg bg-brand-600 text-white text-sm font-medium px-4 py-2.5"
            >
              Load
            </button>
          </form>
        )}
      </Section>

      {/* State B — product selected but no variety run yet */}
      {selectedProductId && !activeRun && (
        <Section title="Start / Resume Variety Run">
          {sp.error && (
            <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
              {decodeURIComponent(sp.error)}
            </div>
          )}
          <form
            action={async (fd) => {
              "use server";
              const result = await startOrResumeVarietyRunAction(fd);
              if ("error" in result) {
                redirect(
                  `/floor/${token}/variety-pack?productId=${selectedProductId}&error=${encodeURIComponent(result.error)}`,
                );
              }
              redirect(
                `/floor/${token}/variety-pack?productId=${selectedProductId}&varietyRunId=${result.runId}`,
              );
            }}
            className="space-y-3"
          >
            <input type="hidden" name="token" value={token} />
            <input type="hidden" name="stationId" value={station.id} />
            <input type="hidden" name="productId" value={selectedProductId} />
            <input type="hidden" name="clientEventId" value={randomUUID()} />
            <SmallField label="Parent variety card token">
              <input
                type="text"
                name="parentScanToken"
                placeholder="Scan or type variety card token"
                required
                className="block w-full bg-surface border border-border/60 rounded px-2 py-2 text-sm"
              />
            </SmallField>
            <Submit>Start / Resume Run</Submit>
          </form>
        </Section>
      )}

      {/* State C — product + active variety run */}
      {selectedProductId && activeRun && (
        <>
          {/* Run info header */}
          <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 space-y-1">
            <div className="flex flex-wrap items-center gap-3 text-xs">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-emerald-700">
                Variety run
              </span>
              <span className="font-mono text-emerald-900">
                Token: {activeRun.parentScanToken}
              </span>
              <span className="text-text-muted">
                Run ID: {activeRun.id.slice(0, 8)}
              </span>
              <span className="text-text-muted">
                Opened: {activeRun.openedAt}
              </span>
              <span className="rounded bg-emerald-100 text-emerald-800 border border-emerald-300 px-2 py-0.5 text-[11px] font-medium">
                {activeRun.status}
              </span>
            </div>
          </div>

          {/* Component slots */}
          <Section title="Component slots">
            {requirements.length === 0 ? (
              <Empty>Variety pack component requirements missing for this product.</Empty>
            ) : (
              <div className="space-y-3">
                {requirements.map((req) => {
                  const open = openSessionsByRole.get(req.componentRole) ?? [];
                  const candidateBags = availableBagsByItemId.get(req.componentItemId) ?? [];
                  return (
                    <ComponentSlot
                      key={req.id}
                      token={token}
                      stationId={station.id}
                      productId={selectedProductId}
                      varietyRunId={activeRun.id}
                      requirement={req}
                      openSessions={open}
                      candidateBags={candidateBags}
                    />
                  );
                })}
              </div>
            )}
          </Section>

          {/* Reconciliation preview */}
          <Section title="Reconciliation preview">
            {!reconciliation || !reconciliation.hasRequirements ? (
              <Empty>Variety pack component requirements missing.</Empty>
            ) : reconciliation.rollups.length === 0 ? (
              <Empty>
                No finished lot yet — preview will populate once one is created.
              </Empty>
            ) : (
              <div className="space-y-2 text-sm">
                <div className="text-[11px] uppercase text-text-muted">
                  Combined confidence: {reconciliation.combinedConfidence}
                </div>
                <table className="w-full text-xs">
                  <thead className="text-text-muted uppercase">
                    <tr>
                      <th className="text-left p-1.5">Component</th>
                      <th className="text-left p-1.5">Role</th>
                      <th className="text-right p-1.5">Expected</th>
                      <th className="text-right p-1.5">Actual</th>
                      <th className="text-right p-1.5">Variance</th>
                      <th className="text-right p-1.5">Conf.</th>
                    </tr>
                  </thead>
                  <tbody>
                    {reconciliation.rollups.map((r) => (
                      <tr key={`${r.componentItemId}-${r.componentRole}`} className="border-t border-border/40">
                        <td className="p-1.5">{r.componentName}</td>
                        <td className="p-1.5 font-mono">{r.componentRole || "—"}</td>
                        <td className="p-1.5 text-right tabular-nums">
                          {render(r.expectedTotal.value)}
                        </td>
                        <td className="p-1.5 text-right tabular-nums">
                          {render(r.actualTotal.value)}
                        </td>
                        <td className="p-1.5 text-right tabular-nums">
                          {render(r.varianceTotal.value)}
                        </td>
                        <td className="p-1.5 text-right">{r.confidence}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Section>

          {/* Close variety run */}
          <Section title="Close variety run">
            {openSessionCount > 0 ? (
              <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                {openSessionCount} source bag session{openSessionCount === 1 ? "" : "s"} still OPEN.
                Close each source bag before closing the variety run.
              </p>
            ) : (
              <form
                action={async (fd) => {
                  "use server";
                  const result = await closeVarietyRunAction(fd);
                  if ("error" in result) {
                    redirect(
                      `/floor/${token}/variety-pack?productId=${selectedProductId}&varietyRunId=${sp.varietyRunId}&error=${encodeURIComponent(result.error)}`,
                    );
                  }
                  redirect(`/floor/${token}/variety-pack?productId=${selectedProductId}`);
                }}
              >
                <input type="hidden" name="token" value={token} />
                <input type="hidden" name="stationId" value={station.id} />
                <input type="hidden" name="varietyRunId" value={activeRun.id} />
                <input type="hidden" name="clientEventId" value={randomUUID()} />
                <p className="text-xs text-text-muted mb-3">
                  All source bag sessions are closed. Closing this run releases the variety
                  card for future use.
                </p>
                <Submit variant="danger">Close variety run</Submit>
              </form>
            )}
          </Section>
        </>
      )}
    </main>
  );
}

type OpenSession = {
  session_id: string;
  inventory_bag_id: string;
  bag_number: number | null;
  vendor_barcode: string | null;
  bag_qr_code: string | null;
  tablet_type_id: string | null;
  raw_item_name: string | null;
  starting_balance_qty: number | null;
  consumed_qty: number | null;
  opened_at: string;
  component_role: string | null;
};

type AvailableBag = {
  id: string;
  bag_number: number | null;
  vendor_barcode: string | null;
  pill_count: number | null;
  tablet_type_id: string | null;
  raw_item_name: string | null;
  po_number: string | null;
};

function ComponentSlot({
  token,
  stationId,
  productId,
  varietyRunId,
  requirement,
  openSessions,
  candidateBags,
}: {
  token: string;
  stationId: string;
  productId: string;
  varietyRunId: string;
  requirement: {
    id: string;
    componentItemId: string;
    componentName: string;
    componentItemCode: string;
    componentRole: string;
    quantityPerFinishedUnit: number;
    unitOfMeasure: string;
  };
  openSessions: OpenSession[];
  candidateBags: AvailableBag[];
}) {
  const slotFilled = openSessions.length > 0;
  return (
    <div className="rounded-xl border border-border bg-surface p-4 space-y-3">
      <div className="flex items-baseline justify-between gap-2">
        <div>
          <div className="font-semibold">
            {requirement.componentRole}
            <span className="text-text-muted text-sm ml-2">
              {requirement.componentName}
            </span>
          </div>
          <div className="text-[11px] text-text-muted">
            {requirement.quantityPerFinishedUnit} {requirement.unitOfMeasure} per finished unit
            <span className="font-mono ml-1">· {requirement.componentItemCode}</span>
          </div>
        </div>
        {slotFilled ? (
          <span className="rounded bg-emerald-50 text-emerald-800 border border-emerald-200 px-2 py-0.5 text-[11px] font-medium">
            FILLED
          </span>
        ) : (
          <span className="rounded bg-amber-50 text-amber-800 border border-amber-200 px-2 py-0.5 text-[11px] font-medium">
            EMPTY
          </span>
        )}
      </div>

      {/* Open session form */}
      {!slotFilled && (
        <form
          action={async (fd) => {
            "use server";
            await openAllocationSessionAction(fd);
          }}
          className="space-y-2"
        >
          <input type="hidden" name="token" value={token} />
          <input type="hidden" name="stationId" value={stationId} />
          <input type="hidden" name="productId" value={productId} />
          <input type="hidden" name="componentRole" value={requirement.componentRole} />
          <input type="hidden" name="varietyRunId" value={varietyRunId} />
          <input type="hidden" name="clientEventId" value={randomUUID()} />
          <SmallField label="Pick a bag (matches required component)">
            {candidateBags.length === 0 ? (
              <p className="text-xs text-rose-700">
                No AVAILABLE bags match this component. Receive raw bags or wait for one to free up.
              </p>
            ) : (
              <select
                name="inventoryBagId"
                required
                className="block w-full bg-surface border border-border/60 rounded px-2 py-2 text-sm"
              >
                <option value="">— Select a bag —</option>
                {candidateBags.map((b) => (
                  <option key={b.id} value={b.id}>
                    bag #{b.bag_number ?? "?"}
                    {b.vendor_barcode ? ` · ${b.vendor_barcode}` : ""}
                    {b.pill_count != null ? ` · ${b.pill_count} units` : ""}
                    {b.po_number ? ` · ${b.po_number}` : ""}
                  </option>
                ))}
              </select>
            )}
          </SmallField>
          {candidateBags.length > 0 ? <Submit>Open slot {requirement.componentRole}</Submit> : null}
        </form>
      )}

      {/* Active sessions for this slot */}
      {slotFilled && (
        <div className="space-y-3">
          {openSessions.map((s) => (
            <div key={s.session_id} className="rounded border border-border/60 bg-page p-3 space-y-2">
              <div className="text-xs text-text-muted flex flex-wrap items-center gap-1">
                <span>Bag #{s.bag_number ?? "?"}</span>
                <span>·</span>
                <QrCode className="w-3 h-3 inline-block" />
                {s.bag_qr_code ? (
                  <span className="font-mono">{s.bag_qr_code}</span>
                ) : (
                  <span className="rounded bg-amber-50 text-amber-700 border border-amber-200 px-1.5 py-0.5 text-[10px] font-medium">
                    No QR on bag
                  </span>
                )}
                <span>·</span>
                <span>{s.vendor_barcode ?? s.inventory_bag_id.slice(0, 8)}</span>
                <span>·</span>
                <span>{s.starting_balance_qty ?? "—"} units</span>
              </div>

              <details className="rounded border border-border/60 bg-surface">
                <summary className="px-3 py-1.5 text-xs font-medium cursor-pointer">
                  Close (record consumption)
                </summary>
                <form
                  action={async (fd) => {
                    "use server";
                    await closeAllocationSessionAction(fd);
                  }}
                  className="p-3 space-y-2"
                >
                  <input type="hidden" name="token" value={token} />
                  <input type="hidden" name="stationId" value={stationId} />
                  <input type="hidden" name="sessionId" value={s.session_id} />
                  <input type="hidden" name="clientEventId" value={randomUUID()} />
                  <SmallField label="Consumed qty">
                    <input
                      type="number"
                      inputMode="numeric"
                      min="0"
                      step="1"
                      required
                      name="consumedQty"
                      className="block w-full bg-surface border border-border/60 rounded px-2 py-2 text-sm tabular-nums"
                    />
                  </SmallField>
                  <SmallField label="Source">
                    <select
                      name="consumedQtySource"
                      defaultValue="MANUAL_ENTRY"
                      className="block w-full bg-surface border border-border/60 rounded px-2 py-2 text-sm"
                    >
                      {QTY_SOURCES.map(([v, l]) => (
                        <option key={v} value={v}>
                          {l}
                        </option>
                      ))}
                    </select>
                  </SmallField>
                  <SmallField label="Finished lot id (optional)">
                    <input
                      type="text"
                      name="finishedLotId"
                      placeholder="UUID, when known"
                      className="block w-full bg-surface border border-border/60 rounded px-2 py-2 text-sm font-mono text-[11px]"
                    />
                  </SmallField>
                  <Submit>Close slot</Submit>
                </form>
              </details>

              <details className="rounded border border-border/60 bg-surface">
                <summary className="px-3 py-1.5 text-xs font-medium cursor-pointer">
                  Return to stock
                </summary>
                <form
                  action={async (fd) => {
                    "use server";
                    await returnRawBagAction(fd);
                  }}
                  className="p-3 space-y-2"
                >
                  <input type="hidden" name="token" value={token} />
                  <input type="hidden" name="stationId" value={stationId} />
                  <input type="hidden" name="sessionId" value={s.session_id} />
                  <input type="hidden" name="clientEventId" value={randomUUID()} />
                  <SmallField label="Returned qty">
                    <input
                      type="number"
                      inputMode="numeric"
                      min="1"
                      step="1"
                      required
                      name="returnedQty"
                      className="block w-full bg-surface border border-border/60 rounded px-2 py-2 text-sm tabular-nums"
                    />
                  </SmallField>
                  <Submit>Return</Submit>
                </form>
              </details>

              <details className="rounded border border-border/60 bg-surface">
                <summary className="px-3 py-1.5 text-xs font-medium cursor-pointer">
                  Mark depleted
                </summary>
                <form
                  action={async (fd) => {
                    "use server";
                    await markBagDepletedAction(fd);
                  }}
                  className="p-3 space-y-2"
                >
                  <input type="hidden" name="token" value={token} />
                  <input type="hidden" name="stationId" value={stationId} />
                  <input type="hidden" name="sessionId" value={s.session_id} />
                  <input type="hidden" name="clientEventId" value={randomUUID()} />
                  <Submit>Deplete</Submit>
                </form>
              </details>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function FloorNav({ token }: { token: string }) {
  return (
    <nav className="mt-3 flex flex-wrap gap-2 text-xs">
      <Link href={`/floor/${token}`} className="rounded border border-border/70 bg-surface px-3 py-1.5 hover:bg-page">Station</Link>
      <Link href={`/floor/${token}/rolls`} className="rounded border border-border/70 bg-surface px-3 py-1.5 hover:bg-page">Rolls</Link>
      <Link href={`/floor/${token}/bag-allocation`} className="rounded border border-border/70 bg-surface px-3 py-1.5 hover:bg-page">Bag allocation</Link>
      <Link href={`/floor/${token}/variety-pack`} className="rounded border border-brand-300 bg-brand-50 text-brand-800 px-3 py-1.5 font-medium">Variety pack</Link>
    </nav>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl bg-surface border border-border p-4 sm:p-5 space-y-3">
      <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
      {children}
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-text-muted">{children}</p>;
}

function SmallField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block text-xs">
      <div className="text-[10px] uppercase tracking-wider text-text-muted mb-0.5">{label}</div>
      {children}
    </label>
  );
}

function Submit({ children, variant }: { children: React.ReactNode; variant?: "default" | "danger" }) {
  const colorClass =
    variant === "danger"
      ? "bg-rose-600 hover:bg-rose-700 active:bg-rose-800"
      : "bg-brand-600 hover:bg-brand-700 active:bg-brand-800";
  return (
    <button
      type="submit"
      className={`w-full rounded-lg ${colorClass} text-white text-sm font-medium px-4 py-2.5 transition-colors`}
    >
      {children}
    </button>
  );
}

function render(v: unknown): string {
  if (v == null) return "—";
  if (typeof v === "number") return v.toLocaleString();
  return String(v);
}
