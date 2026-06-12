"use client";

import { useState, useTransition } from "react";
import { AlertTriangle, ClipboardCheck, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  MISSED_BLISTER_BAG_CONFIRM_STRING,
  type MissedBlisterBagProposal,
} from "@/lib/ops/missed-blister-bag-backfill";
import {
  applyMissedBagBackfillAction,
  previewMissedBagBackfillAction,
} from "./actions";

type StationOption = { id: string; label: string };

const DEFAULTS = {
  workflowCardToken: "bag-card-18",
  receiptNumber: "1893-26",
  startDate: "2026-06-10",
  startTime: "07:11",
  endDate: "2026-06-10",
  endTime: "09:12",
  oldPvcRollNumber: "16",
  newPvcRollNumber: "17",
  rollChangeCounter: "1630",
  blisterCompleteCounter: "856",
  auditReason: "Operator could not record bag on blister floor PWA",
};

function field(
  label: string,
  name: string,
  defaultValue: string,
  opts?: { type?: string; hint?: string; placeholder?: string },
) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium text-text-muted">{label}</span>
      <input
        name={name}
        type={opts?.type ?? "text"}
        defaultValue={defaultValue}
        placeholder={opts?.placeholder}
        className="w-full rounded-md border border-border/70 bg-surface px-3 py-2 text-sm"
      />
      {opts?.hint ? (
        <span className="text-[10px] text-text-subtle">{opts.hint}</span>
      ) : null}
    </label>
  );
}

function ProposalSummary({ proposal }: { proposal: MissedBlisterBagProposal }) {
  return (
    <div className="rounded-lg border border-border/70 bg-surface-2/40 p-4 space-y-3 text-sm">
      <p className="font-medium">Dry-run preview</p>
      <dl className="grid gap-2 text-xs sm:grid-cols-2">
        <div>
          <dt className="text-text-muted">Card</dt>
          <dd className="font-mono">{proposal.card.scanToken}</dd>
        </div>
        <div>
          <dt className="text-text-muted">Receipt</dt>
          <dd>{proposal.receiptNumber ?? "—"}</dd>
        </div>
        <div>
          <dt className="text-text-muted">Bag segment total</dt>
          <dd className="tabular-nums">{proposal.bagSegmentTotal}</dd>
        </div>
        <div>
          <dt className="text-text-muted">Workflow bag</dt>
          <dd>{proposal.workflowBagAction}</dd>
        </div>
        <div>
          <dt className="text-text-muted">Old PVC</dt>
          <dd>{proposal.oldPvcLot.rollNumber}</dd>
        </div>
        <div>
          <dt className="text-text-muted">New PVC</dt>
          <dd>{proposal.newPvcLot.rollNumber}</dd>
        </div>
        <div>
          <dt className="text-text-muted">Foil at roll change</dt>
          <dd>{proposal.foilLot.rollNumber}</dd>
        </div>
        <div>
          <dt className="text-text-muted">Roll change time</dt>
          <dd>
            {new Date(proposal.timestamps.rollChangeAt).toLocaleString("en-US", {
              timeZone: "America/New_York",
            })}
            {proposal.timestamps.rollChangeEstimated ? " (estimated)" : ""}
          </dd>
        </div>
      </dl>
      <div className="space-y-1">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-text-subtle">
          Workflow events
        </p>
        <ul className="text-xs font-mono space-y-0.5">
          {proposal.workflowEvents.map((e) => (
            <li key={`${e.eventType}-${e.occurredAt}`}>
              {e.eventType}
              {e.eventType === "BLISTER_COMPLETE"
                ? ` count=${String(e.payload.count_total)}`
                : ""}
            </li>
          ))}
        </ul>
      </div>
      {proposal.warnings.length > 0 ? (
        <ul className="text-[11px] text-amber-800 space-y-1">
          {proposal.warnings.map((w) => (
            <li key={w}>! {w}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function MissedBagBackfillForm({ stations }: { stations: StationOption[] }) {
  const [preview, setPreview] = useState<MissedBlisterBagProposal | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [isPreviewPending, startPreview] = useTransition();
  const [isApplyPending, startApply] = useTransition();

  function readForm(form: HTMLFormElement): FormData {
    return new FormData(form);
  }

  return (
    <div className="space-y-4">
      <form
        id="missed-bag-backfill-form"
        className="grid gap-4 sm:grid-cols-2"
        onSubmit={(e) => e.preventDefault()}
      >
        {field("QR card token", "workflowCardToken", DEFAULTS.workflowCardToken)}
        {field("Receipt # (optional check)", "receiptNumber", DEFAULTS.receiptNumber)}

        <label className="block space-y-1 sm:col-span-2">
          <span className="text-xs font-medium text-text-muted">Blister station</span>
          <select
            name="blisterStationId"
            defaultValue={stations[0]?.id ?? ""}
            className="w-full rounded-md border border-border/70 bg-surface px-3 py-2 text-sm"
          >
            {stations.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </label>

        {field("Start date", "startDate", DEFAULTS.startDate, { type: "date" })}
        {field("Start time (ET)", "startTime", DEFAULTS.startTime, {
          type: "time",
          hint: "Eastern time",
        })}
        {field("End date", "endDate", DEFAULTS.endDate, { type: "date" })}
        {field("End time (ET)", "endTime", DEFAULTS.endTime, {
          type: "time",
          hint: "Eastern time",
        })}

        {field("PVC roll at start", "oldPvcRollNumber", DEFAULTS.oldPvcRollNumber, {
          hint: "Roll number or sequence (e.g. 16 → PVC-16)",
        })}
        {field("Counter at PVC change", "rollChangeCounter", DEFAULTS.rollChangeCounter, {
          type: "number",
        })}
        {field("PVC roll after change", "newPvcRollNumber", DEFAULTS.newPvcRollNumber)}
        {field("Roll change date (optional)", "rollChangeDate", "", { type: "date" })}
        {field("Roll change time ET (optional)", "rollChangeTime", "", { type: "time" })}

        {field(
          "Blister complete counter",
          "blisterCompleteCounter",
          DEFAULTS.blisterCompleteCounter,
          {
            type: "number",
            hint: "Post-roll-change segment only (not bag total)",
          },
        )}

        <label className="block space-y-1 sm:col-span-2">
          <span className="text-xs font-medium text-text-muted">Audit reason</span>
          <textarea
            name="auditReason"
            defaultValue={DEFAULTS.auditReason}
            rows={2}
            className="w-full rounded-md border border-border/70 bg-surface px-3 py-2 text-sm"
          />
        </label>
      </form>

      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="secondary"
          disabled={isPreviewPending || isApplyPending}
          onClick={() => {
            const form = document.getElementById(
              "missed-bag-backfill-form",
            ) as HTMLFormElement | null;
            if (!form) return;
            setError(null);
            setSuccess(null);
            startPreview(async () => {
              const res = await previewMissedBagBackfillAction(readForm(form));
              if (res.ok) {
                setPreview(res.proposal);
              } else {
                setPreview(null);
                setError(res.error);
              }
            });
          }}
        >
          <ClipboardCheck className="h-4 w-4" />
          {isPreviewPending ? "Previewing..." : "Preview (dry-run)"}
        </Button>
      </div>

      {preview ? <ProposalSummary proposal={preview} /> : null}
      {error ? <p className="text-sm text-red-700">{error}</p> : null}
      {success ? <p className="text-sm text-emerald-700">{success}</p> : null}

      <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 space-y-3">
        <p className="text-sm font-medium text-amber-900 flex items-center gap-2">
          <AlertTriangle className="h-4 w-4" />
          Apply backfill
        </p>
        <p className="text-xs text-amber-900/90 leading-relaxed">
          Preview first. Apply appends workflow + material events with historical
          timestamps, rebuilds roll read models, and restores the blister station
          live board snapshot so the current floor is not disturbed.
        </p>
        <label className="block space-y-1">
          <span className="text-xs font-medium text-amber-900">
            Type <span className="font-mono">{MISSED_BLISTER_BAG_CONFIRM_STRING}</span> to apply
          </span>
          <input
            name="confirm"
            form="missed-bag-apply-form"
            className="w-full rounded-md border border-amber-400 bg-white px-3 py-2 text-sm font-mono"
            placeholder={MISSED_BLISTER_BAG_CONFIRM_STRING}
          />
        </label>
        <form
          id="missed-bag-apply-form"
          onSubmit={(e) => {
            e.preventDefault();
            const main = document.getElementById(
              "missed-bag-backfill-form",
            ) as HTMLFormElement | null;
            if (!main) return;
            const merged = readForm(main);
            const confirm = (
              e.currentTarget.elements.namedItem("confirm") as HTMLInputElement
            )?.value;
            merged.set("confirm", confirm ?? "");
            setError(null);
            setSuccess(null);
            startApply(async () => {
              const res = await applyMissedBagBackfillAction(merged);
              if (res.ok) {
                setPreview(res.proposal);
                setSuccess(
                  `Backfill applied for ${res.proposal.card.scanToken}. Bag total segments: ${res.proposal.bagSegmentTotal}.`,
                );
              } else {
                setError(res.error);
              }
            });
          }}
        >
          <Button
            type="submit"
            variant="destructive"
            disabled={isApplyPending || isPreviewPending}
          >
            <Play className="h-4 w-4" />
            {isApplyPending ? "Applying..." : "Apply backfill"}
          </Button>
        </form>
      </div>
    </div>
  );
}
