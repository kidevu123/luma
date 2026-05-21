"use client";

import * as React from "react";
import { Plus, Trash2, Star, Pill, PackageCheck } from "lucide-react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Select, Label } from "@/components/ui/input";
import { StatusPill } from "@/components/ui/page-header";
import type { LotSourceSummary } from "@/lib/db/queries/products";
import {
  toggleAllowedTabletAction,
  saveSpecAction,
  deleteSpecAction,
} from "./actions";

// BOM editor — two stacked sections:
//   1. Allowed tablets — checkbox grid; primary star is a single-pick.
//   2. Packaging spec — repeating row of (material, qty, scope, notes).
// Saves are immediate per-row (optimistic w/ revalidate). No bulk
// "Save all" because per-row writes give us audit granularity for
// free, and an operator never wants to lose 20 minutes of edits to a
// stale browser tab.

type AllowedRow = { tabletTypeId: string; isPrimary: boolean; tabletName: string };
type SpecRow = {
  packagingMaterialId: string;
  qtyPerUnit: number;
  perScope: string;
  notes: string | null;
  materialSku: string;
  materialName: string;
  materialKind: string;
  materialUom: string;
};
type Material = { id: string; sku: string; name: string; kind: string; uom: string };
type Tablet = { id: string; name: string };

export function BomEditor({
  productId,
  tablets,
  materials,
  allowed,
  specs,
  lotSummary,
}: {
  productId: string;
  tablets: Tablet[];
  materials: Material[];
  allowed: AllowedRow[];
  specs: SpecRow[];
  lotSummary?: Map<string, LotSourceSummary>;
}) {
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const allowedById = new Map(allowed.map((a) => [a.tabletTypeId, a]));

  async function toggleTablet(tabletTypeId: string, enabled: boolean, isPrimary = false) {
    setPending(true);
    setError(null);
    const r = await toggleAllowedTabletAction({
      productId,
      tabletTypeId,
      enabled,
      isPrimary,
    });
    setPending(false);
    if (r?.error) setError(r.error);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Bill of materials</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <section className="space-y-2">
          <div className="flex items-center justify-between">
            <Label className="flex items-center gap-1.5">
              <Pill className="h-3.5 w-3.5 text-text-subtle" /> Allowed tablets
            </Label>
            <span className="text-[11px] text-text-subtle">
              {allowed.length} selected
            </span>
          </div>
          {tablets.length === 0 ? (
            <p className="text-xs text-text-muted">
              No tablet types yet. Create them under Settings → Tablet types.
            </p>
          ) : (
            <ul className="grid sm:grid-cols-2 gap-1.5">
              {tablets.map((t) => {
                const a = allowedById.get(t.id);
                const on = !!a;
                return (
                  <li
                    key={t.id}
                    className="flex items-center justify-between rounded-md border border-border/70 bg-surface px-2.5 py-1.5"
                  >
                    <label className="flex items-center gap-2 text-sm cursor-pointer min-w-0">
                      <input
                        type="checkbox"
                        checked={on}
                        disabled={pending}
                        onChange={(e) => toggleTablet(t.id, e.target.checked, false)}
                        className="h-3.5 w-3.5"
                      />
                      <span className="truncate">{t.name}</span>
                    </label>
                    <button
                      type="button"
                      disabled={!on || pending}
                      title={a?.isPrimary ? "Primary" : "Set primary"}
                      onClick={() => toggleTablet(t.id, true, !a?.isPrimary)}
                      className="text-text-subtle hover:text-amber-600 disabled:opacity-30"
                    >
                      <Star
                        className={`h-3.5 w-3.5${a?.isPrimary ? " fill-amber-500 text-amber-500" : ""}`}
                      />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section className="space-y-2">
          <div className="flex items-center justify-between">
            <Label className="flex items-center gap-1.5">
              <PackageCheck className="h-3.5 w-3.5 text-text-subtle" /> Packaging
            </Label>
            <span className="text-[11px] text-text-subtle">
              {specs.length} item{specs.length === 1 ? "" : "s"}
            </span>
          </div>
          <SpecsTable productId={productId} specs={specs} materials={materials} {...(lotSummary ? { lotSummary } : {})} />
        </section>

        {error && (
          <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded px-2 py-1">
            {error}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function lotSourceBadge(summary: LotSourceSummary | undefined): {
  label: string;
  kind: "ok" | "warn" | "danger" | "neutral" | "info";
} {
  if (!summary) return { label: "No lots on record", kind: "neutral" };
  if (summary.totalQty === 0) return { label: "No stock", kind: "danger" };
  if (summary.packtrack > 0) return { label: "PackTrack-backed", kind: "ok" };
  return { label: "Manual only", kind: "warn" };
}

function lotSourceDetail(summary: LotSourceSummary | undefined): string | null {
  if (!summary) return null;
  const parts: string[] = [];
  if (summary.packtrack > 0) {
    parts.push(`${summary.packtrack} PackTrack lot${summary.packtrack === 1 ? "" : "s"}`);
  }
  if (summary.manual > 0) {
    parts.push(`${summary.manual} manual lot${summary.manual === 1 ? "" : "s"}`);
  }
  if (parts.length === 0) return null;
  return `${parts.join(" · ")} · ${summary.totalQty.toLocaleString()} available`;
}

function SpecsTable({
  productId,
  specs,
  materials,
  lotSummary,
}: {
  productId: string;
  specs: SpecRow[];
  materials: Material[];
  lotSummary?: Map<string, LotSourceSummary>;
}) {
  const [adding, setAdding] = React.useState(false);
  const [draft, setDraft] = React.useState({
    packagingMaterialId: "",
    qtyPerUnit: 1,
    perScope: "UNIT" as "UNIT" | "DISPLAY" | "CASE",
    notes: "",
  });
  const [pending, setPending] = React.useState<string | null>(null);
  const [err, setErr] = React.useState<string | null>(null);

  const usedKeys = new Set(specs.map((s) => `${s.packagingMaterialId}|${s.perScope}`));
  const availableMaterials = materials.filter(
    (m) => !usedKeys.has(`${m.id}|${draft.perScope}`),
  );

  async function add() {
    if (!draft.packagingMaterialId) return;
    setPending("new");
    setErr(null);
    const r = await saveSpecAction({
      productId,
      packagingMaterialId: draft.packagingMaterialId,
      qtyPerUnit: draft.qtyPerUnit,
      perScope: draft.perScope,
      notes: draft.notes || null,
    });
    setPending(null);
    if (r?.error) setErr(r.error);
    else {
      setAdding(false);
      setDraft({
        packagingMaterialId: "",
        qtyPerUnit: 1,
        perScope: "UNIT",
        notes: "",
      });
    }
  }

  async function remove(s: SpecRow) {
    setPending(`${s.packagingMaterialId}|${s.perScope}`);
    setErr(null);
    const r = await deleteSpecAction({
      productId,
      packagingMaterialId: s.packagingMaterialId,
      perScope: s.perScope,
    });
    setPending(null);
    if (r?.error) setErr(r.error);
  }

  return (
    <div className="space-y-2">
      {specs.length > 0 && (
        <ul className="space-y-1">
          {specs.map((s) => {
            const summary = lotSummary?.get(s.packagingMaterialId);
            const badge = lotSourceBadge(summary);
            const detail = lotSourceDetail(summary);
            return (
              <li
                key={`${s.packagingMaterialId}|${s.perScope}`}
                className="rounded-md border border-border/70 bg-surface px-2.5 py-1.5"
              >
                <div className="flex items-center justify-between">
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium truncate">{s.materialName}</div>
                    <div className="text-[11px] text-text-subtle font-mono">
                      {s.materialSku} · {s.materialKind}
                    </div>
                  </div>
                  <div className="flex items-center gap-3 text-xs">
                    <span className="tabular-nums font-medium">
                      {s.qtyPerUnit} {s.materialUom}
                    </span>
                    <StatusPill kind={s.perScope === "UNIT" ? "info" : "neutral"}>
                      per {s.perScope.toLowerCase()}
                    </StatusPill>
                    <StatusPill kind={badge.kind}>{badge.label}</StatusPill>
                    <Button
                      size="sm"
                      variant="ghost"
                      type="button"
                      disabled={pending === `${s.packagingMaterialId}|${s.perScope}`}
                      onClick={() => remove(s)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
                {detail && (
                  <div className="text-[10.5px] text-text-subtle/70 mt-0.5">{detail}</div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {adding ? (
        <div className="rounded-md border border-border/70 bg-surface-2/50 p-2.5 space-y-2">
          <div className="grid grid-cols-[1fr_70px_90px] gap-2">
            <Select
              value={draft.packagingMaterialId}
              onChange={(e) =>
                setDraft((d) => ({ ...d, packagingMaterialId: e.target.value }))
              }
            >
              <option value="">— pick material —</option>
              {availableMaterials.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name} ({m.sku})
                </option>
              ))}
            </Select>
            <Input
              type="number"
              min={1}
              value={draft.qtyPerUnit}
              onChange={(e) =>
                setDraft((d) => ({ ...d, qtyPerUnit: Number(e.target.value) || 1 }))
              }
            />
            <Select
              value={draft.perScope}
              onChange={(e) =>
                setDraft((d) => ({
                  ...d,
                  perScope: e.target.value as "UNIT" | "DISPLAY" | "CASE",
                }))
              }
            >
              <option value="UNIT">per unit</option>
              <option value="DISPLAY">per display</option>
              <option value="CASE">per case</option>
            </Select>
          </div>
          <Input
            placeholder="Notes (optional)"
            value={draft.notes}
            onChange={(e) => setDraft((d) => ({ ...d, notes: e.target.value }))}
          />
          <div className="flex justify-end gap-1.5">
            <Button
              size="sm"
              variant="ghost"
              type="button"
              onClick={() => setAdding(false)}
              disabled={pending === "new"}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              type="button"
              onClick={add}
              disabled={!draft.packagingMaterialId || pending === "new"}
            >
              {pending === "new" ? "Saving…" : "Add"}
            </Button>
          </div>
        </div>
      ) : (
        <Button size="sm" variant="secondary" type="button" onClick={() => setAdding(true)}>
          <Plus className="h-3.5 w-3.5" /> Add packaging item
        </Button>
      )}

      {err && (
        <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded px-2 py-1">
          {err}
        </p>
      )}
    </div>
  );
}
