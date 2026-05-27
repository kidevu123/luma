"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { ScanLine, Camera } from "lucide-react";
import { scanCardAction, lookupCardByTokenAction } from "./actions";
import { CameraScanner } from "./camera-scanner";
import {
  decideScanStartAfterLookup,
  narrowProductsByTablet,
  productConfigErrorMessage,
  shouldIgnoreDuplicateScan,
} from "@/lib/production/floor-scan-start-flow";

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

  const [scanInput, setScanInput] = React.useState("");
  const [scanError, setScanError] = React.useState<string | null>(null);
  const [scanPending, setScanPending] = React.useState(false);
  const [productConfigError, setProductConfigError] = React.useState<string | null>(
    null,
  );

  const [showCamera, setShowCamera] = React.useState(false);
  const [scannedTabletTypeId, setScannedTabletTypeId] = React.useState<string | null>(
    null,
  );
  const [resolvedCardId, setResolvedCardId] = React.useState<string | null>(null);
  const [scannedContext, setScannedContext] = React.useState<{
    label: string;
    detail: string;
    rawToken?: string;
  } | null>(null);

  const scanInFlightTokenRef = React.useRef<string | null>(null);
  const submitInFlightRef = React.useRef(false);
  const submitModeRef = React.useRef<"start" | "pickup">("start");

  const receivedSet = React.useMemo(
    () => new Set(receivedCards.map((c) => c.id)),
    [receivedCards],
  );
  const hasCardSelected =
    selectedCardId !== "" &&
    (receivedSet.has(selectedCardId) || resolvedCardId === selectedCardId);

  const selectedCard = receivedCards.find((c) => c.id === selectedCardId);
  const effectiveTabletTypeId = selectedCard?.tabletTypeId ?? scannedTabletTypeId;
  const filteredProducts = React.useMemo(() => {
    return narrowProductsByTablet(allowedProducts, effectiveTabletTypeId);
  }, [effectiveTabletTypeId, allowedProducts]);

  const awaitingProductPick =
    requireProductForFreshBag &&
    resolvedCardId !== null &&
    filteredProducts.length > 1 &&
    !productId;

  const showProductPicker =
    requireProductForFreshBag &&
    hasCardSelected &&
    filteredProducts.length > 0 &&
    !productConfigError;

  const hasReceived = receivedCards.length > 0 && canStartFreshBag;
  const hasPickups = eligiblePickups.length > 0;
  const hasDropdownOptions = hasReceived || hasPickups;

  const isBusy = pending || scanPending;

  const submitWithCardId = React.useCallback(
    async (cardId: string, explicitProductId?: string, mode: "start" | "pickup" = "start") => {
      if (submitInFlightRef.current) return;
      submitInFlightRef.current = true;
      setPending(true);
      setError(null);
      setScanError(null);
      try {
        const fd = new FormData();
        fd.set("token", token);
        fd.set("stationId", stationId);
        fd.set("cardId", cardId);
        const pid = explicitProductId ?? productId;
        if (pid) fd.set("productId", pid);
        const r = await scanCardAction(fd);
        if (r?.error) {
          setError(r.error);
          if (scannedContext?.rawToken) {
            setScanError(
              `Could not ${mode === "pickup" ? "pick up" : "start"} bag. Scanned: ${scannedContext.rawToken}`,
            );
          }
        } else {
          router.refresh();
        }
      } catch (err) {
        const msg =
          err instanceof Error ? err.message : "Start failed — please try again or refresh the page.";
        setError(msg);
        if (scannedContext?.rawToken) {
          setScanError(`Scanned: ${scannedContext.rawToken}`);
        }
      } finally {
        setPending(false);
        submitInFlightRef.current = false;
        scanInFlightTokenRef.current = null;
      }
    },
    [token, stationId, productId, router, scannedContext?.rawToken],
  );

  const handleResolvedToken = React.useCallback(
    async (raw: string) => {
      const trimmed = raw.trim();
      if (
        shouldIgnoreDuplicateScan({
          rawToken: trimmed,
          inFlightToken: scanInFlightTokenRef.current,
          submitInFlight: submitInFlightRef.current,
          scanPending,
        })
      ) {
        return;
      }

      scanInFlightTokenRef.current = trimmed;
      setScanError(null);
      setError(null);
      setProductConfigError(null);
      setScanInput(trimmed);
      setScannedContext({
        label: trimmed,
        detail: trimmed,
        rawToken: trimmed,
      });
      setScanPending(true);

      try {
        const fd = new FormData();
        fd.set("scanToken", trimmed);
        const result = await lookupCardByTokenAction(fd);
        if (!("ok" in result)) {
          setScanError(
            result.error +
              (trimmed.length > 0 ? ` (scanned: ${trimmed})` : ""),
          );
          return;
        }

        const cardId = result.cardId;
        const matchedCard = receivedCards.find((c) => c.id === cardId);
        const detail = matchedCard
          ? formatEligibleCardLabel(matchedCard)
          : result.cardLabel;

        setScanInput(result.cardLabel);
        setScannedContext({
          label: result.cardLabel,
          detail,
          rawToken: trimmed,
        });
        setSelectedCardId(cardId);

        const decision = decideScanStartAfterLookup({
          requireProductForFreshBag,
          isIntakeReserved: result.isIntakeReserved,
          tabletTypeId: result.tabletTypeId,
          allowedProducts,
        });

        if (decision.kind === "config-error") {
          submitModeRef.current = "start";
          setScannedTabletTypeId(result.tabletTypeId ?? null);
          setResolvedCardId(cardId);
          setProductId("");
          setProductConfigError(decision.message);
          return;
        }

        if (decision.kind === "pick-product") {
          submitModeRef.current = "start";
          setScannedTabletTypeId(result.tabletTypeId ?? null);
          setResolvedCardId(cardId);
          setProductId("");
          return;
        }

        if (decision.kind === "auto-start") {
          submitModeRef.current = "start";
          setScannedTabletTypeId(result.tabletTypeId ?? null);
          setResolvedCardId(cardId);
          await submitWithCardId(cardId, decision.productId, "start");
          return;
        }

        // pickup-auto — downstream pickup or in-flight bag at first-op
        submitModeRef.current = "pickup";
        setResolvedCardId(null);
        await submitWithCardId(cardId, undefined, "pickup");
      } catch (err) {
        setScanError(
          (err instanceof Error ? err.message : "Scan failed — please try again.") +
            (trimmed.length > 0 ? ` (scanned: ${trimmed})` : ""),
        );
      } finally {
        setScanPending(false);
        if (!submitInFlightRef.current) {
          scanInFlightTokenRef.current = null;
        }
      }
    },
    [
      requireProductForFreshBag,
      submitWithCardId,
      allowedProducts,
      receivedCards,
      scanPending,
    ],
  );

  const handleScanKeyDown = async (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    if (resolvedCardId && scannedContext && !scanPending && !pending) {
      if (productConfigError) return;
      if (awaitingProductPick || (showProductPicker && !productId)) {
        setError(
          "Pick a product before starting. The first production station must record what's being made.",
        );
        return;
      }
      await submitWithCardId(
        resolvedCardId,
        productId || undefined,
        submitModeRef.current,
      );
      return;
    }
    const raw = scanInput.trim();
    if (!raw || scanPending || pending) return;
    await handleResolvedToken(raw);
  };

  const handleCameraResult = React.useCallback(
    async (scanToken: string) => {
      if (new URLSearchParams(window.location.search).get("debug") === "1") {
        console.log("[floor-scan] camera decoded:", JSON.stringify(scanToken));
      }
      setShowCamera(false);
      await handleResolvedToken(scanToken);
    },
    [handleResolvedToken],
  );

  const primaryButtonLabel = (() => {
    if (scanPending && !pending) return "Looking up bag…";
    if (pending) {
      return submitModeRef.current === "pickup" ? "Picking up bag…" : "Starting bag…";
    }
    if (showProductPicker || awaitingProductPick) return "Start production";
    return "Start bag";
  })();

  const showPrimaryButton =
    hasDropdownOptions ||
    resolvedCardId !== null ||
    scanInput.trim().length > 0 ||
    hasCardSelected;

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
            if (r?.error) setError(r.error);
            else router.refresh();
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

        <p className="text-sm font-medium text-text">
          Scan the physical bag QR to start or pick up a bag
        </p>

        <div className="flex gap-2">
          <div className="flex-1 space-y-1">
            <input
              type="text"
              value={scanInput}
              onChange={(e) => {
                setScanInput(e.target.value);
                setScanError(null);
                setProductConfigError(null);
                if (scannedContext !== null) {
                  setScannedContext(null);
                  setResolvedCardId(null);
                  setSelectedCardId("");
                  setScannedTabletTypeId(null);
                  scanInFlightTokenRef.current = null;
                }
              }}
              onKeyDown={handleScanKeyDown}
              placeholder="Scan bag QR…"
              disabled={isBusy}
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
            disabled={isBusy}
            title="Open camera"
            aria-label="Open camera scanner"
            className="h-12 w-12 flex-shrink-0 inline-flex items-center justify-center rounded-lg bg-surface border border-border text-text-muted hover:text-text hover:bg-page disabled:opacity-60 transition-colors"
          >
            <Camera className="h-5 w-5" />
          </button>
        </div>

        {scanPending && !pending && (
          <p className="text-sm text-text-muted" role="status">
            Looking up bag…
          </p>
        )}

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

        {!canStartFreshBag && !hasPickups && (
          <p className="text-xs text-text-muted rounded-lg border border-border/70 bg-surface px-3 py-2">
            This station only accepts bags already routed here. Scan the bag QR when it
            arrives at this station.
          </p>
        )}

        {hasDropdownOptions && (
          <>
            <p className="text-[11px] text-text-muted">
              Scanning the physical bag QR above is preferred. Use the dropdown only as a
              backup.
            </p>
            <select
              name="cardId"
              required={!resolvedCardId}
              value={selectedCardId}
              onChange={(e) => {
                setSelectedCardId(e.target.value);
                setScannedTabletTypeId(null);
                setProductId("");
                setScanError(null);
                setProductConfigError(null);
                setResolvedCardId(null);
                setScannedContext(null);
                scanInFlightTokenRef.current = null;
              }}
              className="block w-full h-12 px-3 rounded-lg bg-surface border border-border text-base text-text"
            >
              <option value="" disabled>
                Select a received bag QR…
              </option>
              {hasPickups && (
                <optgroup label="Pick up released bag (same QR continues)">
                  {eligiblePickups.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.label}
                      {c.productSku ? ` — ${c.productSku}` : ""}
                      {` · ${c.bagStage}`}
                    </option>
                  ))}
                </optgroup>
              )}
              {hasReceived && (
                <optgroup
                  label={
                    hasPickups
                      ? "Received bags available for this station — start new run"
                      : "Received bags available for this station"
                  }
                >
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
              Pick the finished SKU for this production run. It will travel with the bag
              through sealing and packaging.
            </div>
            <select
              name="productId"
              required
              value={productId}
              onChange={(e) => {
                const pid = e.target.value;
                setProductId(pid);
                setError(null);
              }}
              className="block w-full h-12 px-3 rounded-lg bg-surface border border-border text-base text-text"
            >
              <option value="" disabled>
                — Select product —
              </option>
              {filteredProducts.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.sku} — {p.name}
                </option>
              ))}
            </select>
          </div>
        )}

        {(productConfigError ||
          (requireProductForFreshBag &&
            hasCardSelected &&
            filteredProducts.length === 0 &&
            !productConfigError)) && (
          <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2">
            {productConfigError ?? productConfigErrorMessage(effectiveTabletTypeId)}
          </p>
        )}

        {error && (
          <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2">
            {error}
          </p>
        )}

        {showPrimaryButton && (
          <button
            type="submit"
            disabled={isBusy || !!productConfigError}
            onClick={async (e) => {
              const raw = scanInput.trim();
              if (raw && !resolvedCardId) {
                e.preventDefault();
                await handleResolvedToken(raw);
                return;
              }
              if (resolvedCardId) {
                e.preventDefault();
                if (productConfigError) return;
                if (awaitingProductPick || (showProductPicker && !productId)) {
                  setError(
                    "Pick a product before starting. The first production station must record what's being made.",
                  );
                  return;
                }
                await submitWithCardId(
                  resolvedCardId,
                  productId || undefined,
                  submitModeRef.current,
                );
              }
            }}
            className="w-full h-14 inline-flex items-center justify-center gap-2 rounded-xl bg-brand-700 text-white text-base font-semibold shadow-sm hover:bg-brand-800 disabled:opacity-60 transition-colors"
          >
            <ScanLine className="h-5 w-5" />
            {primaryButtonLabel}
          </button>
        )}
      </form>
    </>
  );
}
