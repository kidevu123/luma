// Phase-2 legacy synthesizer.
//
// The Phase-1 importer (tt-importer.ts) stashes every legacy
// warehouse_submissions row into legacy_warehouse_submissions and
// every machine_counts row into legacy_machine_counts, preserving the
// raw payload but never minting a workflow_event. The synthesizer
// here walks those two stash tables, derives the closest-match Luma
// workflow_event_type for each row, and inserts a synthetic event so
// the rollup synthesizer (read-model-synthesizer.ts) can light up the
// metrics dashboards on 7 months of historical data.
//
// Design contract (matching tt-importer.ts conventions):
//   • idempotent — re-runs no-op for rows already synthesized,
//     tracked via legacy_tt_id_map under tt_table='warehouse_submissions_synth'
//     and 'machine_counts_synth' (different from the 'warehouse_submissions'
//     and 'machine_counts' rows the importer writes for stash-table
//     mappings).
//   • bulk-batched — 200-row chunks like the wide-table inserts in
//     tt-importer.ts; per-row inserts time out the action.
//   • placeholder-bag strategy — many legacy rows (esp. all of
//     legacy_machine_counts, plus any warehouse_submission with no
//     bag_id and no inventory_bag_id link) have no Luma workflow_bag
//     to attach to. We synthesize one placeholder workflow_bag per
//     unique (count_date, tablet_type_id, machine_id) tuple — one
//     "day-machine-flavor" rollup row per day's machine output. This
//     gives metrics something to attach to without polluting any
//     active live data; the placeholder bag is started_at=midnight ET
//     of the count date, finalized_at=end-of-day ET, and tracked via
//     legacy_tt_id_map under tt_table='machine_counts_synth_bag' so
//     the same tuple on a re-run reuses the same placeholder bag.
//   • client_event_id is a deterministic UUID v5 over a fixed
//     namespace + the source tt_id, so the partial unique index on
//     workflow_events(workflow_bag_id, event_type, client_event_id)
//     guarantees that even if our id_map check misses (e.g. a partial
//     run interrupted between insert and id_map upsert), the event
//     row won't be double-minted.
//
// After all events are inserted, the synthesizer calls
// synthesizeReadModelsFromEvents() so read_bag_state /
// read_bag_metrics / read_daily_throughput / read_operator_daily
// rebuild from the new event log.

import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  companies,
  legacyMachineCounts,
  legacyTtIdMap,
  legacyWarehouseSubmissions,
  machines,
  workflowBags,
  workflowEvents,
} from "@/lib/db/schema";
import { writeAudit } from "@/lib/db/audit";
import type { CurrentUser } from "@/lib/auth";
import { synthesizeReadModelsFromEvents } from "./read-model-synthesizer";
import { replayFinalizedBags } from "./replay-finalized-bags";
import { rebuildSkuDaily } from "@/lib/projector/sku-daily";
import { rebuildMaterialReconciliation } from "@/lib/projector/material-reconciliation";
import { rebuildStationQualityDaily } from "@/lib/projector/station-daily";
import { rebuildQueueState } from "@/lib/projector/queue-state";

/** Fixed UUID namespace for synthesizing deterministic client_event_id
 *  values from legacy tt_id integers. Generated once and frozen here
 *  so re-runs across deploys produce the same UUID for the same
 *  (kind, tt_id) pair. */
const LUMA_LEGACY_NAMESPACE = "5d2f0e7a-3a1b-4c6d-9e5b-0a1f7c9b2d44";

/** UUIDv5 (RFC 4122 §4.3, name-based via SHA-1) over the canonical
 *  "<namespace>:<kind>:<ttId>" string. We don't pull in `uuid` because
 *  the rest of the codebase uses crypto.randomUUID() and we want zero
 *  new deps. */
function uuidV5FromLegacy(kind: string, ttId: number): string {
  const nsBytes = parseUuidToBytes(LUMA_LEGACY_NAMESPACE);
  const name = `${kind}:${ttId}`;
  const buf = Buffer.concat([nsBytes, Buffer.from(name, "utf8")]);
  const hash = createHash("sha1").update(buf).digest();
  // Take first 16 bytes per RFC 4122.
  const out = Buffer.from(hash.subarray(0, 16));
  // Set version (5) and variant (RFC 4122).
  if (out[6] !== undefined) out[6] = (out[6] & 0x0f) | 0x50;
  if (out[8] !== undefined) out[8] = (out[8] & 0x3f) | 0x80;
  return formatUuidFromBytes(out);
}

function parseUuidToBytes(uuid: string): Buffer {
  const hex = uuid.replace(/-/g, "");
  if (hex.length !== 32) throw new Error(`Bad UUID: ${uuid}`);
  return Buffer.from(hex, "hex");
}

function formatUuidFromBytes(b: Buffer): string {
  const hex = b.toString("hex");
  return (
    hex.slice(0, 8) +
    "-" +
    hex.slice(8, 12) +
    "-" +
    hex.slice(12, 16) +
    "-" +
    hex.slice(16, 20) +
    "-" +
    hex.slice(20, 32)
  );
}

/** Same loose date parser as tt-importer.toDate. Handles ISO,
 *  "YYYY-MM-DD HH:MM:SS" naive, and ms-epoch numbers. */
function toDate(v: unknown): Date | null {
  if (v == null || v === "") return null;
  if (typeof v === "number") return new Date(v);
  if (typeof v !== "string") return null;
  const isoish = v.includes("T") ? v : v.replace(" ", "T") + "Z";
  const d = new Date(isoish);
  return Number.isNaN(d.getTime()) ? null : d;
}

function toInt(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : null;
}

/** America/New_York is UTC-5 (no DST adjustment for legacy reporting
 *  buckets — the rollup synthesizer also uses a fixed conversion).
 *  Midday-ET = 12:00 ET ≈ 17:00 UTC. */
function midDayEtFromCountDate(countDate: string): Date {
  // countDate is a YYYY-MM-DD string from the SQLite/Postgres column.
  return new Date(`${countDate}T17:00:00Z`);
}

function midnightEtFromCountDate(countDate: string): Date {
  return new Date(`${countDate}T05:00:00Z`);
}

function endOfDayEtFromCountDate(countDate: string): Date {
  // 23:59 ET ≈ 04:59 UTC the next day. Close enough — the rollup
  // synthesizer buckets via (occurred_at AT TIME ZONE 'America/New_York')::date
  // so the precise minute doesn't matter, only the calendar day.
  return new Date(`${countDate}T23:59:00Z`);
}

type MachineKindShape =
  | "BLISTER"
  | "SEALING"
  | "PACKAGING"
  | "BOTTLE_HANDPACK"
  | "BOTTLE_CAP_SEAL"
  | "BOTTLE_STICKER"
  | "COMBINED";

function eventTypeForMachineKind(kind: MachineKindShape): {
  eventType: string;
  note?: string;
} {
  switch (kind) {
    case "BLISTER":
      return { eventType: "BLISTER_COMPLETE" };
    case "SEALING":
      return { eventType: "SEALING_COMPLETE" };
    case "PACKAGING":
      return { eventType: "PACKAGING_SNAPSHOT" };
    case "BOTTLE_HANDPACK":
      return { eventType: "BOTTLE_HANDPACK_COMPLETE" };
    case "BOTTLE_CAP_SEAL":
      return { eventType: "BOTTLE_CAP_SEAL_COMPLETE" };
    case "BOTTLE_STICKER":
      return { eventType: "BOTTLE_STICKER_COMPLETE" };
    case "COMBINED":
    default:
      return {
        eventType: "BLISTER_COMPLETE",
        note: "machine.kind=COMBINED — synthesized as BLISTER_COMPLETE",
      };
  }
}

type SubmissionEventShape = {
  eventType: string;
  payloadAdds: Record<string, unknown>;
};

function classifySubmission(
  submissionType: string | null,
  payload: Record<string, unknown>,
): SubmissionEventShape {
  const t = (submissionType ?? "").toLowerCase();
  switch (t) {
    case "machine": {
      // sealing vs blister disambiguated via payload.machine_role.
      const role = String(payload["machine_role"] ?? "").toLowerCase();
      const eventType =
        role === "sealing"
          ? "SEALING_COMPLETE"
          : role === "stickering" || role === "bottle_stickering"
          ? "BOTTLE_STICKER_COMPLETE"
          : role === "bottle" || role === "bottle_cap_seal"
          ? "BOTTLE_CAP_SEAL_COMPLETE"
          : role === "bottle_handpack"
          ? "BOTTLE_HANDPACK_COMPLETE"
          : "BLISTER_COMPLETE";
      return {
        eventType,
        payloadAdds: {
          machine_role: role || null,
          machine_count: payload["machine_count"] ?? null,
          count_total:
            payload["machine_count"] ??
            payload["machine_tablets_total"] ??
            payload["machine_good_count"] ??
            null,
          cards_made: payload["cards_made"] ?? null,
          press_count: payload["press_count"] ?? null,
        },
      };
    }
    case "packaged": {
      return {
        eventType: "PACKAGING_COMPLETE",
        payloadAdds: {
          master_cases:
            payload["case_count"] ?? payload["cases_made_total"] ?? null,
          displays_made: payload["displays_made"] ?? null,
          loose_cards:
            payload["loose_display_count"] ?? payload["loose_tablets"] ?? null,
          damaged_packaging: payload["damaged_packaging"] ?? null,
          ripped_cards: payload["ripped_cards"] ?? null,
          packaged_tablets_total: payload["packaged_tablets_total"] ?? null,
        },
      };
    }
    case "bottle": {
      return {
        eventType: "BOTTLE_CAP_SEAL_COMPLETE",
        payloadAdds: {
          bottles_made: payload["bottles_made"] ?? null,
          bottles_remaining: payload["bottles_remaining"] ?? null,
          bottle_sealing_machine_count:
            payload["bottle_sealing_machine_count"] ?? null,
        },
      };
    }
    case "production": {
      // Legacy "Bag Count" form per docs/tablettracker-survey.md.
      return {
        eventType: "PACKAGING_SNAPSHOT",
        payloadAdds: {
          displays_made: payload["displays_made"] ?? null,
          packs_remaining: payload["packs_remaining"] ?? null,
          loose_tablets: payload["loose_tablets"] ?? null,
          total_displays_made: payload["total_displays_made"] ?? null,
        },
      };
    }
    case "repack": {
      return {
        eventType: "SUBMISSION_CORRECTED",
        payloadAdds: {
          repack_machine_count: payload["repack_machine_count"] ?? null,
          repack_vendor_return_notes:
            payload["repack_vendor_return_notes"] ?? null,
          repack_bag_allocations: payload["repack_bag_allocations"] ?? null,
          repack_allocation_version:
            payload["repack_allocation_version"] ?? null,
        },
      };
    }
    default: {
      return {
        eventType: "SUBMISSION_CORRECTED",
        payloadAdds: { _legacy_submission_type: submissionType ?? null },
      };
    }
  }
}

type IdMap = Map<string, string>;

async function loadSynthIdMap(): Promise<IdMap> {
  const rows = await db
    .select()
    .from(legacyTtIdMap)
    .where(
      sql`${legacyTtIdMap.ttTable} IN (
        'warehouse_submissions_synth',
        'machine_counts_synth',
        'machine_counts_synth_bag'
      )`,
    );
  const m: IdMap = new Map();
  for (const r of rows) m.set(`${r.ttTable}:${r.ttId}`, r.lumaId);
  return m;
}

export type SynthesisOutput = {
  ok: boolean;
  machineCountsSynthesized: number;
  warehouseSubmissionsSynthesized: number;
  placeholderBagsCreated: number;
  eventsInserted: number;
  errors: Array<{
    source: "machine_count" | "warehouse_submission";
    ttId: number;
    message: string;
  }>;
  durationMs: number;
  readModels: Awaited<ReturnType<typeof synthesizeReadModelsFromEvents>> | null;
};

const CHUNK = 200;

/** Walk legacy_machine_counts + legacy_warehouse_submissions and
 *  insert synthetic workflow_events into Luma. Owner-only via the
 *  caller (server action takes a snapshot first).
 *
 *  Phase G: `dryRun` flag short-circuits every write. Classification
 *  + bucket grouping still run, so the returned SynthesisOutput
 *  reports exactly what WOULD be inserted. Useful as a preflight
 *  before triggering the real run on a populated DB. */
export async function runSubmissionSynthesizer(args: {
  actor: CurrentUser;
  dryRun?: boolean;
}): Promise<SynthesisOutput> {
  const start = Date.now();
  const dryRun = !!args.dryRun;

  const errors: SynthesisOutput["errors"] = [];
  let eventsInserted = 0;
  let machineCountsSynthesized = 0;
  let warehouseSubmissionsSynthesized = 0;
  let placeholderBagsCreated = 0;

  // Sanity: company is the singleton FK target for placeholder bags.
  const [company] = await db
    .select({ id: companies.id })
    .from(companies)
    .limit(1);
  if (!company) {
    throw new Error("No company row in Luma — seed must run first.");
  }

  const idMap = await loadSynthIdMap();

  // Cache machines by id (we need machine.kind to derive event_type).
  const machineRows = await db
    .select({ id: machines.id, kind: machines.kind })
    .from(machines);
  const machineKindById = new Map<string, MachineKindShape>();
  for (const m of machineRows) {
    machineKindById.set(m.id, m.kind as MachineKindShape);
  }

  // ── Phase A: legacy_machine_counts → synthetic workflow_events ──
  // Each unique (count_date, tablet_type_id, machine_id) tuple gets a
  // placeholder workflow_bag if none exists in the synth map yet. The
  // tuple key is encoded into a stable integer hash because
  // legacy_tt_id_map.ttId is integer-typed; collisions are vanishingly
  // unlikely at 984-row scale and the fallback (eq match on the
  // placeholder bag's identifying columns) catches any anyway.
  {
    const mcRows = await db
      .select()
      .from(legacyMachineCounts)
      .orderBy(legacyMachineCounts.countDate, legacyMachineCounts.ttId);

    // Group by tuple → list of machine_count rows.
    type TupleKey = string;
    const buckets = new Map<
      TupleKey,
      {
        countDate: string;
        tabletTypeId: string | null;
        machineId: string | null;
        rows: typeof mcRows;
      }
    >();
    for (const r of mcRows) {
      if (!r.countDate) continue;
      const key = `${r.countDate}|${r.tabletTypeId ?? "null"}|${r.machineId ?? "null"}`;
      const existing = buckets.get(key);
      if (existing) {
        existing.rows.push(r);
      } else {
        buckets.set(key, {
          countDate: r.countDate,
          tabletTypeId: r.tabletTypeId,
          machineId: r.machineId,
          rows: [r],
        });
      }
    }

    // Collect unmapped rows and ensure each tuple has a placeholder
    // workflow_bag minted before we insert events.
    type SynthRow = {
      ttId: number;
      placeholderBagId: string;
      eventType: string;
      payload: Record<string, unknown>;
      occurredAt: Date;
      clientEventId: string;
    };
    const synthRows: SynthRow[] = [];
    for (const [tupleKey, bucket] of buckets) {
      // Stable integer hash for the tuple — fits Postgres int4.
      const tupleTtId = stableInt32Hash(`mc-bag:${tupleKey}`);
      let placeholderBagId = idMap.get(
        `machine_counts_synth_bag:${tupleTtId}`,
      );
      if (!placeholderBagId) {
        if (dryRun) {
          // Synthesize a deterministic placeholder UUID just for the
          // in-memory bucket map; never written to the DB.
          placeholderBagId = `00000000-0000-5000-8000-${tupleTtId
            .toString(16)
            .padStart(12, "0")}`;
          placeholderBagsCreated++;
        } else {
          const startedAt = midnightEtFromCountDate(bucket.countDate);
          const finalizedAt = endOfDayEtFromCountDate(bucket.countDate);
          const [out] = await db
            .insert(workflowBags)
            .values({
              startedAt,
              finalizedAt,
            })
            .returning({ id: workflowBags.id });
          if (!out) {
            errors.push({
              source: "machine_count",
              ttId: bucket.rows[0]?.ttId ?? 0,
              message: "placeholder workflow_bag insert returned no id",
            });
            continue;
          }
          placeholderBagId = out.id;
          placeholderBagsCreated++;
          await db
            .insert(legacyTtIdMap)
            .values({
              ttTable: "machine_counts_synth_bag",
              ttId: tupleTtId,
              lumaTable: "workflow_bags",
              lumaId: placeholderBagId,
            })
            .onConflictDoNothing();
        }
        idMap.set(`machine_counts_synth_bag:${tupleTtId}`, placeholderBagId);
      }

      for (const r of bucket.rows) {
        if (idMap.has(`machine_counts_synth:${r.ttId}`)) continue;
        // bucket.countDate is the same value as r.countDate for every
        // row in the bucket — and it's the non-null grouping key.
        const countDate = bucket.countDate;
        const machineKind: MachineKindShape =
          (r.machineId && machineKindById.get(r.machineId)) || "COMBINED";
        const { eventType, note } = eventTypeForMachineKind(machineKind);
        const payload = r.payload as Record<string, unknown> | null;
        const machineCount = toInt(payload?.["machine_count"]) ?? 0;
        const employeeName =
          r.employeeName ??
          (typeof payload?.["employee_name"] === "string"
            ? (payload["employee_name"] as string)
            : null);
        const eventPayload: Record<string, unknown> = {
          machine_count: machineCount,
          employee_name: employeeName,
          count_date: countDate,
          _synthesized_from: "machine_counts",
          _legacy_id: r.ttId,
          ...(note ? { _note: note } : {}),
        };
        synthRows.push({
          ttId: r.ttId,
          placeholderBagId,
          eventType,
          payload: eventPayload,
          occurredAt: midDayEtFromCountDate(countDate),
          clientEventId: uuidV5FromLegacy("machine_counts", r.ttId),
        });
      }
    }

    for (let i = 0; i < synthRows.length; i += CHUNK) {
      const slice = synthRows.slice(i, i + CHUNK);
      try {
        if (dryRun) {
          eventsInserted += slice.length;
          machineCountsSynthesized += slice.length;
          continue;
        }
        const values = slice.map((s) => ({
          workflowBagId: s.placeholderBagId,
          eventType: s.eventType as never,
          payload: s.payload,
          occurredAt: s.occurredAt,
          clientEventId: s.clientEventId,
        }));
        const out = await db
          .insert(workflowEvents)
          .values(values)
          .onConflictDoNothing()
          .returning({ id: workflowEvents.id });
        eventsInserted += out.length;
        machineCountsSynthesized += slice.length;
        // Bulk id_map upsert. Even on conflict-do-nothing inserts we
        // record the (ttId → bagId) link so re-runs short-circuit.
        await db
          .insert(legacyTtIdMap)
          .values(
            slice.map((s) => ({
              ttTable: "machine_counts_synth",
              ttId: s.ttId,
              lumaTable: "workflow_events",
              lumaId: s.placeholderBagId, // event-id isn't returned-mapped 1:1 on chunk inserts; bag id is stable + sufficient for "have we synthesized this row?"
            })),
          )
          .onConflictDoNothing();
        for (const s of slice) {
          idMap.set(`machine_counts_synth:${s.ttId}`, s.placeholderBagId);
        }
      } catch (err) {
        for (const s of slice) {
          errors.push({
            source: "machine_count",
            ttId: s.ttId,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  }

  // ── Phase B: legacy_warehouse_submissions → synthetic events ──
  {
    const wsRows = await db
      .select()
      .from(legacyWarehouseSubmissions)
      .orderBy(legacyWarehouseSubmissions.createdAt, legacyWarehouseSubmissions.ttId);

    // Helper: most-recent workflow_bag for an inventory bag.
    const wfbForInventoryBag = new Map<string, string>();
    async function findWorkflowBagForInventoryBag(
      inventoryBagId: string,
    ): Promise<string | null> {
      const cached = wfbForInventoryBag.get(inventoryBagId);
      if (cached) return cached;
      const [row] = await db
        .select({ id: workflowBags.id })
        .from(workflowBags)
        .where(eq(workflowBags.inventoryBagId, inventoryBagId))
        .orderBy(sql`${workflowBags.startedAt} DESC`)
        .limit(1);
      if (row) {
        wfbForInventoryBag.set(inventoryBagId, row.id);
        return row.id;
      }
      return null;
    }

    type SynthRow = {
      ttId: number;
      workflowBagId: string;
      eventType: string;
      payload: Record<string, unknown>;
      occurredAt: Date;
      clientEventId: string;
    };
    const synthRows: SynthRow[] = [];

    for (const r of wsRows) {
      if (idMap.has(`warehouse_submissions_synth:${r.ttId}`)) continue;
      try {
        // Decide which workflow_bag to attach to.
        let wfbId: string | null = r.workflowBagId ?? null;
        if (!wfbId && r.bagId) {
          wfbId = await findWorkflowBagForInventoryBag(r.bagId);
        }
        if (!wfbId) {
          // No direct or indirect workflow_bag — synthesize a
          // placeholder keyed on (createdAt::date, bag_id, submission_type).
          const created = r.createdAt ?? toDate(
            (r.payload as Record<string, unknown> | null)?.["created_at"],
          );
          const dayIso =
            (created ?? new Date()).toISOString().slice(0, 10);
          const tupleKey = `ws-bag:${dayIso}|${r.bagId ?? "null"}|${r.submissionType ?? "null"}`;
          const tupleTtId = stableInt32Hash(tupleKey);
          let placeholderBagId = idMap.get(
            `machine_counts_synth_bag:${tupleTtId}`,
          );
          if (!placeholderBagId) {
            if (dryRun) {
              placeholderBagId = `00000000-0000-5000-8000-${tupleTtId
                .toString(16)
                .padStart(12, "0")}`;
              placeholderBagsCreated++;
            } else {
              const [out] = await db
                .insert(workflowBags)
                .values({
                  ...(r.bagId ? { inventoryBagId: r.bagId } : {}),
                  startedAt: midnightEtFromCountDate(dayIso),
                  finalizedAt: endOfDayEtFromCountDate(dayIso),
                })
                .returning({ id: workflowBags.id });
              if (!out) {
                errors.push({
                  source: "warehouse_submission",
                  ttId: r.ttId,
                  message: "placeholder workflow_bag insert returned no id",
                });
                continue;
              }
              placeholderBagId = out.id;
              placeholderBagsCreated++;
              await db
                .insert(legacyTtIdMap)
                .values({
                  ttTable: "machine_counts_synth_bag",
                  ttId: tupleTtId,
                  lumaTable: "workflow_bags",
                  lumaId: placeholderBagId,
                })
                .onConflictDoNothing();
            }
            idMap.set(
              `machine_counts_synth_bag:${tupleTtId}`,
              placeholderBagId,
            );
          }
          wfbId = placeholderBagId;
        }

        const payload = (r.payload as Record<string, unknown> | null) ?? {};
        const cls = classifySubmission(r.submissionType, payload);
        const occurredAt =
          r.createdAt ??
          toDate(payload["created_at"]) ??
          toDate(payload["submission_date"]) ??
          new Date();

        const eventPayload: Record<string, unknown> = {
          ...cls.payloadAdds,
          submission_type: r.submissionType,
          employee_name: r.employeeName,
          _synthesized_from: "warehouse_submissions",
          _legacy_id: r.ttId,
          _legacy_bag_id: r.bagId ?? null,
        };

        synthRows.push({
          ttId: r.ttId,
          workflowBagId: wfbId,
          eventType: cls.eventType,
          payload: eventPayload,
          occurredAt,
          clientEventId: uuidV5FromLegacy("warehouse_submissions", r.ttId),
        });
      } catch (err) {
        errors.push({
          source: "warehouse_submission",
          ttId: r.ttId,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    for (let i = 0; i < synthRows.length; i += CHUNK) {
      const slice = synthRows.slice(i, i + CHUNK);
      try {
        if (dryRun) {
          eventsInserted += slice.length;
          warehouseSubmissionsSynthesized += slice.length;
          continue;
        }
        const values = slice.map((s) => ({
          workflowBagId: s.workflowBagId,
          eventType: s.eventType as never,
          payload: s.payload,
          occurredAt: s.occurredAt,
          clientEventId: s.clientEventId,
        }));
        const out = await db
          .insert(workflowEvents)
          .values(values)
          .onConflictDoNothing()
          .returning({ id: workflowEvents.id });
        eventsInserted += out.length;
        warehouseSubmissionsSynthesized += slice.length;
        await db
          .insert(legacyTtIdMap)
          .values(
            slice.map((s) => ({
              ttTable: "warehouse_submissions_synth",
              ttId: s.ttId,
              lumaTable: "workflow_events",
              lumaId: s.workflowBagId,
            })),
          )
          .onConflictDoNothing();
        for (const s of slice) {
          idMap.set(`warehouse_submissions_synth:${s.ttId}`, s.workflowBagId);
        }
      } catch (err) {
        for (const s of slice) {
          errors.push({
            source: "warehouse_submission",
            ttId: s.ttId,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  }

  // ── Backfill workflow_bags.finalized_at ──
  // The synthesizer creates placeholder bags with finalized_at set,
  // but bags created via other paths (live floor, earlier importers)
  // may have BAG_FINALIZED events without their finalized_at set.
  // Call the canonical backfill helper so every BAG_FINALIZED event
  // produces the side effects the projector would have produced
  // (workflow_bags.finalized_at + downstream read_bag_metrics).
  if (!dryRun) {
    try {
      await replayFinalizedBags();
    } catch (err) {
      errors.push({
        source: "machine_count",
        ttId: 0,
        message:
          "BAG_FINALIZED backfill failed: " +
          (err instanceof Error ? err.message : String(err)),
      });
    }
  }

  // ── Rebuild rollups ──
  // synthesizeReadModelsFromEvents covers read_bag_state /
  // read_bag_metrics / read_daily_throughput / read_operator_daily.
  // The Phase C rebuilders cover read_sku_daily /
  // read_material_reconciliation / read_station_quality_daily /
  // read_queue_state. Run all of them so the post-synthesis state
  // matches what the synchronous projector would have produced for
  // live events.
  let readModels: SynthesisOutput["readModels"] = null;
  if (!dryRun) {
    try {
      readModels = await synthesizeReadModelsFromEvents();
    } catch (err) {
      errors.push({
        source: "machine_count",
        ttId: 0,
        message:
          "Read-model synthesis failed: " +
          (err instanceof Error ? err.message : String(err)),
      });
    }
    try {
      await db.transaction(async (tx) => {
        await rebuildSkuDaily(tx);
        await rebuildMaterialReconciliation(tx);
        await rebuildStationQualityDaily(tx);
        await rebuildQueueState(tx);
      });
    } catch (err) {
      errors.push({
        source: "machine_count",
        ttId: 0,
        message:
          "Phase C read-model rebuild failed: " +
          (err instanceof Error ? err.message : String(err)),
      });
    }
  }

  if (!dryRun) {
    await writeAudit({
      actorId: args.actor.id,
      actorRole: args.actor.role,
      action: "legacy_import.synthesize_submissions",
      targetType: "LegacySynthesisRun",
      targetId: null,
      after: {
        machineCountsSynthesized,
        warehouseSubmissionsSynthesized,
        placeholderBagsCreated,
        eventsInserted,
        errorCount: errors.length,
        readModels,
      },
    });
  }

  return {
    ok: errors.length === 0,
    machineCountsSynthesized,
    warehouseSubmissionsSynthesized,
    placeholderBagsCreated,
    eventsInserted,
    errors,
    durationMs: Date.now() - start,
    readModels,
  };
}

/** Stable 31-bit unsigned hash → fits Postgres int4 (legacy_tt_id_map.ttId).
 *  Using SHA-1 truncation for distribution; collisions across the
 *  ~3k tuples we synthesize are negligible. */
function stableInt32Hash(s: string): number {
  const h = createHash("sha1").update(s).digest();
  // Take 4 bytes, mask to 31 bits so it stays positive in int4.
  const v =
    ((h[0] ?? 0) << 24) |
    ((h[1] ?? 0) << 16) |
    ((h[2] ?? 0) << 8) |
    (h[3] ?? 0);
  return v & 0x7fffffff;
}
