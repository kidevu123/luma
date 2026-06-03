"use client";

// START-3 — Start Production guided flow.
//
// Step 1: scan / paste a raw bag receipt # or BAG-uuid QR.
// Step 2: pick the station (determines product kind filter).
// Step 3: product auto-resolved from station type, or operator picks from narrowed list.
// Step 4: click Start — the bag's own QR card (reserved at receiving) activates automatically.
//
// On success we render a StartedPanel with PO / vendor / product /
// receipt / QR / IDs and a link back to the live floor.

import { useState, useTransition, useEffect, useMemo } from "react";
import Link from "next/link";
import {
  ProductionSection,
  ProductionAlertCard,
  ProductionIdentityBlock,
} from "@/components/production/ui";
import {
  lookupRawBagForStartAction,
  lookupRawBagByIdForStartAction,
  startProductionForRawBagAction,
  type StartProductionResult,
} from "./actions";
import type { RawBagLookupResult } from "@/lib/db/queries/raw-bag-intake";
import {
  resolveStartProductionProduct,
  type CandidateProduct,
} from "@/lib/production/start-production";

type StationOpt = { id: string; label: string; kind: string };

export function StartProductionForm({
  stations,
  allowedProductsByTabletType,
  initialInventoryBagId,
}: {
  stations: StationOpt[];
  allowedProductsByTabletType: Record<string, CandidateProduct[]>;
  /** When set (e.g. from /partial-bags), pre-load this bag without auto-selecting product. */
  initialInventoryBagId?: string;
}) {
  const [scanValue, setScanValue] = useState("");
  const [lookup, setLookup] = useState<RawBagLookupResult | null>(null);
  const [stationId, setStationId] = useState("");
  const [productId, setProductId] = useState("");
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<StartProductionResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const resolvedBag = lookup && lookup.found ? lookup : null;

  const allowedProducts = useMemo(
    () =>
      resolvedBag
        ? (allowedProductsByTabletType[resolvedBag.product.tabletTypeId] ?? [])
        : [],
    [resolvedBag, allowedProductsByTabletType],
  );

  const selectedStation = useMemo(
    () => stations.find((s) => s.id === stationId) ?? null,
    [stations, stationId],
  );

  const resolution = useMemo(() => {
    if (!resolvedBag || !stationId) return null;
    return resolveStartProductionProduct({
      stationKind: selectedStation?.kind ?? null,
      candidateProducts: allowedProducts,
    });
  }, [resolvedBag, stationId, selectedStation, allowedProducts]);

  // Auto-select product when resolution is unambiguous; reset when station changes.
  useEffect(() => {
    if (resolution === null) return;
    if (resolution.kind === "auto") {
      setProductId(resolution.product.id);
    } else {
      setProductId("");
    }
  }, [resolution]);

  useEffect(() => {
    if (!initialInventoryBagId) return;
    setError(null);
    setResult(null);
    startTransition(async () => {
      try {
        const r = await lookupRawBagByIdForStartAction(initialInventoryBagId);
        setLookup(r);
        if (r.found) {
          setScanValue(
            r.bag.internalReceiptNumber ?? r.bag.bagQrCode ?? initialInventoryBagId,
          );
        } else {
          setError(r.warnings[0] ?? "Raw bag not found.");
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : "Lookup failed.");
      }
    });
  }, [initialInventoryBagId]);

  function handleLookup() {
    if (!scanValue.trim()) return;
    setError(null);
    setLookup(null);
    setStationId("");
    setProductId("");
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
    if (!resolvedBag || !productId || !stationId) return;
    setError(null);
    startTransition(async () => {
      try {
        const r = await startProductionForRawBagAction({
          inventoryBagId: resolvedBag.bag.id,
          productId,
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
    setStationId("");
    setProductId("");
    setResult(null);
    setError(null);
  }

  if (result && result.ok) {
    return <StartedPanel result={result} onAnother={handleReset} />;
  }

  // Candidates to show when operator must choose.
  const chooseCandidates =
    resolution?.kind === "choose"
      ? resolution.candidates
      : resolution?.kind === "config_error"
        ? resolution.fallback
        : [];

  return (
    <div className="space-y-4">
      {error ? (
        <ProductionAlertCard tone="CRITICAL" title="Cannot start production" body={error} />
      ) : null}

      {/* Step 1 — Scan bag */}
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
                { label: "PO number", value: resolvedBag.po.poNumber ?? "—" },
                { label: "Vendor", value: resolvedBag.po.vendorName ?? "—" },
                {
                  label: "Tablet product",
                  value: `${resolvedBag.product.productName ?? "(unnamed)"} (${
                    resolvedBag.product.productSku ?? "—"
                  })`,
                },
                { label: "Tablet type", value: resolvedBag.product.tabletTypeName },
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

      {/* Step 2 — Pick station */}
      <ProductionSection
        title="Step 2 · Pick the station"
        subtitle="Select the station this bag will start at. The station type narrows the product list in the next step."
        tone={resolvedBag && stationId ? "GOOD" : resolvedBag ? "INFO" : "MUTED"}
      >
        {!resolvedBag ? (
          <p className="text-sm text-text-muted">Scan a raw bag first.</p>
        ) : stations.length === 0 ? (
          <ProductionAlertCard
            tone="WARN"
            title="No active stations"
            body={
              <>
                No active stations found. Configure stations at{" "}
                <Link className="underline" href="/settings/machines">
                  /settings/machines
                </Link>
                .
              </>
            }
          />
        ) : (
          <select
            value={stationId}
            onChange={(e) => {
              setStationId(e.target.value);
              setProductId(""); // resolution will auto-set if unambiguous
            }}
            className="w-full h-10 px-3 rounded-md border border-border bg-surface text-sm focus:border-brand-500 focus:outline-none"
          >
            <option value="">— select an active station —</option>
            {stations.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label} ({s.kind})
              </option>
            ))}
          </select>
        )}
      </ProductionSection>

      {/* Step 3 — Product */}
      <ProductionSection
        title="Step 3 · Product"
        subtitle="The station type is used to narrow the list. When only one product matches, it is selected automatically."
        tone={
          resolvedBag && stationId && productId
            ? "GOOD"
            : resolvedBag && stationId
              ? "INFO"
              : "MUTED"
        }
      >
        {!resolvedBag || !stationId ? (
          <p className="text-sm text-text-muted">Pick a station first.</p>
        ) : allowedProducts.length === 0 ? (
          <ProductionAlertCard
            tone="WARN"
            title="No allowed products configured"
            body={
              <>
                The tablet type on this bag has no products mapped to it. Configure
                allowed products at{" "}
                <Link className="underline" href="/settings/products">
                  /settings/products
                </Link>
                .
              </>
            }
          />
        ) : resolution?.kind === "auto" ? (
          <div className="rounded-md border border-brand-300 bg-brand-50/40 px-3 py-2.5">
            <p className="text-[10px] uppercase tracking-wider text-brand-700 mb-0.5">
              Product selected automatically
            </p>
            <p className="text-sm font-medium text-text-strong">{resolution.product.name}</p>
            <p className="text-[11px] text-text-muted font-mono">
              {resolution.product.sku} · {resolution.product.kind}
            </p>
          </div>
        ) : (
          <>
            {resolution?.kind === "config_error" ? (
              <ProductionAlertCard
                tone="WARN"
                title="Product configuration mismatch"
                body={resolution.message}
              />
            ) : null}
            {chooseCandidates.length > 0 ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2 mt-2">
                {chooseCandidates.map((p) => {
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
            ) : null}
          </>
        )}
      </ProductionSection>

      {/* Step 4 — Start run */}
      <ProductionSection
        title="Step 4 · Start run"
        subtitle="The raw bag's QR card — reserved at receiving — will be activated automatically. Click Start to fire the CARD_ASSIGNED event and open this bag on the floor."
        tone={resolvedBag && stationId && productId ? "INFO" : "MUTED"}
      >
        {!resolvedBag || !stationId || !productId ? (
          <p className="text-sm text-text-muted">Complete the previous steps first.</p>
        ) : (
          <div className="flex justify-end">
            <button
              type="button"
              onClick={handleStart}
              disabled={pending}
              className="h-10 px-5 rounded-md bg-brand-600 hover:bg-brand-700 disabled:opacity-50 text-white text-sm font-medium"
            >
              {pending ? "Starting…" : "Start production"}
            </button>
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
        body="Production started. The raw bag's QR card is now linked to this workflow. CARD_ASSIGNED + PRODUCT_MAPPED events recorded; the bag will appear on the live floor board."
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
