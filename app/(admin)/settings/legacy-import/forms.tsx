"use client";

import * as React from "react";
import {
  KeyRound,
  Plus,
  Power,
  PowerOff,
  Trash2,
  Plug,
  Download,
  Database,
  Recycle,
  RotateCcw,
  Layers,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import {
  saveLegacyImportCredentialsAction,
  testLegacyImportConnectionAction,
  addLegacyImportPathAction,
  togglePathEnabledAction,
  removePathAction,
  fetchNowAction,
  runImportAction,
  previewImportAction,
  synthesizeReadModelsAction,
  synthesizeSubmissionsAction,
  releaseOrphanedLegacyCardsAction,
} from "./actions";

export function CredentialsForm({
  paUsername,
  hasToken,
  isActive,
}: {
  paUsername: string;
  hasToken: boolean;
  isActive: boolean;
}) {
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);
  const [testMsg, setTestMsg] = React.useState<{
    kind: "ok" | "err";
    text: string;
  } | null>(null);
  const [testing, setTesting] = React.useState(false);
  return (
    <div className="space-y-3">
      <form
        action={async (fd) => {
          setPending(true);
          setError(null);
          try {
            const r = await saveLegacyImportCredentialsAction(fd);
            if (r?.error) setError(r.error);
          } catch (err) {
            setError(err instanceof Error ? err.message : "Save failed.");
          } finally {
            setPending(false);
          }
        }}
        className="grid sm:grid-cols-3 gap-3 items-end"
      >
        <div className="space-y-1">
          <Label htmlFor="paUsername">PA username</Label>
          <Input
            id="paUsername"
            name="paUsername"
            defaultValue={paUsername}
            placeholder="sahilk1"
            required
            disabled={pending}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="paApiToken">API token</Label>
          <Input
            id="paApiToken"
            name="paApiToken"
            type="password"
            placeholder={hasToken ? "•••••• stored — leave blank to keep" : "paste your token"}
            autoComplete="off"
            disabled={pending}
          />
        </div>
        <div className="space-y-1">
          <Label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              name="isActive"
              defaultChecked={isActive}
              className="h-4 w-4"
            />
            Scheduled fetcher active
          </Label>
          <Button type="submit" size="sm" disabled={pending}>
            <KeyRound className="h-3.5 w-3.5" />{" "}
            {pending ? "Saving…" : "Save credentials"}
          </Button>
        </div>
        {error && (
          <p className="sm:col-span-3 text-xs text-red-700 bg-red-50 border border-red-200 rounded-md px-2 py-1.5">
            {error}
          </p>
        )}
      </form>

      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={testing || !hasToken}
          onClick={async () => {
            setTesting(true);
            setTestMsg(null);
            try {
              const r = await testLegacyImportConnectionAction();
              if (r && "error" in r && r.error) {
                setTestMsg({ kind: "err", text: r.error });
              } else if (r && "ok" in r && r.ok) {
                setTestMsg({
                  kind: "ok",
                  text: r.message ?? "Token works.",
                });
              }
            } catch (err) {
              setTestMsg({
                kind: "err",
                text: err instanceof Error ? err.message : "Test failed.",
              });
            } finally {
              setTesting(false);
            }
          }}
        >
          <Plug className="h-3.5 w-3.5" />{" "}
          {testing ? "Testing…" : "Test connection"}
        </Button>
        {testMsg && (
          <span
            className={
              "text-xs " +
              (testMsg.kind === "ok" ? "text-emerald-700" : "text-red-700")
            }
          >
            {testMsg.text}
          </span>
        )}
      </div>
    </div>
  );
}

export function AddPathForm() {
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);
  const formRef = React.useRef<HTMLFormElement>(null);
  return (
    <form
      ref={formRef}
      action={async (fd) => {
        setPending(true);
        setError(null);
        try {
          const r = await addLegacyImportPathAction(fd);
          if (r?.error) setError(r.error);
          else formRef.current?.reset();
        } catch (err) {
          setError(err instanceof Error ? err.message : "Save failed.");
        } finally {
          setPending(false);
        }
      }}
      className="border border-dashed border-border rounded-lg p-3 space-y-2.5"
    >
      <p className="text-[11px] font-semibold uppercase tracking-wider text-text-subtle">
        Add a file to fetch
      </p>
      <div className="grid sm:grid-cols-4 gap-2 items-end">
        <div className="sm:col-span-2 space-y-1">
          <Label htmlFor="remotePath">Remote path on PA</Label>
          <Input
            id="remotePath"
            name="remotePath"
            placeholder="/home/sahilk1/dumps/tt-latest.sql.gz"
            required
            disabled={pending}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="label">Label</Label>
          <Input
            id="label"
            name="label"
            placeholder="TT MySQL dump"
            required
            disabled={pending}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="kind">Kind</Label>
          <Select id="kind" name="kind" defaultValue="DB_DUMP" disabled={pending}>
            <option value="DB_DUMP">DB dump</option>
            <option value="ZOHO_CONFIG">Zoho config</option>
            <option value="OTHER">Other</option>
          </Select>
        </div>
      </div>
      {error && (
        <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-md px-2 py-1.5">
          {error}
        </p>
      )}
      <Button type="submit" size="sm" disabled={pending}>
        <Plus className="h-3.5 w-3.5" /> {pending ? "Adding…" : "Add path"}
      </Button>
    </form>
  );
}

export function PathRowActions({
  pathId,
  enabled,
}: {
  pathId: string;
  enabled: boolean;
}) {
  const [pending, setPending] = React.useState(false);
  return (
    <div className="inline-flex items-center gap-1">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={pending}
        onClick={async () => {
          setPending(true);
          try {
            await togglePathEnabledAction(pathId);
          } finally {
            setPending(false);
          }
        }}
        title={enabled ? "Disable scheduled fetch" : "Enable scheduled fetch"}
      >
        {enabled ? (
          <Power className="h-3.5 w-3.5 text-emerald-700" />
        ) : (
          <PowerOff className="h-3.5 w-3.5 text-text-subtle" />
        )}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={pending}
        onClick={async () => {
          if (!confirm("Remove this path? Stored downloads stay on disk.")) return;
          setPending(true);
          try {
            await removePathAction(pathId);
          } finally {
            setPending(false);
          }
        }}
        title="Remove path"
      >
        <Trash2 className="h-3.5 w-3.5 text-red-700" />
      </Button>
    </div>
  );
}

export function FetchNowButton() {
  const [pending, setPending] = React.useState(false);
  const [result, setResult] = React.useState<{
    kind: "ok" | "err";
    text: string;
  } | null>(null);
  return (
    <div className="flex items-center gap-2">
      <Button
        type="button"
        size="sm"
        disabled={pending}
        onClick={async () => {
          setPending(true);
          setResult(null);
          try {
            const r = await fetchNowAction();
            if (r && "error" in r && r.error) {
              setResult({ kind: "err", text: r.error });
            } else if (r && "ok" in r) {
              const perFile = r.perFile ?? [];
              const failures = perFile.filter((f) => !f.ok);
              const succLine = `${r.filesSucceeded ?? 0}/${r.filesAttempted ?? 0} files fetched.`;
              const failLine = failures.length
                ? " " +
                  failures
                    .map(
                      (f) =>
                        `${f.remotePath.split("/").pop()} → ${f.error?.slice(0, 80) ?? "failed"}`,
                    )
                    .join("; ")
                : "";
              setResult({
                kind: failures.length ? "err" : "ok",
                text: succLine + failLine,
              });
            }
          } catch (err) {
            setResult({
              kind: "err",
              text: err instanceof Error ? err.message : "Fetch failed.",
            });
          } finally {
            setPending(false);
          }
        }}
      >
        <Download className="h-3.5 w-3.5" />{" "}
        {pending ? "Fetching…" : "Fetch now"}
      </Button>
      {result && (
        <span
          className={
            "text-xs " +
            (result.kind === "ok" ? "text-emerald-700" : "text-red-700")
          }
        >
          {result.text}
        </span>
      )}
    </div>
  );
}

type PreviewState = {
  sourceFile: string;
  legacyCounts: Record<string, number>;
  alreadyMapped: Record<string, number>;
  wouldInsert: Record<string, number>;
};

type ApplyResultState = {
  ok: boolean;
  text: string;
  details: string[];
};

/** Two-step: Preview (read-only count) → Apply (with typed confirm).
 *  Apply is disabled until a Preview has been run successfully, and
 *  requires the operator to type "APPLY" before the action fires. */
export function RunImportButton() {
  const [previewPending, setPreviewPending] = React.useState(false);
  const [applyPending, setApplyPending] = React.useState(false);
  const [preview, setPreview] = React.useState<PreviewState | null>(null);
  const [previewError, setPreviewError] = React.useState<string | null>(null);
  const [confirmText, setConfirmText] = React.useState("");
  const [applyResult, setApplyResult] = React.useState<ApplyResultState | null>(null);

  const totalWouldInsert = preview
    ? Object.values(preview.wouldInsert).reduce((s, n) => s + n, 0)
    : 0;

  return (
    <div className="space-y-3 rounded-lg border border-border/70 bg-surface-2/40 p-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-text-subtle">
          TabletTracker → Luma import
        </div>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={previewPending || applyPending}
          onClick={async () => {
            setPreviewPending(true);
            setPreviewError(null);
            setApplyResult(null);
            try {
              const r = await previewImportAction();
              if (r && "error" in r && r.error) {
                setPreviewError(r.error);
                setPreview(null);
              } else if (r && "ok" in r) {
                setPreview({
                  sourceFile: r.sourceFile ?? "",
                  legacyCounts: r.legacyCounts ?? {},
                  alreadyMapped: r.alreadyMapped ?? {},
                  wouldInsert: r.wouldInsert ?? {},
                });
              }
            } catch (err) {
              setPreviewError(
                err instanceof Error ? err.message : "Preview failed.",
              );
            } finally {
              setPreviewPending(false);
            }
          }}
        >
          <Database className="h-3.5 w-3.5" />{" "}
          {previewPending ? "Reading…" : "Preview import"}
        </Button>
      </div>

      {previewError && (
        <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-md px-2 py-1.5">
          {previewError}
        </p>
      )}

      {preview && (
        <div className="space-y-3">
          <div className="text-xs text-text-muted">
            Source: <span className="font-mono">{preview.sourceFile}</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs tabular-nums">
              <thead className="text-text-subtle">
                <tr>
                  <th className="text-left font-medium pb-1">Legacy table</th>
                  <th className="text-right font-medium pb-1">Total rows</th>
                  <th className="text-right font-medium pb-1">Already mapped</th>
                  <th className="text-right font-medium pb-1">Would insert</th>
                </tr>
              </thead>
              <tbody className="font-mono">
                {Object.keys(preview.wouldInsert)
                  .sort()
                  .map((t) => {
                    const total = preview.legacyCounts[t] ?? 0;
                    const mapped = preview.alreadyMapped[t] ?? 0;
                    const ins = preview.wouldInsert[t] ?? 0;
                    return (
                      <tr key={t} className="border-t border-border/40">
                        <td className="py-1 pr-2">{t}</td>
                        <td className="py-1 px-2 text-right">{total}</td>
                        <td className="py-1 px-2 text-right text-text-subtle">
                          {mapped}
                        </td>
                        <td
                          className={
                            "py-1 pl-2 text-right " +
                            (ins > 0 ? "text-emerald-700 font-semibold" : "text-text-subtle")
                          }
                        >
                          {ins}
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
              <tfoot className="text-text-muted">
                <tr className="border-t border-border/60">
                  <td className="py-1 pr-2 font-semibold">Total</td>
                  <td className="py-1 px-2 text-right">
                    {Object.values(preview.legacyCounts).reduce((s, n) => s + n, 0)}
                  </td>
                  <td className="py-1 px-2 text-right">
                    {Object.values(preview.alreadyMapped).reduce((s, n) => s + n, 0)}
                  </td>
                  <td className="py-1 pl-2 text-right text-emerald-800 font-semibold">
                    {totalWouldInsert}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>

          {totalWouldInsert > 0 ? (
            <div className="border-t border-border/60 pt-3 space-y-2">
              <p className="text-xs text-text-muted leading-relaxed">
                Apply mints {totalWouldInsert} new rows in Luma. A pre-import
                <strong> snapshot</strong> is taken first so the operation is
                fully reversible from{" "}
                <span className="font-mono">/settings/danger-zone</span>. To
                proceed, type <span className="font-mono font-semibold">APPLY</span> below.
              </p>
              <div className="flex items-center gap-2 flex-wrap">
                <Input
                  value={confirmText}
                  onChange={(e) => setConfirmText(e.target.value)}
                  placeholder="type APPLY to confirm"
                  className="max-w-[220px]"
                  disabled={applyPending}
                />
                <Button
                  type="button"
                  variant="primary"
                  size="sm"
                  disabled={applyPending || confirmText !== "APPLY"}
                  onClick={async () => {
                    setApplyPending(true);
                    setApplyResult(null);
                    try {
                      const r = await runImportAction();
                      if (r && "error" in r && r.error) {
                        setApplyResult({
                          ok: false,
                          text: r.error,
                          details: [],
                        });
                      } else if (r && "ok" in r) {
                        const inserted = r.inserted ?? {};
                        const lines = Object.entries(inserted)
                          .filter(([, n]) => (n as number) > 0)
                          .map(([k, n]) => `${k}: ${n}`);
                        setApplyResult({
                          ok: r.ok,
                          text: `${r.ok ? "Imported" : "Imported with errors"} in ${
                            r.durationMs ?? 0
                          }ms · snapshot ${r.snapshot ?? "skipped"}${
                            r.errorCount ? ` · ${r.errorCount} errors` : ""
                          }`,
                          details:
                            lines.length > 0
                              ? lines
                              : ["nothing new — already mapped"],
                        });
                        setConfirmText("");
                      }
                    } catch (err) {
                      setApplyResult({
                        ok: false,
                        text: err instanceof Error ? err.message : "Apply failed.",
                        details: [],
                      });
                    } finally {
                      setApplyPending(false);
                    }
                  }}
                >
                  <Database className="h-3.5 w-3.5" />{" "}
                  {applyPending
                    ? "Importing…"
                    : `Apply (${totalWouldInsert} rows)`}
                </Button>
              </div>
            </div>
          ) : (
            <p className="text-xs text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-md px-2 py-1.5">
              Nothing to insert — every legacy row is already mapped.
            </p>
          )}
        </div>
      )}

      {applyResult && (
        <div
          className={
            "text-xs rounded-md px-3 py-2 border " +
            (applyResult.ok
              ? "text-emerald-800 bg-emerald-50 border-emerald-200"
              : "text-red-800 bg-red-50 border-red-200")
          }
        >
          <div className="font-medium">{applyResult.text}</div>
          {applyResult.details.length > 0 && (
            <ul className="mt-1 grid grid-cols-2 sm:grid-cols-3 gap-x-3 text-text-muted">
              {applyResult.details.map((d) => (
                <li key={d} className="font-mono text-[11px] tabular-nums">
                  {d}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/** Post-import maintenance: rebuild rollups + release orphaned cards.
 *  Both ops are idempotent and safe to re-run; both are owner-only. */
export function PostImportMaintenance() {
  const [synthPending, setSynthPending] = React.useState(false);
  const [synthResult, setSynthResult] = React.useState<string | null>(null);
  const [synthErr, setSynthErr] = React.useState<string | null>(null);
  const [releasePending, setReleasePending] = React.useState(false);
  const [releaseResult, setReleaseResult] = React.useState<string | null>(null);
  const [releaseErr, setReleaseErr] = React.useState<string | null>(null);

  return (
    <div className="space-y-3 rounded-lg border border-border/70 bg-surface-2/40 p-3">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-text-subtle">
        Post-import maintenance
      </div>

      <div className="flex flex-wrap items-start gap-3">
        <div className="space-y-1">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={synthPending}
            onClick={async () => {
              setSynthPending(true);
              setSynthResult(null);
              setSynthErr(null);
              try {
                const r = await synthesizeReadModelsAction();
                if (r && "error" in r && r.error) setSynthErr(r.error);
                else if (r && "ok" in r) {
                  setSynthResult(
                    `bag_state ${r.bagStateRows ?? 0} · bag_metrics ${r.bagMetricsRows ?? 0} · daily_throughput ${r.dailyThroughputRows ?? 0} · operator_daily ${r.operatorDailyRows ?? 0} · ${r.durationMs ?? 0}ms`,
                  );
                }
              } catch (err) {
                setSynthErr(err instanceof Error ? err.message : "Synthesis failed.");
              } finally {
                setSynthPending(false);
              }
            }}
          >
            <RotateCcw className="h-3.5 w-3.5" />{" "}
            {synthPending ? "Rebuilding…" : "Rebuild read models"}
          </Button>
          <p className="text-[11px] text-text-muted max-w-[280px] leading-snug">
            Aggregates workflow_events into the rollup tables. Auto-runs after
            every import; rerun if metrics look stale.
          </p>
          {synthResult && (
            <p className="text-[11px] text-emerald-700 font-mono">{synthResult}</p>
          )}
          {synthErr && (
            <p className="text-[11px] text-red-700">{synthErr}</p>
          )}
        </div>

        <div className="space-y-1">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={releasePending}
            onClick={async () => {
              if (
                !confirm(
                  "Release every QR card pinned to an unfinalized legacy workflow_bag?\n\nThe cards return to IDLE so the floor can scan them again. The legacy workflow_bag rows stay in the DB.",
                )
              )
                return;
              setReleasePending(true);
              setReleaseResult(null);
              setReleaseErr(null);
              try {
                const r = await releaseOrphanedLegacyCardsAction();
                if (r && "error" in r && r.error) setReleaseErr(r.error);
                else if (r && "ok" in r) {
                  setReleaseResult(`Released ${r.released ?? 0} card(s).`);
                }
              } catch (err) {
                setReleaseErr(err instanceof Error ? err.message : "Release failed.");
              } finally {
                setReleasePending(false);
              }
            }}
          >
            <Recycle className="h-3.5 w-3.5" />{" "}
            {releasePending ? "Releasing…" : "Release orphan QR cards"}
          </Button>
          <p className="text-[11px] text-text-muted max-w-[280px] leading-snug">
            Legacy bags never get a BAG_FINALIZED — without this, ASSIGNED
            cards would stay pinned forever.
          </p>
          {releaseResult && (
            <p className="text-[11px] text-emerald-700">{releaseResult}</p>
          )}
          {releaseErr && (
            <p className="text-[11px] text-red-700">{releaseErr}</p>
          )}
        </div>
      </div>
    </div>
  );
}

type SynthApplyState = {
  ok: boolean;
  text: string;
  details: string[];
};

/** Phase-2: walk the two stash tables (legacy_warehouse_submissions +
 *  legacy_machine_counts) and mint synthetic workflow_events so the
 *  rollups light up for the 7 months of historical data. Owner-only,
 *  takes a snapshot first, gated by typed "APPLY" confirmation just
 *  like RunImportButton. */
export function SynthesizeSubmissionsButton() {
  const [pending, setPending] = React.useState(false);
  const [confirmText, setConfirmText] = React.useState("");
  const [result, setResult] = React.useState<SynthApplyState | null>(null);

  return (
    <div className="space-y-3 rounded-lg border border-border/70 bg-surface-2/40 p-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-text-subtle">
          Phase 2 — synthesize legacy events
        </div>
      </div>
      <p className="text-xs text-text-muted leading-relaxed">
        Walks <span className="font-mono">legacy_warehouse_submissions</span>{" "}
        and <span className="font-mono">legacy_machine_counts</span>, mints
        synthetic <span className="font-mono">workflow_events</span> rows of
        the closest-match type, attaches each to a real or placeholder
        workflow_bag, then rebuilds the rollup tables. A pre-synthesis{" "}
        <strong>snapshot</strong> is taken first; revert from{" "}
        <span className="font-mono">/settings/danger-zone</span> if anything
        looks off. Type{" "}
        <span className="font-mono font-semibold">APPLY</span> below to
        confirm.
      </p>
      <div className="flex items-center gap-2 flex-wrap">
        <Input
          value={confirmText}
          onChange={(e) => setConfirmText(e.target.value)}
          placeholder="type APPLY to confirm"
          className="max-w-[220px]"
          disabled={pending}
        />
        <Button
          type="button"
          variant="primary"
          size="sm"
          disabled={pending || confirmText !== "APPLY"}
          onClick={async () => {
            setPending(true);
            setResult(null);
            try {
              const r = await synthesizeSubmissionsAction();
              if (r && "error" in r && r.error) {
                setResult({ ok: false, text: r.error, details: [] });
              } else if (r && "ok" in r) {
                const details: string[] = [
                  `events inserted: ${r.eventsInserted ?? 0}`,
                  `from machine_counts: ${r.machineCountsSynthesized ?? 0}`,
                  `from warehouse_submissions: ${
                    r.warehouseSubmissionsSynthesized ?? 0
                  }`,
                  `placeholder bags: ${r.placeholderBagsCreated ?? 0}`,
                ];
                if (r.readModels) {
                  details.push(
                    `bag_state ${r.readModels.bagStateRows ?? 0}`,
                    `bag_metrics ${r.readModels.bagMetricsRows ?? 0}`,
                    `daily_throughput ${
                      r.readModels.dailyThroughputRows ?? 0
                    }`,
                    `operator_daily ${r.readModels.operatorDailyRows ?? 0}`,
                  );
                }
                setResult({
                  ok: r.ok,
                  text: `${r.ok ? "Synthesized" : "Synthesized with errors"} in ${
                    r.durationMs ?? 0
                  }ms · snapshot ${r.snapshot ?? "skipped"}${
                    r.errorCount ? ` · ${r.errorCount} errors` : ""
                  }`,
                  details,
                });
                setConfirmText("");
              }
            } catch (err) {
              setResult({
                ok: false,
                text: err instanceof Error ? err.message : "Synthesis failed.",
                details: [],
              });
            } finally {
              setPending(false);
            }
          }}
        >
          <Layers className="h-3.5 w-3.5" />{" "}
          {pending ? "Synthesizing…" : "Synthesize legacy events"}
        </Button>
      </div>
      {result && (
        <div
          className={
            "text-xs rounded-md px-3 py-2 border " +
            (result.ok
              ? "text-emerald-800 bg-emerald-50 border-emerald-200"
              : "text-red-800 bg-red-50 border-red-200")
          }
        >
          <div className="font-medium">{result.text}</div>
          {result.details.length > 0 && (
            <ul className="mt-1 grid grid-cols-2 sm:grid-cols-3 gap-x-3 text-text-muted">
              {result.details.map((d) => (
                <li key={d} className="font-mono text-[11px] tabular-nums">
                  {d}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
