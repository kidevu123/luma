// Floor station landing — what an operator sees on a tablet at a
// production station after scanning the station QR. The URL token
// is the station's scan_token (cryptographic identifier; rotated
// from /machines admin).
//
// Each station only sees the bag CURRENTLY at this station — driven
// by read_station_live.currentWorkflowBagId. No cross-station
// leak.

import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import {
  stations,
  machines,
  qrCards,
  workflowBags,
  workflowEvents,
  readBagState,
  readStationLive,
  products,
  productPackagingSpecs,
  packagingMaterials,
} from "@/lib/db/schema";
import { eq, and, or, inArray, isNotNull, isNull, sql, desc, asc } from "drizzle-orm";
import { ScanCardForm } from "./scan-card-form";
import { StageActionButtons } from "./stage-action-buttons";
import { STATION_PICKUP_FROM_STAGE } from "@/lib/production/stage-progression";
import {
  FIRST_OP_STATION_KINDS,
  STATION_KIND_TO_PRODUCT_KINDS,
} from "@/lib/production/first-op-product";
import { OperatorSessionPanel } from "./operator-session-form";
import { listActiveEmployeeOptions } from "./operator-session-actions";
import { getActiveStationSession } from "@/lib/production/station-operator-session";
import { shouldRenderQcPanel } from "@/lib/production/qc-panel-helpers";
import { QcPanel, type PendingReworkRow } from "./qc-panel";

export const dynamic = "force-dynamic";

export default async function FloorStationPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  const [station] = await db
    .select({ station: stations, machine: machines })
    .from(stations)
    .leftJoin(machines, eq(stations.machineId, machines.id))
    .where(eq(stations.scanToken, token));
  if (!station) notFound();

  // OP-1C: active operator session + the picker options for opening
  // a new one. activeSession is null until someone runs Open shift;
  // the panel below handles both states.
  const [activeSession, employeeOptions] = await Promise.all([
    getActiveStationSession(db, station.station.id),
    listActiveEmployeeOptions(),
  ]);

  // The bag at THIS station (and only this one) lives in
  // read_station_live.currentWorkflowBagId. Joining qr_cards back
  // gives us the card label + scan token for display, and joining
  // products surfaces the SKU + units/display + displays/case so
  // downstream stations can show the inherited product without
  // re-asking the operator.
  const [currentAtStation] = await db
    .select({
      bag: workflowBags,
      card: qrCards,
      state: readBagState,
      product: products,
    })
    .from(readStationLive)
    .innerJoin(workflowBags, eq(readStationLive.currentWorkflowBagId, workflowBags.id))
    .leftJoin(qrCards, eq(qrCards.assignedWorkflowBagId, workflowBags.id))
    .leftJoin(readBagState, eq(readBagState.workflowBagId, workflowBags.id))
    .leftJoin(products, eq(products.id, workflowBags.productId))
    .where(eq(readStationLive.stationId, station.station.id));

  // Idle cards available to scan, sorted by label so the dropdown
  // is predictable. Also include ASSIGNED cards with no workflow bag
  // (intake-reserved cards) — they behave identically to IDLE for the
  // floor scanner. Eventually replace with a scan-only input.
  const idleCards = await db
    .select()
    .from(qrCards)
    .where(
      or(
        eq(qrCards.status, "IDLE"),
        and(eq(qrCards.status, "ASSIGNED"), isNull(qrCards.assignedWorkflowBagId)),
      ),
    );

  // First-op product picker (PRD-1): when this station is BLISTER /
  // COMBINED, the operator must pick a product on a fresh-card scan.
  // List active products whose kind is allowed for this station kind.
  const requireFirstOpProduct = FIRST_OP_STATION_KINDS.has(station.station.kind);
  const allowedProductKinds =
    STATION_KIND_TO_PRODUCT_KINDS[station.station.kind] ?? [];
  const allowedProducts = requireFirstOpProduct && allowedProductKinds.length > 0
    ? await db
        .select({
          id: products.id,
          sku: products.sku,
          name: products.name,
          kind: products.kind,
          unitsPerDisplay: products.unitsPerDisplay,
          displaysPerCase: products.displaysPerCase,
        })
        .from(products)
        .where(
          and(
            eq(products.isActive, true),
            inArray(products.kind, allowedProductKinds as ("CARD" | "BOTTLE" | "VARIETY")[]),
          ),
        )
    : [];

  // ASSIGNED cards whose bag is at a stage THIS station can pick up
  // (multi-station travel — VALIDATION-2D model). Sealing accepts
  // BLISTERED, packaging accepts SEALED, etc. Surfacing these in the
  // scan picker is the only way the operator can claim a released
  // bag without typing a UUID.
  const pickupStages = STATION_PICKUP_FROM_STAGE[station.station.kind] ?? [];
  const eligiblePickups =
    pickupStages.length === 0
      ? []
      : await db
          .select({
            id: qrCards.id,
            label: qrCards.label,
            scanToken: qrCards.scanToken,
            bagId: qrCards.assignedWorkflowBagId,
            bagStage: readBagState.stage,
          })
          .from(qrCards)
          .innerJoin(
            readBagState,
            eq(readBagState.workflowBagId, qrCards.assignedWorkflowBagId),
          )
          .where(
            and(
              eq(qrCards.status, "ASSIGNED"),
              isNotNull(qrCards.assignedWorkflowBagId),
              eq(readBagState.isFinalized, false),
              eq(readBagState.isPaused, false),
              inArray(readBagState.stage, pickupStages as string[]),
            ),
          );

  // Load the product's packaging BOM so the packaging close-out form
  // can preview expected material consumption as the operator types.
  const currentProductId = currentAtStation?.bag.productId ?? null;
  const packagingSpecsForForm =
    currentProductId != null &&
    (station.station.kind === "PACKAGING" || station.station.kind === "COMBINED")
      ? await db
          .select({
            materialName: packagingMaterials.name,
            materialKind: packagingMaterials.kind,
            qtyPerUnit: productPackagingSpecs.qtyPerUnit,
            perScope: productPackagingSpecs.perScope,
          })
          .from(productPackagingSpecs)
          .innerJoin(
            packagingMaterials,
            eq(productPackagingSpecs.packagingMaterialId, packagingMaterials.id),
          )
          .where(eq(productPackagingSpecs.productId, currentProductId))
          .orderBy(asc(productPackagingSpecs.perScope))
      : [];

  return (
    <main className="min-h-dvh bg-page p-4 sm:p-6 pb-[calc(1rem+env(safe-area-inset-bottom))] max-w-2xl mx-auto space-y-5">
      <header className="flex items-baseline justify-between">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-text-subtle">
            Station
          </p>
          <h1 className="text-2xl font-semibold tracking-tight">{station.station.label}</h1>
          <p className="text-xs text-text-muted">
            {station.station.kind}
            {station.machine ? ` · ${station.machine.name}` : ""}
          </p>
        </div>
        <span className="rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200 px-2 py-0.5 text-[11px] font-medium">
          Online
        </span>
      </header>

      <nav className="flex flex-wrap gap-2 text-xs">
        <a href={`/floor/${token}/rolls`} className="inline-flex items-center rounded border border-border/70 bg-surface px-4 min-h-[44px] hover:bg-page">
          Rolls
        </a>
        <a href={`/floor/${token}/bag-allocation`} className="inline-flex items-center rounded border border-border/70 bg-surface px-4 min-h-[44px] hover:bg-page">
          Bag allocation
        </a>
        <a href={`/floor/${token}/variety-pack`} className="inline-flex items-center rounded border border-border/70 bg-surface px-4 min-h-[44px] hover:bg-page">
          Variety pack
        </a>
      </nav>

      <OperatorSessionPanel
        token={token}
        stationId={station.station.id}
        activeSession={activeSession}
        employeeOptions={employeeOptions}
      />

      <section className="rounded-2xl bg-surface border border-border p-5 space-y-4">
        <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-text-subtle">
          Current bag
        </p>
        {!currentAtStation ? (
          <div className="py-3">
            <p className="text-sm text-text-muted mb-3">
              No bag at this station. Scan a card to begin.
            </p>
            <ScanCardForm
              token={token}
              stationId={station.station.id}
              idleCards={idleCards.map((c) => ({
                id: c.id,
                label: c.label,
                scanToken: c.scanToken,
              }))}
              eligiblePickups={eligiblePickups
                .filter(
                  (
                    c,
                  ): c is {
                    id: string;
                    label: string;
                    scanToken: string;
                    bagId: string;
                    bagStage: string;
                  } => c.bagId != null,
                )
                .map((c) => ({
                  id: c.id,
                  label: c.label,
                  scanToken: c.scanToken,
                  bagId: c.bagId,
                  bagStage: c.bagStage,
                }))}
              allowedProducts={allowedProducts.map((p) => ({
                id: p.id,
                sku: p.sku,
                name: p.name,
              }))}
              requireProductForFreshBag={requireFirstOpProduct}
            />
          </div>
        ) : (
          <div className="space-y-3">
            <div className="rounded-xl border border-border/70 bg-surface-2/40 p-4">
              <div className="flex items-baseline justify-between mb-2">
                <p className="text-base font-semibold tracking-tight">
                  {currentAtStation.card?.label ?? "—"}
                </p>
                <span className="font-mono text-[11px] text-text-subtle">
                  {currentAtStation.bag.id.slice(0, 8)}
                </span>
              </div>
              {currentAtStation.product ? (
                <div className="mt-2 rounded-lg border border-emerald-200 bg-emerald-50/60 px-3 py-2 text-xs text-emerald-900 space-y-0.5">
                  <div className="font-semibold">
                    Making: {currentAtStation.product.sku}
                    {currentAtStation.product.name
                      ? ` — ${currentAtStation.product.name}`
                      : ""}
                  </div>
                  {currentAtStation.product.unitsPerDisplay != null &&
                  currentAtStation.product.displaysPerCase != null ? (
                    <div className="text-emerald-900/70">
                      {currentAtStation.product.unitsPerDisplay} units/display ·{" "}
                      {currentAtStation.product.displaysPerCase} displays/case
                    </div>
                  ) : (
                    <div className="text-amber-700">
                      Packaging structure incomplete — supervisor must update.
                    </div>
                  )}
                </div>
              ) : (
                <div className="mt-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                  <div className="font-semibold">No product set on this bag.</div>
                  <div>
                    This bag was started before the first-op product picker
                    landed. Packaging completion will be blocked.
                  </div>
                </div>
              )}
              <p className="text-xs text-text-muted mt-2">
                Started{" "}
                {currentAtStation.bag.startedAt
                  ? new Date(
                      currentAtStation.bag.startedAt as unknown as string,
                    ).toLocaleTimeString()
                  : "—"}
                {currentAtStation.state?.currentOperatorCode
                  ? ` · operator ${currentAtStation.state.currentOperatorCode}`
                  : ""}
              </p>
            </div>
            <StageActionButtons
              token={token}
              stationId={station.station.id}
              stationKind={station.station.kind}
              workflowBagId={currentAtStation.bag.id}
              isPaused={currentAtStation.state?.isPaused ?? false}
              currentStage={currentAtStation.state?.stage ?? null}
              productKind={currentAtStation.product?.kind ?? null}
              unitsPerDisplay={currentAtStation.product?.unitsPerDisplay ?? null}
              displaysPerCase={currentAtStation.product?.displaysPerCase ?? null}
              packagingSpecs={packagingSpecsForForm}
            />
            {/* Help operator pick the next action when the bag has
             *  already advanced past this station's stage. The
             *  StageActionButtons hides its primary button in that
             *  case; this banner replaces it. */}
            <BagAdvancedBanner
              token={token}
              stationKind={station.station.kind}
              currentStage={currentAtStation.state?.stage ?? null}
              isFinalized={currentAtStation.state?.isFinalized ?? false}
            />
            {/* QC-3: quick QC issue panel. Only on packaging /
             *  sealing / combined stations (per qc-panel-helpers).
             *  Pending rework for this bag is fetched server-side
             *  so the receive surface is one round-trip away. */}
            {shouldRenderQcPanel(station.station.kind) ? (
              <QcPanel
                token={token}
                stationId={station.station.id}
                stationKind={station.station.kind}
                workflowBagId={currentAtStation.bag.id}
                currentOperatorName={activeSession?.employeeNameSnapshot ?? null}
                accountabilitySource={activeSession?.accountabilitySource ?? null}
                pendingRework={await loadPendingRework(currentAtStation.bag.id)}
              />
            ) : null}
          </div>
        )}
      </section>

      <p className="text-center text-[10px] text-text-subtle">
        Luma · {process.env.BUILD_GIT_SHA?.slice(0, 7) ?? "dev"}
      </p>
    </main>
  );
}

// Maps a station kind to the stage a bag must be at for that
// station's primary stage event to be valid. Mirrors the server-side
// EVENT_STAGE_PREREQ map; kept inline here so the UI never imports
// from "use server" actions.
const STATION_PREREQ_STAGE: Record<string, string> = {
  BLISTER: "STARTED",
  SEALING: "BLISTERED",
  PACKAGING: "SEALED",
  COMBINED: "STARTED", // first action is BLISTER_COMPLETE
  BOTTLE_HANDPACK: "STARTED",
  BOTTLE_CAP_SEAL: "BLISTERED",
  BOTTLE_STICKER: "SEALED",
};

/** QC-3 — pending REWORK_SENT events for the current bag that have
 *  not yet been fully received. "Pending" today = any REWORK_SENT
 *  for this bag with no paired REWORK_RECEIVED row (full or partial
 *  doesn't matter — QC-3 only surfaces "Mark fully received"; partial
 *  receive lands in QC-4). The receiving station's operator marks
 *  them received from the QC panel. */
async function loadPendingRework(workflowBagId: string): Promise<PendingReworkRow[]> {
  const sent = await db
    .select({
      id: workflowEvents.id,
      occurredAt: workflowEvents.occurredAt,
      payload: workflowEvents.payload,
      stationId: workflowEvents.stationId,
    })
    .from(workflowEvents)
    .where(
      and(
        eq(workflowEvents.workflowBagId, workflowBagId),
        eq(workflowEvents.eventType, "REWORK_SENT"),
      ),
    )
    .orderBy(desc(workflowEvents.occurredAt));
  if (sent.length === 0) return [];

  // Any REWORK_SENT whose id appears in a REWORK_RECEIVED's
  // payload->>linked_event_id is considered fully received for QC-3
  // purposes. Partial receives that don't fully close the sent
  // quantity are intentionally out of QC-3 scope — they'd show as
  // "received" here even if a remainder remains. QC-4 surfaces the
  // remainder math.
  const receivedRows = (await db.execute(
    sql`SELECT payload->>'linked_event_id' AS linked_id
        FROM workflow_events
        WHERE workflow_bag_id = ${workflowBagId}
          AND event_type = 'REWORK_RECEIVED'
          AND payload ? 'linked_event_id'`,
  )) as unknown as Array<{ linked_id: string }>;
  const receivedSet = new Set(receivedRows.map((r) => r.linked_id));

  // Resolve from-station labels in one round trip.
  const stationIds = Array.from(
    new Set(sent.map((r) => r.stationId).filter((x): x is string => x != null)),
  );
  const stationRows =
    stationIds.length === 0
      ? []
      : await db
          .select({ id: stations.id, label: stations.label })
          .from(stations)
          .where(inArray(stations.id, stationIds));
  const stationLabel = new Map(stationRows.map((s) => [s.id, s.label]));

  return sent
    .filter((row) => !receivedSet.has(row.id))
    .map((row) => {
      const p = (row.payload ?? {}) as Record<string, unknown>;
      const qty = Number(p.quantity ?? 0);
      const unit = typeof p.unit === "string" ? p.unit : "cards";
      const reasonCode =
        typeof p.reason_code === "string" ? p.reason_code : "OTHER";
      const accountableEmployeeName =
        typeof p.accountable_employee_name_snapshot === "string"
          ? p.accountable_employee_name_snapshot
          : null;
      return {
        id: row.id,
        occurredAt: new Date(row.occurredAt as unknown as string).toISOString(),
        quantity: qty,
        unit,
        reasonCode,
        fromStationLabel:
          row.stationId != null ? stationLabel.get(row.stationId) ?? null : null,
        accountableEmployeeName,
      };
    });
}

function BagAdvancedBanner({
  token,
  stationKind,
  currentStage,
  isFinalized,
}: {
  token: string;
  stationKind: string;
  currentStage: string | null;
  isFinalized: boolean;
}) {
  if (!currentStage) return null;
  if (isFinalized) {
    return (
      <div className="rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
        <p className="font-semibold">Bag is finalized.</p>
        <p className="text-xs">
          Scan a new card to start the next bag at this station.
        </p>
      </div>
    );
  }
  const prereq = STATION_PREREQ_STAGE[stationKind];
  if (!prereq || currentStage === prereq) return null;

  // The bag has advanced past (or is otherwise out of sequence with)
  // this station's primary action. Spell out the next step instead
  // of leaving the form looking like it's still ready.
  const stageWord =
    {
      STARTED: "started",
      BLISTERED: "blistered",
      SEALED: "sealed",
      PACKAGED: "packaged",
      FINALIZED: "finalized",
    }[currentStage] ?? currentStage.toLowerCase();
  const nextHint =
    currentStage === "BLISTERED"
      ? "Tap Release to sealing queue below. The card stays attached and the sealing station scans the same card to claim the bag."
      : currentStage === "SEALED"
        ? "Tap Release to packaging queue below. The card stays attached and the packaging station scans the same card to claim the bag."
        : currentStage === "PACKAGED"
          ? "Tap Finalize bag below at the packaging station to close the production cycle and release the card."
          : `Bag is at ${stageWord}; this station has no further forward action.`;
  return (
    <div className="rounded-lg border border-sky-300 bg-sky-50 px-3 py-2 text-sm text-sky-900 space-y-0.5">
      <p className="font-semibold">Bag already {stageWord} at this station.</p>
      <p className="text-xs">{nextHint}</p>
    </div>
  );
}
