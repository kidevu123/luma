import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/auth-guards";
import { stations } from "@/lib/db/schema";
import { inArray } from "drizzle-orm";
import { PageHeader, EmptyState, StatusPill } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { DataTable, EmptyRow, THead, TR, TH, TD } from "@/components/ui/table";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ProductionSection } from "@/components/production/ui";
import { ClipboardCheck, AlertTriangle } from "lucide-react";
import { loadShiftReview } from "@/lib/production/shift-review-loader";
import {
  defaultShiftReviewFromTo,
  nextActionLabel,
  parseShiftReviewWindow,
  RECOVERY_DRY_RUN_HINT,
  SHIFT_REVIEW_READ_ONLY_BANNER,
} from "@/lib/production/shift-review";

export const dynamic = "force-dynamic";

const BLISTER_STATION_KINDS = ["BLISTER", "COMBINED"] as const;

export default async function ShiftReviewPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireAdmin();

  const sp = await searchParams;
  const from =
    typeof sp["from"] === "string" && sp["from"] !== "" ? sp["from"] : null;
  const to = typeof sp["to"] === "string" && sp["to"] !== "" ? sp["to"] : null;
  const stationId =
    typeof sp["station"] === "string" && sp["station"] !== "all"
      ? sp["station"]
      : null;
  const bagQuery =
    typeof sp["bag"] === "string" && sp["bag"].trim() !== "" ? sp["bag"].trim() : null;
  const flaggedOnly = sp["flagged"] === "1";

  const defaults = defaultShiftReviewFromTo();
  const window = parseShiftReviewWindow({
    from: from ?? defaults.from,
    to: to ?? defaults.to,
  });

  const blisterStations = await db
    .select({ id: stations.id, name: stations.label })
    .from(stations)
    .where(inArray(stations.kind, [...BLISTER_STATION_KINDS]))
    .orderBy(stations.label);

  const review = await loadShiftReview(db, {
    from: window.from,
    to: window.to,
    label: window.label,
    stationId,
    bagQuery,
    flaggedOnly,
  });

  const flaggedBags = review.bags.filter((bag) => bag.hasFlags);
  const cleanBags = review.bags.filter((bag) => !bag.hasFlags);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Shift review"
        description="Post-shift read-only review of blister counter segments, pause/end-shift snapshots, roll changes, and close-outs. Flags suspicious patterns for supervisor review — nothing on this page repairs data."
      />

      <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm text-text">
        <p className="font-medium text-amber-700 dark:text-amber-300">
          {SHIFT_REVIEW_READ_ONLY_BANNER}
        </p>
        <p className="mt-1 text-text-subtle">
          Recovery investigation:{" "}
          <code className="rounded bg-surface px-1 py-0.5 font-mono text-xs">
            {RECOVERY_DRY_RUN_HINT}
          </code>
        </p>
      </div>

      <form
        method="get"
        className="rounded-xl border border-border bg-surface px-4 py-3"
      >
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <div>
            <Label htmlFor="from">From</Label>
            <Input id="from" name="from" type="date" defaultValue={from ?? defaults.from} />
          </div>
          <div>
            <Label htmlFor="to">To</Label>
            <Input id="to" name="to" type="date" defaultValue={to ?? defaults.to} />
          </div>
          <div>
            <Label htmlFor="station">Station</Label>
            <Select id="station" name="station" defaultValue={stationId ?? "all"}>
              <option value="all">All blister stations</option>
              {blisterStations.map((station) => (
                <option key={station.id} value={station.id}>
                  {station.name}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label htmlFor="bag">Bag / receipt</Label>
            <Input
              id="bag"
              name="bag"
              type="search"
              placeholder="Receipt, product, bag #"
              defaultValue={bagQuery ?? ""}
            />
          </div>
          <div className="flex items-end gap-2">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                name="flagged"
                value="1"
                defaultChecked={flaggedOnly}
                className="rounded border-border"
              />
              Flagged only
            </label>
          </div>
        </div>
        <div className="mt-3 flex gap-2">
          <Button type="submit">Apply filters</Button>
          <a
            href="/shift-review"
            className="inline-flex h-9 items-center rounded-md px-3 text-sm text-text-subtle hover:text-text"
          >
            Reset
          </a>
        </div>
      </form>

      <p className="text-sm text-text-subtle">
        Review window: <span className="font-mono">{review.summary.reviewWindowLabel}</span>
      </p>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Bags touched</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold tabular-nums">
            {review.summary.bagsTouched}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Counter segments</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold tabular-nums">
            {review.summary.totalCounterSegments}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Pause / shift-end</CardTitle>
          </CardHeader>
          <CardContent className="text-sm tabular-nums">
            {review.summary.totalPauseSnapshots} pause ·{" "}
            {review.summary.totalShiftEndSnapshots} shift-end
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Flagged issues</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold tabular-nums text-amber-600">
            {review.summary.totalFlaggedIssues}
          </CardContent>
        </Card>
      </div>

      <ProductionSection
        title="Flagged bags"
        subtitle={`${flaggedBags.length} bag${flaggedBags.length === 1 ? "" : "s"} need review attention`}
        tone={flaggedBags.length > 0 ? "WARN" : "MUTED"}
      >
        {flaggedBags.length === 0 ? (
          <EmptyState
            icon={ClipboardCheck}
            title="No flagged bags in this window"
            description="Adjust the review window or filters if you expected activity. Absence of flags does not prove the shift was perfect — only that nothing suspicious was detected from recorded data."
          />
        ) : (
          <ShiftReviewBagTable bags={flaggedBags} showFlags />
        )}
      </ProductionSection>

      {!flaggedOnly && cleanBags.length > 0 && (
        <ProductionSection
          title="Other bags in window"
          subtitle={`${cleanBags.length} bag${cleanBags.length === 1 ? "" : "s"} with no suspicious flags`}
          tone="MUTED"
        >
          <ShiftReviewBagTable bags={cleanBags} showFlags={false} />
        </ProductionSection>
      )}

      {review.bags.length === 0 && (
        <EmptyState
          icon={AlertTriangle}
          title="No blister activity in this window"
          description="No counter segments, pause snapshots, roll changes, or blister close-outs were recorded for the selected filters."
        />
      )}
    </div>
  );
}

function severityPill(severity: "info" | "warn" | "danger"): "info" | "warn" | "danger" | "neutral" {
  return severity === "warn" ? "warn" : severity === "danger" ? "danger" : severity === "info" ? "info" : "neutral";
}

function ShiftReviewBagTable({
  bags,
  showFlags,
}: {
  bags: Array<{
    workflowBagId: string;
    displayLabel: string;
    productLabel: string | null;
    stage: string | null;
    stationLabel: string;
    pauseSnapshotCount: number;
    shiftEndSnapshotCount: number;
    rollChangeCount: number;
    closeOutCount: number;
    flags: Array<{
      code: string;
      message: string;
      nextAction: string;
      severity: "info" | "warn" | "danger";
    }>;
  }>;
  showFlags: boolean;
}) {
  return (
    <DataTable>
      <THead>
        <TR>
          <TH>Bag</TH>
          <TH>Stage</TH>
          <TH>Station</TH>
          <TH className="text-right">Pause</TH>
          <TH className="text-right">Shift end</TH>
          <TH className="text-right">Roll chg</TH>
          <TH className="text-right">Close-out</TH>
          {showFlags && <TH>Flags</TH>}
        </TR>
      </THead>
      <tbody>
        {bags.length === 0 ? (
          <EmptyRow colSpan={showFlags ? 8 : 7}>No bags</EmptyRow>
        ) : (
          bags.map((bag) => (
            <TR key={bag.workflowBagId}>
              <TD>
                <div className="font-medium">{bag.displayLabel}</div>
                {bag.productLabel && (
                  <div className="text-xs text-text-subtle">{bag.productLabel}</div>
                )}
              </TD>
              <TD>
                {bag.stage ? (
                  <StatusPill kind="neutral">{bag.stage}</StatusPill>
                ) : (
                  <span className="font-mono text-text-subtle">—</span>
                )}
              </TD>
              <TD className="text-sm">{bag.stationLabel}</TD>
              <TD className="text-right tabular-nums">{bag.pauseSnapshotCount}</TD>
              <TD className="text-right tabular-nums">{bag.shiftEndSnapshotCount}</TD>
              <TD className="text-right tabular-nums">{bag.rollChangeCount}</TD>
              <TD className="text-right tabular-nums">{bag.closeOutCount}</TD>
              {showFlags && (
                <TD>
                  <ul className="space-y-2 text-xs">
                    {bag.flags.map((flag) => (
                      <li key={flag.code} className="rounded border border-border p-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <StatusPill kind={severityPill(flag.severity)}>
                            {flag.code.replaceAll("_", " ")}
                          </StatusPill>
                          <span className="text-text-subtle">
                            {nextActionLabel(
                              flag.nextAction as Parameters<typeof nextActionLabel>[0],
                            )}
                          </span>
                        </div>
                        <p className="mt-1 text-text">{flag.message}</p>
                      </li>
                    ))}
                  </ul>
                </TD>
              )}
            </TR>
          ))
        )}
      </tbody>
    </DataTable>
  );
}
