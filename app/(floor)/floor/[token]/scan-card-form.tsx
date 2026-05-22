"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { ScanLine } from "lucide-react";
import { scanCardAction, lookupCardByTokenAction } from "./actions";

export type EligibleCard = { id: string; label: string; scanToken: string };

export type EligiblePickup = {
  id: string;
  label: string;
  scanToken: string;
  bagId: string;
  bagStage: string;
};

export type AllowedProduct = {
  id: string;
  sku: string;
  name: string;
};

export function ScanCardForm({
  token,
  stationId,
  idleCards,
  eligiblePickups = [],
  allowedProducts = [],
  requireProductForFreshBag = false,
  canStartFreshBag = true,
}: {
  token: string;
  stationId: string;
  idleCards: EligibleCard[];
  eligiblePickups?: EligiblePickup[];
  allowedProducts?: AllowedProduct[];
  requireProductForFreshBag?: boolean;
  /** True for stations that can start a fresh bag (BLISTER, HANDPACK_BLISTER,
   *  BOTTLE_HANDPACK, COMBINED). False hides the idle cards optgroup. */
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

  const idleSet = React.useMemo(
    () => new Set(idleCards.map((c) => c.id)),
    [idleCards],
  );
  const isIdleCardSelected =
    selectedCardId !== "" && idleSet.has(selectedCardId);
  const showProductPicker =
    requireProductForFreshBag &&
    isIdleCardSelected &&
    allowedProducts.length > 0;

  const hasIdle = idleCards.length > 0 && canStartFreshBag;
  const hasPickups = eligiblePickups.length > 0;

  // Submit with an explicit cardId (used by the text scanner path to
  // bypass the controlled select and fire immediately).
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

  const handleScanKeyDown = async (
    e: React.KeyboardEvent<HTMLInputElement>,
  ) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const raw = scanInput.trim();
    if (!raw || scanPending) return;

    setScanError(null);
    setScanPending(true);
    try {
      const fd = new FormData();
      fd.set("scanToken", raw);
      const result = await lookupCardByTokenAction(fd);
      if (!("ok" in result)) {
        setScanError(result.error);
        return;
      }
      setScanInput("");
      const cardId = result.cardId;

      // If this is an idle card at a first-op station that requires a
      // product pick, populate the select and let the operator choose.
      if (requireProductForFreshBag && idleSet.has(cardId)) {
        setSelectedCardId(cardId);
        setProductId("");
        return;
      }

      // For all other cases (pickup, or idle at non-product-required
      // station), submit immediately.
      setSelectedCardId(cardId);
      await submitWithCardId(cardId);
    } finally {
      setScanPending(false);
    }
  };

  return (
    <form
      action={async (form) => {
        setPending(true);
        setError(null);
        if (
          requireProductForFreshBag &&
          isIdleCardSelected &&
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
        } finally {
          setPending(false);
        }
      }}
      className="space-y-3"
    >
      <input type="hidden" name="token" value={token} />
      <input type="hidden" name="stationId" value={stationId} />

      {/* Wedge scanner / keyboard text input */}
      <div className="space-y-1">
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
        {scanError && (
          <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2">
            {scanError}
          </p>
        )}
      </div>

      {(hasIdle || hasPickups) && (
        <select
          name="cardId"
          required
          value={selectedCardId}
          onChange={(e) => {
            setSelectedCardId(e.target.value);
            setProductId("");
          }}
          className="block w-full h-12 px-3 rounded-lg bg-surface border border-border text-base text-text"
        >
          <option value="" disabled>
            Select an available bag QR…
          </option>
          {hasPickups && (
            <optgroup label="Pick up released bag (same QR continues)">
              {eligiblePickups.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label} — bag {c.bagId.slice(0, 8)} · {c.bagStage}
                </option>
              ))}
            </optgroup>
          )}
          {hasIdle && (
            <optgroup label={hasPickups ? "Start a new bag" : "Available bag QRs"}>
              {idleCards.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </optgroup>
          )}
        </select>
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
            {allowedProducts.map((p) => (
              <option key={p.id} value={p.id}>
                {p.sku} — {p.name}
              </option>
            ))}
          </select>
        </div>
      )}

      {requireProductForFreshBag &&
        isIdleCardSelected &&
        allowedProducts.length === 0 && (
          <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2">
            No active products configured for this station kind. Supervisor
            must add a product to the route.
          </p>
        )}

      {hasPickups && (
        <p className="text-[11px] text-text-muted">
          A "Pick up" option claims a bag released from the previous station.
          The same QR card stays attached to the bag.
        </p>
      )}
      {error && (
        <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2">
          {error}
        </p>
      )}
      <button
        type="submit"
        disabled={pending || scanPending}
        className="w-full h-14 inline-flex items-center justify-center gap-2 rounded-xl bg-brand-700 text-white text-base font-semibold shadow-sm hover:bg-brand-800 disabled:opacity-60 transition-colors"
      >
        <ScanLine className="h-5 w-5" />
        {pending
          ? "Scanning…"
          : showProductPicker
            ? "Start production"
            : "Scan bag QR"}
      </button>
    </form>
  );
}
