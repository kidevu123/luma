"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { ScanLine, Camera, RotateCcw } from "lucide-react";
import { scanCardAction, lookupCardByTokenAction } from "./actions";
import { CameraScanner } from "./camera-scanner";
import { formatRemainingEstimate } from "@/lib/production/partial-bag-resolution-constants";
import type { PartialReuseContext } from "@/lib/production/partial-bags";

export type EligibleCard = {
  id: string;
  label: string;
  scanToken: string;
  receiptNumber: string | null;
  tabletTypeName: string | null;
  tabletTypeId: string | null;
  bagNumber: number | null;
  poNumber: string | null;
};

function formatEligibleCardLabel(c: EligibleCard): string {
  const parts: string[] = [c.label];
  if (c.poNumber) parts.push(c.poNumber);
  if (c.bagNumber != null) parts.push(`Bag ${c.bagNumber}`);
  if (c.tabletTypeName) parts.push(c.tabletTypeName);
  if (c.receiptNumber) parts.push(`Receipt #${c.receiptNumber}`);
  return parts.join(" · ");
}

export type EligiblePickup = {
  id: string;
  label: string;
  scanToken: string;
  bagId: string;
  bagStage: string;
  productSku: string | null;
  receiptNumber?: string | null;
  tabletTypeName?: string | null;
  bagNumber?: number | null;
  poNumber?: string | null;
  /** BLISTERED bag with segment(s) but no lane-close yet. */
  needsSealingFinalClose?: boolean;
};

export type AllowedProduct = {
  id: string;
  sku: string;
  name: string;
  allowedTabletTypeIds: string[];
};

export function ScanCardForm({
  token,
  stationId,
  receivedCards,
  eligiblePickups = [],
  allowedProducts = [],
  requireProductForFreshBag = false,
  canStartFreshBag = true,
}: {
  token: string;
  stationId: string;
  receivedCards: EligibleCard[];
  eligiblePickups?: EligiblePickup[];
  allowedProducts?: AllowedProduct[];
  requireProductForFreshBag?: boolean;
  canStartFreshBag?: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [selectedCardId, setSelectedCardId] = React.useState("");
  const [productId, setProductId] = React.useState("");

  // P1-PARTIAL — partial reuse confirmation panel state. Set when the
  // server reports a partial bag needing explicit confirmation.
  const [partialConfirm, setPartialConfirm] = React.useState<{
    cardId: string;
    productId: string | null;
    context: PartialReuseContext;
  } | null>(null);
  const [partialSupervisorCode, setPartialSupervisorCode] = React.useState("");

  // Text scanner state
  const [scanInput, setScanInput] = React.useState("");
  const [scanError, setScanError] = React.useState<string | null>(null);
  const [scanPending, setScanPending] = React.useState(false);

  // Camera state
  const [showCamera, setShowCamera] = React.useState(false);

  // Tablet type of the last scanned bag, from lookupCardByTokenAction.
  // Used as fallback when the card is not yet in the receivedCards list.
  const [scannedTabletTypeId, setScannedTabletTypeId] = React.useState<string | null>(null);

  // Card ID resolved by typed/camera scan at a first-op station (fresh bag
  // path). Lets the product picker and submit button work for cards that
  // aren't in the server-rendered receivedCards dropdown.
  // Cleared when the user switches to the dropdown.
  const [resolvedCardId, setResolvedCardId] = React.useState<string | null>(null);

  // Display context for the last successfully resolved scan — shown as a
  // confirmation chip. Cleared when the operator types in the scan input.
  const [scannedContext, setScannedContext] = React.useState<{
    label: string;
    detail: string;
  } | null>(null);

  const receivedSet = React.useMemo(
    () => new Set(receivedCards.map((c) => c.id)),
    [receivedCards],
  );
  // True when selectedCardId was picked from the dropdown (server-rendered list).
  const isReceivedCardSelected =
    selectedCardId !== "" && receivedSet.has(selectedCardId);
  // True when a card is selected via either the dropdown or typed/camera scan.
  const hasCardSelected =
    selectedCardId !== "" &&
    (receivedSet.has(selectedCardId) || resolvedCardId === selectedCardId);

  // Filter products to those compatible with the selected bag's tablet type.
  // Primary: tablet type from the dropdown selection (selectedCard).
  // Fallback: tablet type from typed/camera scan (scannedTabletTypeId) for
  // when the card was very recently received and isn't in the dropdown yet.
  const selectedCard = receivedCards.find((c) => c.id === selectedCardId);
  const effectiveTabletTypeId = selectedCard?.tabletTypeId ?? scannedTabletTypeId;
  const filteredProducts = React.useMemo(() => {
    if (!effectiveTabletTypeId) return allowedProducts;
    // Only show products that explicitly list this tablet type.
    // Products with no configured tablet types are incomplete, not "accepts all".
    return allowedProducts.filter((p) =>
      p.allowedTabletTypeIds.includes(effectiveTabletTypeId),
    );
  }, [effectiveTabletTypeId, allowedProducts]);

  const showProductPicker =
    requireProductForFreshBag &&
    hasCardSelected &&
    filteredProducts.length > 0;

  const hasReceived = receivedCards.length > 0 && canStartFreshBag;
  const hasPickups = eligiblePickups.length > 0;
  const hasDropdownOptions = hasReceived || hasPickups;

  // Submit with an explicit cardId, bypassing the form select.
  // explicitProductId overrides the productId state for the stale-closure
  // case (single auto-selected product called before setProductId settles).
  const submitWithCardId = React.useCallback(
    async (
      cardId: string,
      explicitProductId?: string,
      partialReuse?: { confirm: true; supervisorCode: string },
    ) => {
      setPending(true);
      setError(null);
      try {
        const fd = new FormData();
        fd.set("token", token);
        fd.set("stationId", stationId);
        fd.set("cardId", cardId);
        const pid = explicitProductId ?? productId;
        if (pid) fd.set("productId", pid);
        if (partialReuse) {
          fd.set("confirmPartialReuse", "true");
          if (partialReuse.supervisorCode.trim()) {
            fd.set(
              "partialReuseSupervisorCode",
              partialReuse.supervisorCode.trim(),
            );
          }
        }
        const r = await scanCardAction(fd);
        if (r && "partialReuseConfirmationRequired" in r && r.partialContext) {
          // P1-PARTIAL — show the confirmation panel; the operator
          // reviews the bag's history then confirms the start.
          setPartialConfirm({
            cardId,
            productId: pid || null,
            context: r.partialContext,
          });
        } else if (r?.error) {
          setError(r.error);
        } else {
          setPartialConfirm(null);
          setPartialSupervisorCode("");
          router.refresh();
        }
      } catch {
        setError("Start failed — please try again or refresh the page.");
      } finally {
        setPending(false);
      }
    },
    [token, stationId, productId, router],
  );

  // Primary scan resolution path — shared by camera and typed scan.
  // Dropdown is fallback only; this is the intended production floor path.
  const handleResolvedToken = React.useCallback(
    async (raw: string) => {
      setScanError(null);
      setScannedContext(null);
      setScanPending(true);
      // Show raw token immediately so the operator can see what was scanned
      // even before the server lookup completes. Overwritten with the
      // human-readable label on success.
      setScanInput(raw.trim());
      try {
        const fd = new FormData();
        fd.set("scanToken", raw.trim());
        fd.set("stationId", stationId);
        const result = await lookupCardByTokenAction(fd);
        if (!("ok" in result)) {
          setScanError(result.error);
          // Leave scanInput showing the raw token so operator can verify the QR.
          return;
        }
        const cardId = result.cardId;

        // Overwrite raw token with the human-readable bag label and show chip.
        const matchedCard = receivedCards.find((c) => c.id === cardId);
        setScanInput(result.cardLabel);
        setScannedContext({
          label: result.cardLabel,
          detail: matchedCard
            ? formatEligibleCardLabel(matchedCard)
            : result.cardLabel,
        });

        // First-op station with intake-reserved bag: resolve product then submit.
        if (requireProductForFreshBag && result.isIntakeReserved) {
          const ttId = result.tabletTypeId ?? null;
          setScannedTabletTypeId(ttId);
          setSelectedCardId(cardId);
          const narrowed = ttId
            ? allowedProducts.filter((p) => p.allowedTabletTypeIds.includes(ttId))
            : [];
          if (narrowed.length === 1 && narrowed[0]) {
            // Exactly one compatible product — auto-submit without extra click.
            // Pass product ID explicitly to avoid stale-closure on productId state.
            await submitWithCardId(cardId, narrowed[0].id);
          } else {
            // Zero or multiple products — surface the picker/error to the operator.
            setResolvedCardId(cardId);
            setProductId("");
          }
          return;
        }

        setSelectedCardId(cardId);
        await submitWithCardId(cardId);
      } catch (err) {
        // Catch thrown exceptions from server actions (DB error, network failure,
        // serialization error). Without this, the form goes blank with no feedback.
        setScanError(
          err instanceof Error ? err.message : "Scan failed — please try again.",
        );
      } finally {
        setScanPending(false);
      }
    },
    [requireProductForFreshBag, submitWithCardId, allowedProducts, receivedCards, stationId],
  );

  const handleScanKeyDown = async (
    e: React.KeyboardEvent<HTMLInputElement>,
  ) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    // Card already resolved by scan — Enter submits rather than re-scanning the label.
    if (resolvedCardId && scannedContext) {
      if (requireProductForFreshBag && filteredProducts.length > 0 && !productId) {
        setError(
          "Pick a product before starting. The first production station must record what's being made.",
        );
        return;
      }
      await submitWithCardId(resolvedCardId);
      return;
    }
    const raw = scanInput.trim();
    if (!raw || scanPending) return;
    await handleResolvedToken(raw);
  };

  const handleCameraResult = React.useCallback(
    async (scanToken: string) => {
      // Debug: append ?debug=1 to the floor URL to log camera payloads to
      // the browser console. Helps diagnose QR encoding issues in the field.
      if (new URLSearchParams(window.location.search).get("debug") === "1") {
        console.log("[floor-scan] camera decoded:", JSON.stringify(scanToken));
      }
      setShowCamera(false);
      await handleResolvedToken(scanToken);
    },
    [handleResolvedToken],
  );

  return (
    <>
      {showCamera && (
        <CameraScanner
          onResult={handleCameraResult}
          onClose={() => setShowCamera(false)}
        />
      )}

      <form
        action={async (form) => {
          setPending(true);
          setError(null);
          if (
            requireProductForFreshBag &&
            hasCardSelected &&
            (!productId || productId === "")
          ) {
            setError(
              "Pick a product before starting. The first production station must record what's being made.",
            );
            setPending(false);
            return;
          }
          try {
            const r = await scanCardAction(form);
            if (
              r &&
              "partialReuseConfirmationRequired" in r &&
              r.partialContext
            ) {
              const cardId = String(form.get("cardId") ?? "");
              setPartialConfirm({
                cardId,
                productId: productId || null,
                context: r.partialContext,
              });
            } else if (r?.error) {
              setError(r.error);
            } else {
              setPartialConfirm(null);
              router.refresh();
            }
          } catch {
            setError("Start failed — please try again or refresh the page.");
          } finally {
            setPending(false);
          }
        }}
        className="space-y-3"
      >
        <input type="hidden" name="token" value={token} />
        <input type="hidden" name="stationId" value={stationId} />

        {/* Primary scan row: text input + camera button */}
        <div className="flex gap-2">
          <div className="flex-1 space-y-1">
            <input
              type="text"
              value={scanInput}
              onChange={(e) => {
                setScanInput(e.target.value);
                setScanError(null);
                // Operator typing invalidates the resolved card — clear scan state.
                if (scannedContext !== null) {
                  setScannedContext(null);
                  setResolvedCardId(null);
                  setSelectedCardId("");
                  setScannedTabletTypeId(null);
                }
              }}
              onKeyDown={handleScanKeyDown}
              placeholder="Scan bag QR…"
              disabled={pending || scanPending}
              className="block w-full h-12 px-3 rounded-lg bg-surface border border-border text-base text-text placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-brand-500/40"
            />
          </div>
          <button
            type="button"
            onClick={() => {
              setScanError(null);
              setError(null);
              setShowCamera(true);
            }}
            disabled={pending || scanPending}
            title="Open camera"
            aria-label="Open camera scanner"
            className="h-12 w-12 flex-shrink-0 inline-flex items-center justify-center rounded-lg bg-surface border border-border text-text-muted hover:text-text hover:bg-page disabled:opacity-60 transition-colors"
          >
            <Camera className="h-5 w-5" />
          </button>
        </div>

        {scanError && (
          <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2">
            {scanError}
          </p>
        )}

        {scannedContext && !scanError && (
          <div className="flex items-center gap-1.5 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2">
            <p className="text-xs text-emerald-800 leading-snug">
              <span className="font-semibold">Scanned: </span>
              {scannedContext.detail}
            </p>
          </div>
        )}

        {/* P1-PARTIAL — explicit partial reuse confirmation */}
        {partialConfirm && (
          <div className="rounded-lg border-2 border-amber-300 bg-amber-50/70 p-3 space-y-2">
            <p className="flex items-center gap-1.5 text-sm font-semibold text-amber-900">
              <RotateCcw className="h-4 w-4" />
              {partialConfirm.context.previousProductKind === "BOTTLE"
                ? "Partial bottle bag held for reuse"
                : "This is a partial bag"}
            </p>
            <p className="text-[11px] leading-snug text-amber-900/90">
              This QR is still attached to a physical bag that has product left.
              Continue to reuse the <span className="font-semibold">same bag</span>{" "}
              for this run — you can run a different product than last time. It is
              not a fresh unused QR.
            </p>
            <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-amber-900">
              <dt className="text-amber-800/70">Last run product</dt>
              <dd>{partialConfirm.context.previousProductName ?? "—"}</dd>
              <dt className="text-amber-800/70">Previously consumed</dt>
              <dd className="tabular-nums">
                {partialConfirm.context.lastConsumedQty != null
                  ? partialConfirm.context.lastConsumedQty.toLocaleString()
                  : "unknown"}
              </dd>
              <dt className="text-amber-800/70">System remaining</dt>
              <dd className="tabular-nums font-medium">
                {formatRemainingEstimate({
                  remainingEstimate: partialConfirm.context.remainingEstimate,
                  confidence: partialConfirm.context.remainingConfidence,
                  source: partialConfirm.context.remainingSource,
                })}
              </dd>
              {partialConfirm.context.operatorRemainingEstimate != null ? (
                <>
                  <dt className="text-amber-800/70">Operator estimate</dt>
                  <dd className="tabular-nums font-medium">
                    ~
                    {partialConfirm.context.operatorRemainingEstimate.toLocaleString()}{" "}
                    <span className="font-normal text-amber-800/70">
                      (operator&apos;s note)
                    </span>
                  </dd>
                </>
              ) : null}
              <dt className="text-amber-800/70">Supplier lot</dt>
              <dd className="font-mono text-[11px]">
                {partialConfirm.context.supplierLot ?? "—"}
              </dd>
              <dt className="text-amber-800/70">Allocation history</dt>
              <dd>
                {partialConfirm.context.closedSessionCount} closed session
                {partialConfirm.context.closedSessionCount === 1 ? "" : "s"}
                {partialConfirm.context.lastClosedAt
                  ? ` · last ${new Date(partialConfirm.context.lastClosedAt).toLocaleDateString("en-CA")}`
                  : ""}
              </dd>
            </dl>
            {(partialConfirm.context.remainingEstimate == null ||
              partialConfirm.context.remainingConfidence === "LOW") && (
              <p className="text-xs font-medium text-amber-900 bg-amber-100 border border-amber-300 rounded px-2 py-1.5">
                Remaining quantity is{" "}
                {partialConfirm.context.remainingEstimate == null
                  ? "unknown"
                  : "low confidence"}{" "}
                — double-check the physical bag before starting.
              </p>
            )}
            {partialConfirm.context.remainingConfidence === "LOW" && (
              <label className="block">
                <span className="block text-[11px] font-medium text-amber-900 mb-1">
                  Supervisor badge code (required for low confidence)
                </span>
                <input
                  type="text"
                  inputMode="numeric"
                  value={partialSupervisorCode}
                  onChange={(e) => setPartialSupervisorCode(e.target.value)}
                  className="block w-full h-11 px-3 rounded-lg bg-surface border border-amber-300 text-base tabular-nums"
                />
              </label>
            )}
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                disabled={pending}
                onClick={() => {
                  setPartialConfirm(null);
                  setPartialSupervisorCode("");
                }}
                className="h-11 rounded-lg border border-border bg-surface text-sm font-medium"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={
                  pending ||
                  (partialConfirm.context.remainingConfidence === "LOW" &&
                    !partialSupervisorCode.trim())
                }
                onClick={async () => {
                  await submitWithCardId(
                    partialConfirm.cardId,
                    partialConfirm.productId ?? undefined,
                    { confirm: true, supervisorCode: partialSupervisorCode },
                  );
                }}
                className="h-11 rounded-lg bg-amber-700 text-white text-sm font-semibold disabled:opacity-60"
              >
                {pending ? "Starting…" : "Continue with this partial bag"}
              </button>
            </div>
          </div>
        )}

        {!canStartFreshBag && !hasPickups && (
          <p className="text-xs text-text-muted rounded-lg border border-border/70 bg-surface px-3 py-2">
            This station only accepts bags already routed here. Scan the bag QR when it arrives at this station.
          </p>
        )}

        {/* Dropdown — backup only. Camera/typed physical QR scan is the primary floor path. */}
        {hasDropdownOptions && (
          <>
            <p className="text-[11px] text-text-muted">
              Scanning the physical bag QR above is preferred. Use the dropdown
              only as a backup.
            </p>
            <select
              name="cardId"
              required
              value={selectedCardId}
              onChange={(e) => {
                setSelectedCardId(e.target.value);
                setScannedTabletTypeId(null);
                setProductId("");
                setScanError(null);
                setResolvedCardId(null);
              }}
              className="block w-full h-12 px-3 rounded-lg bg-surface border border-border text-base text-text"
            >
              <option value="" disabled>
                Select a received bag QR…
              </option>
              {hasPickups && (
                <optgroup label="Pick up or resume bag (same QR continues)">
                  {eligiblePickups.map((c) => (
                    <option key={c.id} value={c.id}>
                      {formatEligibleCardLabel({
                        id: c.id,
                        label: c.label,
                        scanToken: c.scanToken,
                        receiptNumber: c.receiptNumber ?? null,
                        tabletTypeName: c.tabletTypeName ?? null,
                        tabletTypeId: null,
                        bagNumber: c.bagNumber ?? null,
                        poNumber: c.poNumber ?? null,
                      })}
                      {c.productSku ? ` · ${c.productSku}` : ""}
                      {c.needsSealingFinalClose
                        ? " · sealing in progress — pick up to finalize"
                        : c.bagStage === "STARTED"
                          ? " · in progress — resume"
                          : c.bagStage === "PACKAGED"
                            ? " · partial packaged — resume sealing"
                            : ` · ${c.bagStage}`}
                    </option>
                  ))}
                </optgroup>
              )}
              {hasReceived && (
                <optgroup label={hasPickups ? "Received bags available for this station — start new run" : "Received bags available for this station"}>
                  {receivedCards.map((c) => (
                    <option key={c.id} value={c.id}>
                      {formatEligibleCardLabel(c)}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
          </>
        )}

        {canStartFreshBag && !hasReceived && (
          <p className="text-sm text-text-muted">
            No received bags are currently available for this station. Use the{" "}
            <strong>Receive Pills</strong> page to receive bags and assign QR codes.
          </p>
        )}

        {showProductPicker && (
          <div className="rounded-lg border border-amber-300 bg-amber-50/70 px-3 py-2 text-xs text-amber-900 space-y-2">
            <div className="font-semibold text-sm">What are you making?</div>
            <div className="text-amber-900/80">
              Pick the finished SKU for this production run. It will travel with
              the bag through sealing and packaging.
            </div>
            <select
              name="productId"
              required
              value={productId}
              onChange={(e) => setProductId(e.target.value)}
              className="block w-full h-12 px-3 rounded-lg bg-surface border border-border text-base text-text"
            >
              <option value="" disabled>
                — Select product —
              </option>
              {filteredProducts.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
        )}

        {requireProductForFreshBag &&
          hasCardSelected &&
          filteredProducts.length === 0 && (
            <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2">
              {effectiveTabletTypeId
                ? "No active products are configured for this tablet type at this station. Ask a supervisor to set up the product mapping."
                : "No active products configured for this station kind. Supervisor must add a product to the route."}
            </p>
          )}

        {error && (
          <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2">
            {error}
          </p>
        )}

        {/* Submit button — primarily for the dropdown selection path */}
        <button
          type="submit"
          disabled={pending || scanPending}
          onClick={async (e) => {
            // Priority 1: Scan-resolved card — submit directly.
            // Must check before scanInput because scanInput holds the card label
            // after a successful scan, which would otherwise trigger a re-scan loop
            // clearing the selected productId before the form can submit.
            if (resolvedCardId) {
              e.preventDefault();
              if (requireProductForFreshBag && filteredProducts.length > 0 && !productId) {
                setError(
                  "Pick a product before starting. The first production station must record what's being made.",
                );
                return;
              }
              await submitWithCardId(resolvedCardId);
              return;
            }
            // Priority 2: Raw typed input not yet resolved — scan it first.
            const raw = scanInput.trim();
            if (raw) {
              e.preventDefault();
              await handleResolvedToken(raw);
              return;
            }
            // Priority 3: Dropdown path — native form submit handles it.
          }}
          className="w-full h-14 inline-flex items-center justify-center gap-2 rounded-xl bg-brand-700 text-white text-base font-semibold shadow-sm hover:bg-brand-800 disabled:opacity-60 transition-colors"
        >
          <ScanLine className="h-5 w-5" />
          {pending
            ? "Starting…"
            : showProductPicker
              ? "Start production"
              : "Start bag"}
        </button>
      </form>
    </>
  );
}
