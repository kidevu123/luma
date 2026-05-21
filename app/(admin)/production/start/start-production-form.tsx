"use client";

// WORKFLOW-CLEANUP-2 — Start Production guided 4-step workflow.
//
// Step 1: scan / paste a raw bag receipt # or BAG-uuid QR.
// Step 2: pick the product (filtered by the bag's tablet type).
// Step 3: pick an IDLE workflow QR card to assign to the bag.
// Step 4: pick a station, click Start production.
//
// On success we render a StartedPanel with PO / vendor / product /
// receipt / QR / IDs and a link back to the live floor.

import { useState, useTransition, useEffect } from "react";
import Link from "next/link";
import {
  ProductionSection,
  ProductionAlertCard,
  ProductionIdentityBlock,
} from "@/components/production/ui";
import {
  lookupRawBagForStartAction,
  startProductionForRawBagAction,
  type StartProductionResult,
} from "./actions";
import type { RawBagLookupResult } from "@/lib/db/queries/raw-bag-intake";

type IdleCard = { id: string; code: string | null; scanToken: string };
type StationOpt = { id: string; label: string; kind: string };
type AllowedProduct = { id: string; name: string; sku: string; kind: string };

export function StartProductionForm({
  idleCards,
  stations,
  allowedProductsByTabletType,
}: {
  idleCards: IdleCard[];
  stations: StationOpt[];
  allowedProductsByTabletType: Record<string, AllowedProduct[]>;
}) {
  const [scanValue, setScanValue] = useState("");
  const [lookup, setLookup] = useState<RawBagLookupResult | null>(null);
  const [productId, setProductId] = useState("");
  const [qrCardId, setQrCardId] = useState("");
  const [stationId, setStationId] = useState("");
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<StartProductionResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const resolvedBag = lookup && lookup.found ? lookup : null;
  const allowedProducts = resolvedBag
    ? allowedProductsByTabletType[resolvedBag.product.tabletTypeId] ?? []
    : [];

  useEffect(() => {
    if (!lookup?.found) return;
    const bagQrCode = lookup.bag.bagQrCode;
    if (!bagQrCode) return;
    const match = idleCards.find((c) => c.scanToken === bagQrCode);
    if (match) {
      setQrCardId(match.id);
    }
  }, [lookup, idleCards]);

  function handleLookup() {
    if (!scanValue.trim()) return;
    setError(null);
    setLookup(null);
    setProductId("");
    setQrCardId("");
    setStationId("");
    setResult(null);
    startTransition(async () => {
      try {
        const r = await lookupRawBagForStartAction(scanValue.trim());
        setLookup(r);
        if (!r.found) {
          setError(r.warnings[0] ?? "Raw bag not found.");
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : "Lookup failed.");
      }
    });
  }

  function handleStart() {
    if (!resolvedBag || !productId || !qrCardId || !stationId) return;
    setError(null);
    startTransition(async () => {
      try {
        const r = await startProductionForRawBagAction({
          inventoryBagId: resolvedBag.bag.id,
          productId,
          qrCardId,
          stationId,
        });
        setResult(r);
        if (!r.ok) {
          setError(r.error);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : "Start failed.");
      }
    });
  }

  function handleReset() {
    setScanValue("");
    setLookup(null);
    setProductId("");
    setQrCardId("");
    setStationId("");
    setResult(null);
    setError(null);
  }

  if (result && result.ok) {
    return <StartedPanel result={result} onAnother={handleReset} />;
  }

  return (
    <div className="space-y-4">
      {error ? (
        <ProductionAlertCard tone="CRITICAL" title="Cannot start production" body={error} />
      ) : null}

      <ProductionSection
        title="Step 1 · Scan the raw bag"
        subtitle="Type or scan the internal receipt number (e.g. RB-20260514-001) or the BAG-uuid QR sticker. This identifies the physical bag of tablets."
        tone={resolvedBag ? "GOOD" : "INFO"}
      >
        <div className="flex gap-2">
          <input
            value={scanValue}
            onChange={(e) => setScanValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                handleLookup();
              }
            }}
            placeholder="RB-… or BAG-…"
            className="flex-1 h-10 px-3 rounded-md border border-border bg-surface font-mono text-sm focus:border-brand-500 focus:outline-none"
            autoFocus
            disabled={pending}
          />
          <button
            type="button"
            onClick={handleLookup}
            disabled={pending || !scanValue.trim()}
            className="h-10 px-4 rounded-md bg-brand-600 hover:bg-brand-700 disabled:opacity-50 text-white text-sm font-medium"
          >
            {pending ? "Looking up…" : "Look up"}
          </button>
        </div>

        {resolvedBag ? (
          <div className="mt-3">
            <ProductionIdentityBlock
              rows={[
                {
                  label: "PO number",
                  value: resolvedBag.po.poNumber ?? "—",
                },
                { label: "Vendor", value: resolvedBag.po.vendorName ?? "—" },
                {
                  label: "Tablet product",
                  value: `${resolvedBag.product.productName ?? "(unnamed)"} (${
                    resolvedBag.product.productSku ?? "—"
                  })`,
                },
                {
                  label: "Tablet type",
                  value: resolvedBag.product.tabletTypeName,
                },
                {
                  label: "Supplier lot",
                  value: resolvedBag.supplierLot.batchNumber,
                  mono: true,
                },
                {
                  label: "Bag sequence",
                  value: String(resolvedBag.bag.bagSequence),
                },
                {
                  label: "Internal receipt",
                  value: resolvedBag.bag.internalReceiptNumber ?? "—",
                  mono: true,
                },
                {
                  label: "Raw bag QR",
                  value: resolvedBag.bag.bagQrCode ?? "—",
                  mono: true,
                },
                {
                  label: "Declared tablet count",
                  value:
                    resolvedBag.bag.declaredCount != null
                      ? resolvedBag.bag.declaredCount.toLocaleString()
                      : "—",
                },
                { label: "Status", value: resolvedBag.bag.status },
              ]}
            />
            {resolvedBag.warnings.length > 0 ? (
              <ul className="mt-2 text-[11px] text-amber-700 list-disc list-inside">
                {resolvedBag.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </ProductionSection>

      <ProductionSection
        title="Step 2 · Pick the product to produce"
        subtitle="Tablet bags can map to multiple finished SKUs (count variants, variety packs). Pick the SKU that this run will produce."
        tone={resolvedBag && productId ? "GOOD" : resolvedBag ? "INFO" : "MUTED"}
      >
        {!resolvedBag ? (
          <p className="text-sm text-text-muted">Scan a raw bag first.</p>
        ) : allowedProducts.length === 0 ? (
          <ProductionAlertCard
            tone="WARN"
            title="No allowed products configured"
            body={
              <>
                The tablet type on this bag has no products mapped to it. Configure
                allowed products at <Link className="underline" href="/settings/products">/settings/products</Link>.
              </>
            }
          />
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
            {allowedProducts.map((p) => {
              const active = productId === p.id;
              return (
                <button
                  type="button"
                  key={p.id}
                  onClick={() => setProductId(active ? "" : p.id)}
                  className={`text-left rounded-md border p-3 ${
                    active
                      ? "border-brand-500 bg-brand-50/40"
                      : "border-border hover:border-border-strong bg-surface"
                  }`}
                >
                  <div className="text-sm font-medium">{p.name}</div>
                  <div className="text-[11px] text-text-muted font-mono">
                    {p.sku} · {p.kind}
                  </div>
                  {active ? (
                    <div className="mt-2 text-[10px] uppercase tracking-wider text-brand-700">
                      Selected
                    </div>
                  ) : null}
                </button>
              );
            })}
          </div>
        )}
      </ProductionSection>

      <ProductionSection
        title="Step 3 · Assign a workflow QR card"
        subtitle="Reusable floor badges that track this bag from station to station until packaging. Only IDLE cards are eligible. After production completes, the card returns to IDLE for the next bag."
        tone={resolvedBag && productId && qrCardId ? "GOOD" : productId ? "INFO" : "MUTED"}
      >
        {!resolvedBag || !productId ? (
          <p className="text-sm text-text-muted">Pick a product first.</p>
        ) : idleCards.length === 0 ? (
          <ProductionAlertCard
            tone="WARN"
            title="No idle QR cards"
            body={
              <>
                All cards are currently ASSIGNED. Mint or retire cards at{" "}
                <Link className="underline" href="/qr-cards">/qr-cards</Link>.
              </>
            }
          />
        ) : (
          <>
            <select
              value={qrCardId}
              onChange={(e) => setQrCardId(e.target.value)}
              className="w-full h-10 px-3 rounded-md border border-border bg-surface font-mono text-sm focus:border-brand-500 focus:outline-none"
            >
              <option value="">— select an idle workflow QR card —</option>
              {idleCards.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.code}
                </option>
              ))}
            </select>
            {resolvedBag?.bag.bagQrCode &&
              idleCards.some((c) => c.scanToken === resolvedBag.bag.bagQrCode) &&
              qrCardId &&
              idleCards.find((c) => c.id === qrCardId)?.scanToken === resolvedBag.bag.bagQrCode && (
                <p className="text-[11px] text-sky-700 mt-1">QR card assigned at intake for this bag.</p>
              )}
            {resolvedBag?.bag.bagQrCode &&
              !idleCards.some((c) => c.scanToken === resolvedBag.bag.bagQrCode) && (
                <p className="text-[11px] text-amber-700 mt-1">
                  The QR card reserved for this bag ({resolvedBag.bag.bagQrCode}) is not available.
                  It may already be in production or retired.
                </p>
              )}
          </>
        )}
      </ProductionSection>

      <ProductionSection
        title="Step 4 · Pick the first station and start"
        subtitle="Usually a blistering or weighing station. The CARD_ASSIGNED event fires here, same as the floor PWA flow. Downstream events still come from station scans."
        tone={resolvedBag && productId && qrCardId && stationId ? "GOOD" : qrCardId ? "INFO" : "MUTED"}
      >
        {!resolvedBag || !productId || !qrCardId ? (
          <p className="text-sm text-text-muted">Complete the previous steps first.</p>
        ) : (
          <div className="space-y-3">
            <select
              value={stationId}
              onChange={(e) => setStationId(e.target.value)}
              className="w-full h-10 px-3 rounded-md border border-border bg-surface text-sm focus:border-brand-500 focus:outline-none"
            >
              <option value="">— select an active station —</option>
              {stations.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label} ({s.kind})
                </option>
              ))}
            </select>
            <div className="flex justify-end">
              <button
                type="button"
                onClick={handleStart}
                disabled={pending || !stationId}
                className="h-10 px-5 rounded-md bg-brand-600 hover:bg-brand-700 disabled:opacity-50 text-white text-sm font-medium"
              >
                {pending ? "Starting…" : "Start production"}
              </button>
            </div>
          </div>
        )}
      </ProductionSection>
    </div>
  );
}

function StartedPanel({
  result,
  onAnother,
}: {
  result: Extract<StartProductionResult, { ok: true }>;
  onAnother: () => void;
}) {
  return (
    <div className="space-y-4">
      <ProductionAlertCard
        tone="GOOD"
        title="Production started"
        body="The workflow QR card is now ASSIGNED to this raw bag. CARD_ASSIGNED + PRODUCT_MAPPED events have been recorded; the bag will appear on the live floor board."
      />
      <ProductionSection title="Started bag" tone="GOOD">
        <ProductionIdentityBlock
          rows={[
            { label: "Product", value: result.productName },
            { label: "Station", value: result.stationLabel },
            {
              label: "Internal receipt",
              value: result.receiptNumber ?? "—",
              mono: true,
            },
            { label: "Raw bag QR", value: result.bagQrCode ?? "—", mono: true },
            { label: "Workflow bag ID", value: result.workflowBagId, mono: true },
            { label: "QR card ID", value: result.qrCardId, mono: true },
            { label: "Inventory bag ID", value: result.inventoryBagId, mono: true },
          ]}
        />
      </ProductionSection>
      <div className="flex gap-2">
        <Link
          href="/floor-board"
          className="h-10 px-4 rounded-md bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium inline-flex items-center"
        >
          Open live floor
        </Link>
        <button
          type="button"
          onClick={onAnother}
          className="h-10 px-4 rounded-md border border-border bg-surface hover:bg-surface-2 text-sm font-medium"
        >
          Start another bag
        </button>
      </div>
    </div>
  );
}
