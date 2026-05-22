"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { ScanLine, Camera } from "lucide-react";
import { scanCardAction, lookupCardByTokenAction } from "./actions";
import { CameraScanner } from "./camera-scanner";

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

  // Text scanner state
  const [scanInput, setScanInput] = React.useState("");
  const [scanError, setScanError] = React.useState<string | null>(null);
  const [scanPending, setScanPending] = React.useState(false);

  // Camera state
  const [showCamera, setShowCamera] = React.useState(false);

  // Tablet type of the last scanned bag, from lookupCardByTokenAction.
  // Used as fallback when the card is not yet in the receivedCards list.
  const [scannedTabletTypeId, setScannedTabletTypeId] = React.useState<string | null>(null);

  const receivedSet = React.useMemo(
    () => new Set(receivedCards.map((c) => c.id)),
    [receivedCards],
  );
  const isReceivedCardSelected =
    selectedCardId !== "" && receivedSet.has(selectedCardId);

  // Filter products to those compatible with the selected bag's tablet type.
  // Primary: tablet type from the dropdown selection (selectedCard).
  // Fallback: tablet type from typed/camera scan (scannedTabletTypeId) for
  // when the card was very recently received and isn't in the dropdown yet.
  const selectedCard = receivedCards.find((c) => c.id === selectedCardId);
  const effectiveTabletTypeId = selectedCard?.tabletTypeId ?? scannedTabletTypeId;
  const filteredProducts = React.useMemo(() => {
    if (!effectiveTabletTypeId) return allowedProducts;
    return allowedProducts.filter(
      (p) => p.allowedTabletTypeIds.length === 0 || p.allowedTabletTypeIds.includes(effectiveTabletTypeId),
    );
  }, [effectiveTabletTypeId, allowedProducts]);

  const showProductPicker =
    requireProductForFreshBag &&
    isReceivedCardSelected &&
    filteredProducts.length > 0;

  const hasReceived = receivedCards.length > 0 && canStartFreshBag;
  const hasPickups = eligiblePickups.length > 0;
  const hasDropdownOptions = hasReceived || hasPickups;

  // Submit with an explicit cardId, bypassing the form select.
  const submitWithCardId = React.useCallback(
    async (cardId: string) => {
      setPending(true);
      setError(null);
      try {
        const fd = new FormData();
        fd.set("token", token);
        fd.set("stationId", stationId);
        fd.set("cardId", cardId);
        if (productId) fd.set("productId", productId);
        const r = await scanCardAction(fd);
        if (r?.error) setError(r.error);
        else router.refresh();
      } finally {
        setPending(false);
      }
    },
    [token, stationId, productId, router],
  );

  // Shared handler used by both typed scan and camera scan paths.
  const handleResolvedToken = React.useCallback(
    async (raw: string) => {
      setScanError(null);
      setScanPending(true);
      try {
        const fd = new FormData();
        fd.set("scanToken", raw.trim());
        const result = await lookupCardByTokenAction(fd);
        if (!("ok" in result)) {
          setScanError(result.error);
          return;
        }
        setScanInput("");
        const cardId = result.cardId;

        // First-op station with intake-reserved bag: show product picker.
        // Auto-select when exactly one product is compatible with this tablet type.
        if (requireProductForFreshBag && result.isIntakeReserved) {
          const ttId = result.tabletTypeId ?? null;
          setScannedTabletTypeId(ttId);
          setSelectedCardId(cardId);
          const narrowed = ttId
            ? allowedProducts.filter(
                (p) =>
                  p.allowedTabletTypeIds.length === 0 ||
                  p.allowedTabletTypeIds.includes(ttId),
              )
            : allowedProducts;
          setProductId(narrowed.length === 1 && narrowed[0] ? narrowed[0].id : "");
          return;
        }

        setSelectedCardId(cardId);
        await submitWithCardId(cardId);
      } finally {
        setScanPending(false);
      }
    },
    [requireProductForFreshBag, submitWithCardId, allowedProducts],
  );

  const handleScanKeyDown = async (
    e: React.KeyboardEvent<HTMLInputElement>,
  ) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const raw = scanInput.trim();
    if (!raw || scanPending) return;
    await handleResolvedToken(raw);
  };

  const handleCameraResult = React.useCallback(
    async (scanToken: string) => {
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
            isReceivedCardSelected &&
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

        {/* Primary scan row: text input + camera button */}
        <div className="flex gap-2">
          <div className="flex-1 space-y-1">
            <input
              type="text"
              value={scanInput}
              onChange={(e) => {
                setScanInput(e.target.value);
                setScanError(null);
              }}
              onKeyDown={handleScanKeyDown}
              placeholder="Scan or type bag QR…"
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

        {!canStartFreshBag && !hasPickups && (
          <p className="text-xs text-text-muted rounded-lg border border-border/70 bg-surface px-3 py-2">
            This station only accepts bags already routed here. Scan the bag QR when it arrives at this station.
          </p>
        )}

        {/* Dropdown backup — only when there are eligible options */}
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
                <optgroup label={hasPickups ? "Received bags — start new" : "Received bags"}>
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
                  {p.sku} — {p.name}
                </option>
              ))}
            </select>
          </div>
        )}

        {requireProductForFreshBag &&
          isReceivedCardSelected &&
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
            const raw = scanInput.trim();
            if (raw) {
              e.preventDefault();
              await handleResolvedToken(raw);
            }
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
