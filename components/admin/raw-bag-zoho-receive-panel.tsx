"use client";

import * as React from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { RawBagZohoReceivePanelData } from "@/lib/zoho/raw-bag-receive-panel";
import type { PurchaseReceiveVerificationResult } from "@/lib/zoho/purchase-receive-verification";
import {
  commitRawBagZohoReceiveAction,
  confirmHistoricalZohoReceiveAction,
  loadRawBagZohoReceivePanelAction,
  markReconciliationRequiredAction,
  previewRawBagZohoReceiveAction,
  verifyHistoricalZohoReceiveAction,
} from "@/app/(admin)/receiving/raw-bags/actions";
import { cn } from "@/lib/utils";

type ViewerRole = "OWNER" | "ADMIN" | "MANAGER" | "LEAD" | "STAFF";

function isAdminRole(role: ViewerRole): boolean {
  return role === "OWNER" || role === "ADMIN";
}

function StatusChip({
  label,
  value,
  tone = "muted",
}: {
  label: string;
  value: string;
  tone?: "good" | "warn" | "bad" | "muted";
}) {
  const toneClass =
    tone === "good"
      ? "border-emerald-200 bg-emerald-50 text-emerald-900"
      : tone === "warn"
        ? "border-amber-200 bg-amber-50 text-amber-900"
        : tone === "bad"
          ? "border-red-200 bg-red-50 text-red-900"
          : "border-border bg-surface-2 text-text-muted";

  return (
    <div className="flex items-center justify-between gap-2 py-1 border-b border-border/30 last:border-b-0">
      <span className="text-xs uppercase tracking-wide text-text-muted">{label}</span>
      <span
        className={cn(
          "inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] font-mono",
          toneClass,
        )}
      >
        {value}
      </span>
    </div>
  );
}

export function RawBagZohoReceivePanel({
  inventoryBagId,
  viewerRole,
  compact = false,
}: {
  inventoryBagId: string;
  viewerRole: ViewerRole;
  compact?: boolean;
}) {
  const [panel, setPanel] = React.useState<RawBagZohoReceivePanelData | null>(
    null,
  );
  const [loading, setLoading] = React.useState(true);
  const [pending, setPending] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [commitConfirm, setCommitConfirm] = React.useState(false);
  const [historicalOpen, setHistoricalOpen] = React.useState(false);
  const [historicalReceiveId, setHistoricalReceiveId] = React.useState("");
  const [historicalNotes, setHistoricalNotes] = React.useState("");
  const [historicalVerification, setHistoricalVerification] = React.useState<
    Extract<PurchaseReceiveVerificationResult, { ok: true }> | null
  >(null);
  const [historicalConfirmOpen, setHistoricalConfirmOpen] = React.useState(false);

  const refresh = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    const data = await loadRawBagZohoReceivePanelAction(inventoryBagId);
    setPanel(data);
    setLoading(false);
  }, [inventoryBagId]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  const runAction = async (
    key: string,
    fn: () => Promise<{ ok: boolean; error?: string }>,
  ) => {
    setPending(key);
    setError(null);
    const result = await fn();
    setPending(null);
    if (!result.ok) {
      setError(result.error ?? "Action failed.");
      return;
    }
    setCommitConfirm(false);
    await refresh();
  };

  if (loading && !panel) {
    return (
      <div className="flex items-center gap-2 text-sm text-text-muted py-2">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading Zoho receive status…
      </div>
    );
  }

  if (!panel) {
    return (
      <p className="text-sm text-text-muted">Bag not found for Zoho receive panel.</p>
    );
  }

  const receiveTone =
    panel.receiveStatus === "received"
      ? "good"
      : panel.receiveStatus === "failed"
        ? "bad"
        : panel.receiveStatus === "previewed"
          ? "warn"
          : "muted";

  const reconciliationTone =
    panel.reconciliationStatus === "received_by_luma" ||
    panel.reconciliationStatus === "confirmed_existing"
      ? "good"
      : panel.reconciliationStatus === "reconciliation_required"
        ? "bad"
        : "warn";

  return (
    <Card className={compact ? "border-dashed" : ""}>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-sky-700" />
          Zoho purchase receive
          {panel.lumaReceipt ? (
            <span className="font-mono text-sm text-text-muted">
              Luma receipt {panel.lumaReceipt}
            </span>
          ) : null}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-0">
            <StatusChip label="Luma receipt" value={panel.lumaReceipt ?? "—"} />
            <StatusChip label="Human lot" value={panel.humanLotNumber ?? "—"} />
            <StatusChip
              label="Declared qty"
              value={panel.declaredQuantity.toLocaleString()}
            />
            <StatusChip label="PO" value={panel.poNumber ?? "—"} />
            <StatusChip label="Raw item" value={panel.rawItemName ?? "—"} />
          </div>
          <div className="space-y-0">
            <StatusChip
              label="Zoho receive"
              value={panel.receiveStatus}
              tone={receiveTone}
            />
            <StatusChip
              label="Reconciliation"
              value={panel.reconciliationStatus}
              tone={reconciliationTone}
            />
            <StatusChip
              label="Zoho purchase receive ID"
              value={panel.zohoPurchaseReceiveId ?? "—"}
            />
            <StatusChip
              label="Zoho receive number"
              value={panel.zohoReceiveNumber ?? "—"}
            />
            {panel.previewPlannedQuantity != null ? (
              <StatusChip
                label="Preview planned qty"
                value={panel.previewPlannedQuantity.toLocaleString()}
              />
            ) : null}
            {panel.lastPreviewError ? (
              <StatusChip label="Last error" value={panel.lastPreviewError} tone="bad" />
            ) : null}
          </div>
        </div>

        {panel.isLiveReceiveCommitted ? (
          <div className="flex items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50/60 px-3 py-2 text-emerald-900 text-xs">
            <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0" />
            Live Zoho receive committed for this bag. Duplicate receive is blocked.
          </div>
        ) : null}

        {error ? (
          <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50/60 px-3 py-2 text-red-900 text-xs">
            <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
            {error}
          </div>
        ) : null}

        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={!panel.canPreview || pending != null}
            onClick={() =>
              void runAction("preview", async () => {
                const r = await previewRawBagZohoReceiveAction(inventoryBagId);
                return r.ok ? { ok: true } : { ok: false, error: r.error };
              })
            }
          >
            {pending === "preview" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : null}
            Preview Zoho receive
          </Button>

          {isAdminRole(viewerRole) ? (
            <Button
              type="button"
              size="sm"
              disabled={!panel.canCommit || pending != null}
              onClick={() => setCommitConfirm((v) => !v)}
            >
              Commit Zoho receive
            </Button>
          ) : null}

          {(panel.canRetry || panel.receiveStatus === "failed") && panel.canPreview ? (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={pending != null}
              onClick={() =>
                void runAction("retry", async () => {
                  const r = await previewRawBagZohoReceiveAction(inventoryBagId);
                  return r.ok ? { ok: true } : { ok: false, error: r.error };
                })
              }
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Retry failed receive
            </Button>
          ) : null}

          {isAdminRole(viewerRole) ? (
            <>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                disabled={pending != null}
                onClick={() => setHistoricalOpen((v) => !v)}
              >
                Historical reconciliation
              </Button>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                disabled={pending != null || panel.isLiveReceiveCommitted}
                onClick={() =>
                  void runAction("reconciliation_required", async () => {
                    const r = await markReconciliationRequiredAction(inventoryBagId);
                    return r.ok ? { ok: true } : { ok: false, error: r.error };
                  })
                }
              >
                Mark reconciliation required
              </Button>
            </>
          ) : null}
        </div>

        {commitConfirm && isAdminRole(viewerRole) ? (
          <div className="rounded-lg border border-amber-200 bg-amber-50/50 p-3 space-y-2">
            <p className="text-xs text-amber-900">
              Commit will post{" "}
              <span className="font-mono font-semibold">
                {panel.previewPlannedQuantity?.toLocaleString() ??
                  panel.declaredQuantity.toLocaleString()}
              </span>{" "}
              tablets to Zoho PO line{" "}
              <span className="font-mono">{panel.zohoLineItemId ?? "—"}</span>.
              This creates one Zoho purchase receive for this physical bag only.
            </p>
            <div className="flex gap-2">
              <Button
                type="button"
                size="sm"
                disabled={!panel.canCommit || pending != null}
                onClick={() =>
                  void runAction("commit", async () => {
                    const r = await commitRawBagZohoReceiveAction(inventoryBagId);
                    return r.ok
                      ? { ok: true }
                      : { ok: false, error: r.error };
                  })
                }
              >
                {pending === "commit" ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : null}
                Confirm commit
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setCommitConfirm(false)}
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : null}

        {historicalOpen && isAdminRole(viewerRole) ? (
          <div className="rounded-lg border border-border/60 bg-surface-2/30 p-3 space-y-3">
            <p className="text-xs text-text-muted">
              Enter the Zoho Inventory purchase receive <strong>entity ID</strong>{" "}
              (long numeric string). This is not the Luma receipt (
              {panel.lumaReceipt ?? "—"}). Zoho will be queried read-only before
              confirmation.
            </p>
            <div>
              <Label htmlFor={`hist-receive-${inventoryBagId}`}>
                Zoho purchase receive ID
              </Label>
              <Input
                id={`hist-receive-${inventoryBagId}`}
                value={historicalReceiveId}
                onChange={(e) => {
                  setHistoricalReceiveId(e.target.value);
                  setHistoricalVerification(null);
                  setHistoricalConfirmOpen(false);
                }}
                placeholder="e.g. 5254962000001234567"
                className="font-mono"
              />
            </div>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={pending != null || !historicalReceiveId.trim()}
              onClick={() =>
                void runAction("verify", async () => {
                  const r = await verifyHistoricalZohoReceiveAction(
                    inventoryBagId,
                    historicalReceiveId.trim(),
                  );
                  if (!r.ok) return { ok: false, error: r.error };
                  setHistoricalVerification(r.result);
                  setHistoricalConfirmOpen(r.result.allMatch);
                  return { ok: true };
                })
              }
            >
              Verify against Zoho
            </Button>

            {historicalVerification ? (
              <div className="space-y-2 text-xs">
                <div className="font-mono space-y-1 rounded border border-border/50 p-2 bg-surface/60">
                  <div>
                    Zoho receive number:{" "}
                    {historicalVerification.verified.zohoReceiveNumber ?? "—"}
                  </div>
                  <div>
                    Zoho purchase receive ID:{" "}
                    {historicalVerification.verified.zohoPurchaseReceiveId}
                  </div>
                  <div>
                    Date: {historicalVerification.verified.receivedAt ?? "—"}
                  </div>
                  <div>
                    Quantity:{" "}
                    {historicalVerification.verified.receivedQuantity?.toLocaleString() ??
                      "—"}
                  </div>
                </div>
                <table className="w-full text-left">
                  <thead>
                    <tr className="text-[10px] uppercase text-text-muted">
                      <th className="py-1">Field</th>
                      <th className="py-1">Luma</th>
                      <th className="py-1">Zoho</th>
                      <th className="py-1">Match</th>
                    </tr>
                  </thead>
                  <tbody>
                    {historicalVerification.comparisons.map((row) => (
                      <tr key={row.field} className="border-t border-border/30">
                        <td className="py-1 font-mono">{row.field}</td>
                        <td className="py-1 font-mono">{String(row.lumaValue ?? "—")}</td>
                        <td className="py-1 font-mono">{String(row.zohoValue ?? "—")}</td>
                        <td className="py-1">{row.matches ? "yes" : "no"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}

            {historicalConfirmOpen && historicalVerification?.allMatch ? (
              <div className="space-y-2">
                <div>
                  <Label htmlFor={`hist-notes-${inventoryBagId}`}>
                    Reconciliation notes
                  </Label>
                  <Input
                    id={`hist-notes-${inventoryBagId}`}
                    value={historicalNotes}
                    onChange={(e) => setHistoricalNotes(e.target.value)}
                    placeholder="Operator notes (audit log)"
                  />
                </div>
                <Button
                  type="button"
                  size="sm"
                  disabled={pending != null || !historicalReceiveId.trim()}
                  onClick={() =>
                    void runAction("historical", async () => {
                      const r = await confirmHistoricalZohoReceiveAction(
                        inventoryBagId,
                        {
                          zohoPurchaseReceiveId: historicalReceiveId.trim(),
                          reconciliationNotes: historicalNotes.trim() || null,
                        },
                      );
                      return r.ok ? { ok: true } : { ok: false, error: r.error };
                    })
                  }
                >
                  Confirm historical match
                </Button>
              </div>
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
