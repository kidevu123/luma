// Phase VALIDATION-2A — Floor raw-bag allocation UI.
//
// Single-bag workflow on top of the H.x3.6 server actions. The
// operator picks an AVAILABLE bag, assigns it to a product/route,
// opens a session, then later closes / returns / depletes / adjusts.
//
// The page is organised top-down so the floor flow is obvious:
//   1. Active sessions on this machine — close / return / deplete
//   2. Open new session — pick a bag + product + route
//   3. Adjust an inventory bag (sessionless) — reason required
//   4. Recent activity (last events for this station)
//
// Empty-state vocabulary:
//   • "No bag at this station — open one below" (no active sessions)
//   • "No bags available" (no AVAILABLE inventory_bags)
//   • "No products configured" (no products + route assignment)
//   • "Bag already open — close it first" (server-side enforced)
//   • "Remaining quantity unknown" (returned without remaining qty)

import { notFound } from "next/navigation";
import Link from "next/link";
import { eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import {
  stations,
  machines,
  inventoryBags,
  products,
  productionRoutes,
  productRouteAssignments,
} from "@/lib/db/schema";
import {
  openAllocationSessionAction,
  closeAllocationSessionAction,
  returnRawBagAction,
  markBagDepletedAction,
  adjustRawBagAction,
} from "../bag-allocation-actions";

export const dynamic = "force-dynamic";

const QTY_SOURCES = [
  ["MACHINE_COUNTER", "Machine counter"],
  ["FINISHED_LOT_INPUT", "Finished lot input"],
  ["MANUAL_ENTRY", "Manual entry"],
  ["ESTIMATED", "Estimated"],
] as const;

const RETURN_SOURCES = [
  ["MANUAL_ENTRY", "Manual entry"],
  ["WEIGH_BACK", "Weigh-back"],
  ["ESTIMATED", "Estimated"],
] as const;

export default async function BagAllocationPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  const [stationRow] = await db
    .select({ station: stations, machine: machines })
    .from(stations)
    .leftJoin(machines, eq(stations.machineId, machines.id))
    .where(eq(stations.scanToken, token));
  if (!stationRow) notFound();
  const { station, machine } = stationRow;

  // Active OPEN sessions across the whole DB. We show them all so an
  // operator who wandered away from a station can still close them
  // out. (Floor convenience over per-station filtering.)
  type SessionRow = {
    session_id: string;
    inventory_bag_id: string;
    bag_number: number | null;
    vendor_barcode: string | null;
    raw_item_name: string | null;
    product_id: string | null;
    product_name: string | null;
    product_sku: string | null;
    component_role: string | null;
    starting_balance_qty: number | null;
    consumed_qty: number | null;
    opened_at: string;
    pill_count: number | null;
  };
  const openSessions = (await db.execute<SessionRow>(sql`
    SELECT
      s.id::text                         AS session_id,
      s.inventory_bag_id::text           AS inventory_bag_id,
      ib.bag_number                      AS bag_number,
      ib.vendor_barcode                  AS vendor_barcode,
      tt.name                            AS raw_item_name,
      s.product_id::text                 AS product_id,
      p.name                             AS product_name,
      p.sku                              AS product_sku,
      s.component_role                   AS component_role,
      s.starting_balance_qty             AS starting_balance_qty,
      s.consumed_qty                     AS consumed_qty,
      s.opened_at::text                  AS opened_at,
      ib.pill_count                      AS pill_count
    FROM raw_bag_allocation_sessions s
    JOIN inventory_bags ib ON ib.id = s.inventory_bag_id
    LEFT JOIN tablet_types tt ON tt.id = ib.tablet_type_id
    LEFT JOIN products p ON p.id = s.product_id
    WHERE s.allocation_status = 'OPEN'
    ORDER BY s.opened_at DESC
    LIMIT 25
  `)) as unknown as SessionRow[];

  // Available inventory bags (AVAILABLE status). Grouped by raw item.
  type AvailableBagRow = {
    id: string;
    bag_number: number | null;
    vendor_barcode: string | null;
    pill_count: number | null;
    weight_grams: number | null;
    raw_item_name: string | null;
    raw_item_sku: string | null;
    po_number: string | null;
  };
  const availableBags = (await db.execute<AvailableBagRow>(sql`
    SELECT
      ib.id::text             AS id,
      ib.bag_number           AS bag_number,
      ib.vendor_barcode       AS vendor_barcode,
      ib.pill_count           AS pill_count,
      ib.weight_grams         AS weight_grams,
      tt.name                 AS raw_item_name,
      tt.sku                  AS raw_item_sku,
      po.po_number            AS po_number
    FROM inventory_bags ib
    LEFT JOIN tablet_types tt ON tt.id = ib.tablet_type_id
    LEFT JOIN small_boxes sb ON sb.id = ib.small_box_id
    LEFT JOIN receives r ON r.id = sb.receive_id
    LEFT JOIN purchase_orders po ON po.id = r.po_id
    WHERE ib.status = 'AVAILABLE'
    ORDER BY tt.name, ib.bag_number
    LIMIT 100
  `)) as unknown as AvailableBagRow[];

  // Products with at least one default route assignment. Variety
  // products are shown but a separate page exists for component
  // workflow.
  type ProductRow = {
    id: string;
    sku: string;
    name: string;
    kind: string;
    route_id: string | null;
    route_code: string | null;
    has_components: boolean;
  };
  const productsList = (await db.execute<ProductRow>(sql`
    SELECT
      p.id::text                                                        AS id,
      p.sku                                                             AS sku,
      p.name                                                            AS name,
      p.kind::text                                                      AS kind,
      pra.route_id::text                                                AS route_id,
      pr.code                                                           AS route_code,
      EXISTS(SELECT 1 FROM product_component_requirements pcr WHERE pcr.product_id = p.id AND pcr.is_active = true) AS has_components
    FROM products p
    LEFT JOIN product_route_assignments pra ON pra.product_id = p.id AND pra.is_default = true AND pra.is_active = true
    LEFT JOIN production_routes pr ON pr.id = pra.route_id
    WHERE p.is_active = true
    ORDER BY p.name
    LIMIT 200
  `)) as unknown as ProductRow[];
  void productionRoutes;
  void productRouteAssignments;
  void inventoryBags;
  void products;

  return (
    <main className="min-h-dvh bg-page p-4 sm:p-6 max-w-2xl mx-auto space-y-5">
      <header>
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-text-subtle">
          Bag allocation
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">{station.label}</h1>
        <p className="text-xs text-text-muted">
          {station.kind}
          {machine ? ` · ${machine.name}` : ""}
        </p>
        <FloorNav token={token} />
      </header>

      {/* Section 1 — Active sessions */}
      <Section title="Active sessions">
        {openSessions.length === 0 ? (
          <Empty>No bag at this station — open one below.</Empty>
        ) : (
          <div className="space-y-3">
            {openSessions.map((s) => (
              <ActiveSessionCard
                key={s.session_id}
                token={token}
                stationId={station.id}
                session={s}
              />
            ))}
          </div>
        )}
      </Section>

      {/* Section 2 — Open new session */}
      <Section title="Open a new session">
        {availableBags.length === 0 ? (
          <Empty>No bags available. Receive raw bags via /inbound first.</Empty>
        ) : productsList.length === 0 ? (
          <Empty>No products configured. Add one in /products with a route assignment.</Empty>
        ) : (
          <form
            action={async (fd) => {
              "use server";
              await openAllocationSessionAction(fd);
            }}
            className="space-y-3"
          >
            <input type="hidden" name="token" value={token} />
            <input type="hidden" name="stationId" value={station.id} />
            <input type="hidden" name="clientEventId" value={randomUUID()} />

            <Field label="Raw bag">
              <select
                name="inventoryBagId"
                required
                className="block w-full bg-surface border border-border/60 rounded px-2 py-2.5 text-sm"
              >
                <option value="">— Select a bag —</option>
                {availableBags.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.raw_item_name ?? "—"} · bag #{b.bag_number ?? "?"}
                    {b.vendor_barcode ? ` · ${b.vendor_barcode}` : ""}
                    {b.pill_count != null ? ` · ${b.pill_count} units` : ""}
                    {b.po_number ? ` · ${b.po_number}` : ""}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Product">
              <select
                name="productId"
                required
                className="block w-full bg-surface border border-border/60 rounded px-2 py-2.5 text-sm"
              >
                <option value="">— Select a product —</option>
                {productsList.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} · {p.sku} · {p.route_code ?? "no route"}
                    {p.has_components ? " · variety pack (use variety-pack page)" : ""}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Route (auto-fills from product if unset)">
              <select
                name="routeId"
                className="block w-full bg-surface border border-border/60 rounded px-2 py-2.5 text-sm"
              >
                <option value="">— Use product default —</option>
                {productsList
                  .filter((p) => p.route_id)
                  .map((p) => (
                    <option key={`${p.id}-${p.route_id}`} value={p.route_id ?? ""}>
                      {p.route_code} (for {p.sku})
                    </option>
                  ))}
              </select>
            </Field>

            <Field label="Starting balance (optional, defaults to vendor count)">
              <input
                type="number"
                inputMode="numeric"
                min="0"
                step="1"
                name="startingBalanceQty"
                placeholder="leave blank to use vendor declared count"
                className="block w-full bg-surface border border-border/60 rounded px-2 py-2.5 text-sm tabular-nums"
              />
            </Field>

            <Field label="Notes (optional)">
              <input
                type="text"
                name="notes"
                maxLength={500}
                className="block w-full bg-surface border border-border/60 rounded px-2 py-2.5 text-sm"
              />
            </Field>

            <Submit>Open session</Submit>
          </form>
        )}
      </Section>

      {/* Section 3 — Adjustment (sessionless) */}
      <Section title="Inventory adjustment">
        <p className="text-xs text-text-muted mb-3">
          Sessionless correction (re-count, write-off, recalibration). Reason is required.
          Supervisor permission gate is not yet enforced server-side — every floor user
          can submit this.
        </p>
        <form
          action={async (fd) => {
            "use server";
            await adjustRawBagAction(fd);
          }}
          className="space-y-3"
        >
          <input type="hidden" name="token" value={token} />
          <input type="hidden" name="stationId" value={station.id} />
          <input type="hidden" name="clientEventId" value={randomUUID()} />
          <Field label="Inventory bag">
            <select
              name="inventoryBagId"
              required
              className="block w-full bg-surface border border-border/60 rounded px-2 py-2.5 text-sm"
            >
              <option value="">— Select a bag —</option>
              {availableBags.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.raw_item_name ?? "—"} · bag #{b.bag_number ?? "?"}
                  {b.vendor_barcode ? ` · ${b.vendor_barcode}` : ""}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Adjustment quantity (signed; negative reduces stock)">
            <input
              type="number"
              inputMode="numeric"
              step="1"
              required
              name="adjustmentQty"
              className="block w-full bg-surface border border-border/60 rounded px-2 py-2.5 text-sm tabular-nums"
            />
          </Field>
          <Field label="Reason (required)">
            <input
              type="text"
              required
              name="reason"
              maxLength={200}
              placeholder="e.g. Recount on 2026-05-08"
              className="block w-full bg-surface border border-border/60 rounded px-2 py-2.5 text-sm"
            />
          </Field>
          <Field label="Notes (optional)">
            <input
              type="text"
              name="notes"
              maxLength={500}
              className="block w-full bg-surface border border-border/60 rounded px-2 py-2.5 text-sm"
            />
          </Field>
          <SubmitSecondary>Submit adjustment</SubmitSecondary>
        </form>
      </Section>
    </main>
  );
}

function ActiveSessionCard({
  token,
  stationId,
  session,
}: {
  token: string;
  stationId: string;
  session: {
    session_id: string;
    inventory_bag_id: string;
    bag_number: number | null;
    vendor_barcode: string | null;
    raw_item_name: string | null;
    product_id: string | null;
    product_name: string | null;
    product_sku: string | null;
    component_role: string | null;
    starting_balance_qty: number | null;
    consumed_qty: number | null;
    opened_at: string;
    pill_count: number | null;
  };
}) {
  const startingDisplay = session.starting_balance_qty ?? session.pill_count;
  return (
    <div className="rounded-xl border border-border bg-surface p-4 space-y-3">
      <div className="flex items-baseline justify-between gap-2">
        <div>
          <div className="font-semibold">
            {session.raw_item_name ?? "—"}
            <span className="text-text-muted text-sm ml-1">
              bag #{session.bag_number ?? "?"}
            </span>
          </div>
          <div className="text-[11px] text-text-muted font-mono">
            {session.vendor_barcode ?? session.inventory_bag_id.slice(0, 8)}
          </div>
        </div>
        <span className="rounded bg-amber-50 text-amber-800 border border-amber-200 px-2 py-0.5 text-[11px] font-medium">
          OPEN
        </span>
      </div>
      <div className="text-xs text-text-muted space-y-0.5">
        <div>
          Product: <span className="text-text">{session.product_name ?? "—"}</span>
          {session.product_sku ? (
            <span className="font-mono"> · {session.product_sku}</span>
          ) : null}
        </div>
        {session.component_role ? (
          <div>
            Role: <span className="font-mono text-text">{session.component_role}</span>
          </div>
        ) : null}
        <div>
          Starting:{" "}
          <span className="text-text tabular-nums">{startingDisplay ?? "—"} units</span>
        </div>
        <div>
          Opened:{" "}
          {new Date(session.opened_at).toLocaleString()}
        </div>
      </div>

      {/* Close session */}
      <details className="rounded border border-border/60 bg-page">
        <summary className="px-3 py-2 text-sm font-medium cursor-pointer">
          Close session (record consumed quantity)
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
          <input type="hidden" name="sessionId" value={session.session_id} />
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
          <SmallField label="Quantity source">
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
          <SmallField label="Ending balance (optional)">
            <input
              type="number"
              inputMode="numeric"
              min="0"
              step="1"
              name="endingBalanceQty"
              placeholder="if known"
              className="block w-full bg-surface border border-border/60 rounded px-2 py-2 text-sm tabular-nums"
            />
          </SmallField>
          <SmallField label="Notes (optional)">
            <input
              type="text"
              name="notes"
              maxLength={500}
              className="block w-full bg-surface border border-border/60 rounded px-2 py-2 text-sm"
            />
          </SmallField>
          <Submit>Close session</Submit>
        </form>
      </details>

      {/* Return to stock */}
      <details className="rounded border border-border/60 bg-page">
        <summary className="px-3 py-2 text-sm font-medium cursor-pointer">
          Return to stock (partial unconsumed)
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
          <input type="hidden" name="sessionId" value={session.session_id} />
          <input type="hidden" name="clientEventId" value={randomUUID()} />
          <SmallField label="Returned qty (positive)">
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
          <SmallField label="Remaining weight grams (optional)">
            <input
              type="number"
              inputMode="numeric"
              min="0"
              step="1"
              name="remainingWeightGrams"
              className="block w-full bg-surface border border-border/60 rounded px-2 py-2 text-sm tabular-nums"
            />
          </SmallField>
          <SmallField label="Source">
            <select
              name="returnSource"
              defaultValue="MANUAL_ENTRY"
              className="block w-full bg-surface border border-border/60 rounded px-2 py-2 text-sm"
            >
              {RETURN_SOURCES.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </SmallField>
          <SmallField label="Notes (optional)">
            <input
              type="text"
              name="notes"
              maxLength={500}
              className="block w-full bg-surface border border-border/60 rounded px-2 py-2 text-sm"
            />
          </SmallField>
          <Submit>Return to stock</Submit>
        </form>
      </details>

      {/* Mark depleted */}
      <details className="rounded border border-border/60 bg-page">
        <summary className="px-3 py-2 text-sm font-medium cursor-pointer">
          Mark bag depleted
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
          <input type="hidden" name="sessionId" value={session.session_id} />
          <input type="hidden" name="clientEventId" value={randomUUID()} />
          <SmallField label="Final consumed qty (optional)">
            <input
              type="number"
              inputMode="numeric"
              min="0"
              step="1"
              name="finalConsumedQty"
              className="block w-full bg-surface border border-border/60 rounded px-2 py-2 text-sm tabular-nums"
            />
          </SmallField>
          <SmallField label="Notes (optional)">
            <input
              type="text"
              name="notes"
              maxLength={500}
              className="block w-full bg-surface border border-border/60 rounded px-2 py-2 text-sm"
            />
          </SmallField>
          <Submit>Deplete bag</Submit>
        </form>
      </details>
    </div>
  );
}

function FloorNav({ token }: { token: string }) {
  return (
    <nav className="mt-3 flex flex-wrap gap-2 text-xs">
      <Link
        href={`/floor/${token}`}
        className="rounded border border-border/70 bg-surface px-3 py-1.5 hover:bg-page"
      >
        Station
      </Link>
      <Link
        href={`/floor/${token}/rolls`}
        className="rounded border border-border/70 bg-surface px-3 py-1.5 hover:bg-page"
      >
        Rolls
      </Link>
      <Link
        href={`/floor/${token}/bag-allocation`}
        className="rounded border border-brand-300 bg-brand-50 text-brand-800 px-3 py-1.5 font-medium"
      >
        Bag allocation
      </Link>
      <Link
        href={`/floor/${token}/variety-pack`}
        className="rounded border border-border/70 bg-surface px-3 py-1.5 hover:bg-page"
      >
        Variety pack
      </Link>
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

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block text-sm">
      <div className="text-[11px] uppercase tracking-wider text-text-muted mb-0.5">
        {label}
      </div>
      {children}
    </label>
  );
}

function SmallField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block text-xs">
      <div className="text-[10px] uppercase tracking-wider text-text-muted mb-0.5">
        {label}
      </div>
      {children}
    </label>
  );
}

function Submit({ children }: { children: React.ReactNode }) {
  return (
    <button
      type="submit"
      className="w-full rounded-lg bg-brand-600 hover:bg-brand-700 active:bg-brand-800 text-white text-sm font-medium px-4 py-3 transition-colors"
    >
      {children}
    </button>
  );
}

function SubmitSecondary({ children }: { children: React.ReactNode }) {
  return (
    <button
      type="submit"
      className="w-full rounded-lg bg-surface border border-border hover:bg-page text-sm font-medium px-4 py-3 transition-colors"
    >
      {children}
    </button>
  );
}
