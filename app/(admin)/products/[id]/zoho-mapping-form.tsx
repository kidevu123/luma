"use client";

// ZOHO-ASSY-1 — Zoho composite-item ID mapping form for the product
// detail page.  Saves unit/display/case Zoho item IDs that will be
// used by the future tablet-receiving and assembly job workers.
// Phase 1: UI + persistence only.  No Zoho validation or live calls.

import * as React from "react";
import { Input, Label } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { updateProductZohoAssemblyMappingAction } from "./zoho-mapping-actions";

type Props = {
  productId: string;
  kind: "CARD" | "BOTTLE" | "VARIETY";
  unitsPerDisplay: number | null;
  displaysPerCase: number | null;
  zohoItemIdUnit:    string | null;
  zohoItemIdDisplay: string | null;
  zohoItemIdCase:    string | null;
};

export function ZohoMappingForm({
  productId,
  kind,
  unitsPerDisplay,
  displaysPerCase,
  zohoItemIdUnit,
  zohoItemIdDisplay,
  zohoItemIdCase,
}: Props) {
  const [pending, setPending] = React.useState(false);
  const [error,   setError]   = React.useState<string | null>(null);
  const [saved,   setSaved]   = React.useState(false);

  const showDisplay = unitsPerDisplay != null && unitsPerDisplay > 0;
  const showCase    = displaysPerCase  != null && displaysPerCase  > 0;

  return (
    <form
      action={async (form) => {
        setPending(true);
        setError(null);
        setSaved(false);
        try {
          const r = await updateProductZohoAssemblyMappingAction(form);
          if (r?.error) setError(r.error);
          else setSaved(true);
        } catch {
          setError("Session expired — please reload and try again.");
        } finally {
          setPending(false);
        }
      }}
      className="space-y-4"
    >
      <input type="hidden" name="id" value={productId} />

      <div className="space-y-1.5">
        <Label htmlFor="zohoItemIdUnit">
          {kind === "BOTTLE" ? "Bottle (unit)" : "Card (unit)"} Zoho item ID
        </Label>
        <Input
          id="zohoItemIdUnit"
          name="zohoItemIdUnit"
          defaultValue={zohoItemIdUnit ?? ""}
          placeholder="e.g. 460000012345"
          className="font-mono text-sm"
        />
        <p className="text-[11px] text-text-subtle">
          The Zoho composite item representing one finished {kind === "BOTTLE" ? "bottle" : "card"}.
        </p>
      </div>

      {showDisplay ? (
        <div className="space-y-1.5">
          <Label htmlFor="zohoItemIdDisplay">Display Zoho item ID</Label>
          <Input
            id="zohoItemIdDisplay"
            name="zohoItemIdDisplay"
            defaultValue={zohoItemIdDisplay ?? ""}
            placeholder="e.g. 460000012346"
            className="font-mono text-sm"
          />
          <p className="text-[11px] text-text-subtle">
            Composite item for a display ({unitsPerDisplay} units).
          </p>
        </div>
      ) : (
        <div className="space-y-1.5">
          <Label htmlFor="zohoItemIdDisplay" className="text-text-subtle">
            Display Zoho item ID
            <span className="ml-1.5 text-[10px] font-normal normal-case">(set units/display first)</span>
          </Label>
          <Input
            id="zohoItemIdDisplay"
            name="zohoItemIdDisplay"
            defaultValue={zohoItemIdDisplay ?? ""}
            placeholder="optional — configure units/display on product to activate"
            className="font-mono text-sm"
          />
        </div>
      )}

      {showCase ? (
        <div className="space-y-1.5">
          <Label htmlFor="zohoItemIdCase">Case Zoho item ID</Label>
          <Input
            id="zohoItemIdCase"
            name="zohoItemIdCase"
            defaultValue={zohoItemIdCase ?? ""}
            placeholder="e.g. 460000012347"
            className="font-mono text-sm"
          />
          <p className="text-[11px] text-text-subtle">
            Composite item for a case ({displaysPerCase} displays).
          </p>
        </div>
      ) : (
        <div className="space-y-1.5">
          <Label htmlFor="zohoItemIdCase" className="text-text-subtle">
            Case Zoho item ID
            <span className="ml-1.5 text-[10px] font-normal normal-case">(set displays/case first)</span>
          </Label>
          <Input
            id="zohoItemIdCase"
            name="zohoItemIdCase"
            defaultValue={zohoItemIdCase ?? ""}
            placeholder="optional — configure displays/case on product to activate"
            className="font-mono text-sm"
          />
        </div>
      )}

      {error && (
        <p className="text-xs text-crit-700 bg-crit-50 border border-crit-500/30 rounded-md px-3 py-2">
          {error}
        </p>
      )}
      {saved && (
        <p className="text-xs text-good-700 bg-good-50 border border-good-500/30 rounded-md px-3 py-2">
          Zoho assembly mapping saved.
        </p>
      )}

      <div className="flex justify-end">
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save mapping"}
        </Button>
      </div>
    </form>
  );
}
