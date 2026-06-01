/**
 * P0 live-ops — Bag Card 45 blister backfill DRY-RUN ONLY.
 *
 * Reads staging/prod DB and prints a proposed append-only recovery plan.
 * Does NOT write by default. Apply path is intentionally unimplemented until
 * Sahil approves a phased plan (Bag 45 backfill may imply Bag 24 correction).
 *
 * Usage:
 *   tsx scripts/dry-run-bag45-blister-backfill.ts
 *   tsx scripts/dry-run-bag45-blister-backfill.ts --old-pvc-lot-id <uuid>
 *
 * Flags:
 *   --old-pvc-lot-id <uuid>  Required to show step-6 roll-change proposal when
 *                            Sahil's memory is unknown but machine state is provable.
 *   --json                   Machine-readable summary on stdout.
 */

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";

const SCAN_TOKEN_45 = "bag-card-45";
const BAG_24_ID = "008870c4-6f43-4862-862f-51f7b7ba6853";
const STATION_BLISTER_ID = "12492e4b-dac7-46fb-b860-b7ea483fbd9e";
const MACHINE_BLISTER_ID = "c65ea16e-7e15-4749-888b-a7b058cfdf53";

const LOT = {
  PVC_1: "ecacd4a2-cbe5-406b-8b5e-a33b1e2a2f0e",
  PVC_2: "d083d7c2-c138-48fa-a356-150ecb594370",
  LEGACY_PVC_02: "2869ae2a-3b31-4e00-a684-dcc611c82d09",
  LEGACY_FOIL_01: "0ecd1290-b54d-438d-961b-e794db03fa67",
} as const;

const SEGMENTS_45 = { shiftEnd: 187, machineJam: 18, pvcChange: 516 } as const;
const BAG_24_ROLL_CHANGE_SEG = 645;

function parseOldPvcLotId(): string | null {
  const idx = process.argv.indexOf("--old-pvc-lot-id");
  if (idx === -1) return null;
  return process.argv[idx + 1] ?? null;
}

async function main() {
  const oldPvcLotIdArg = parseOldPvcLotId();
  const jsonOut = process.argv.includes("--json");

  type CardRow = {
    id: string;
    label: string;
    scan_token: string;
    status: string;
    assigned_workflow_bag_id: string | null;
  };
  const [card45] = (await db.execute<CardRow>(sql`
    SELECT id::text, label, scan_token, status,
           assigned_workflow_bag_id::text
    FROM qr_cards WHERE scan_token = ${SCAN_TOKEN_45}
  `)) as unknown as CardRow[];

  type InvRow = { id: string; bag_number: number; bag_qr_code: string };
  const [inv45] = (await db.execute<InvRow>(sql`
    SELECT id::text, bag_number, bag_qr_code
    FROM inventory_bags WHERE bag_qr_code = ${SCAN_TOKEN_45}
  `)) as unknown as InvRow[];

  type LotRow = { id: string; roll_number: string; status: string };
  const lots = (await db.execute<LotRow>(sql`
    SELECT id::text, roll_number, status::text
    FROM packaging_lots
    WHERE id IN (
      ${LOT.PVC_1}::uuid, ${LOT.PVC_2}::uuid,
      ${LOT.LEGACY_PVC_02}::uuid, ${LOT.LEGACY_FOIL_01}::uuid
    )
    ORDER BY roll_number
  `)) as unknown as LotRow[];

  type Bag24MatRow = {
    id: string;
    event_type: string;
    occurred_at: string;
    roll_number: string;
    counter_segment_count: number | null;
    segment_reason: string | null;
    segment_group_id: string | null;
  };
  const bag24Mat = (await db.execute<Bag24MatRow>(sql`
    SELECT mie.id::text, mie.event_type,
           mie.occurred_at::text,
           pl.roll_number,
           (mie.payload->>'counter_segment_count')::int AS counter_segment_count,
           mie.payload->>'segment_reason' AS segment_reason,
           mie.payload->>'segment_group_id' AS segment_group_id
    FROM material_inventory_events mie
    JOIN packaging_lots pl ON pl.id = mie.packaging_lot_id
    WHERE mie.payload->>'workflow_bag_id' = ${BAG_24_ID}
    ORDER BY mie.occurred_at, mie.id
  `)) as unknown as Bag24MatRow[];

  type MountRow = { roll_number: string; status: string; event_type: string };
  const activeNow = (await db.execute<MountRow>(sql`
    WITH latest_event AS (
      SELECT DISTINCT ON (ev.packaging_lot_id)
        ev.packaging_lot_id, ev.event_type, ev.machine_id
      FROM material_inventory_events ev
      WHERE ev.event_type IN ('ROLL_MOUNTED','ROLL_UNMOUNTED','ROLL_DEPLETED')
      ORDER BY ev.packaging_lot_id, ev.occurred_at DESC, ev.id DESC
    )
    SELECT pl.roll_number, pl.status::text, le.event_type
    FROM packaging_lots pl
    JOIN latest_event le ON le.packaging_lot_id = pl.id
    WHERE le.event_type = 'ROLL_MOUNTED'
      AND le.machine_id = ${MACHINE_BLISTER_ID}::uuid
  `)) as unknown as MountRow[];

  const bag45Exists = card45?.assigned_workflow_bag_id != null;
  const bag24Has645 = bag24Mat.some(
    (r) =>
      r.counter_segment_count === BAG_24_ROLL_CHANGE_SEG &&
      r.segment_reason === "ROLL_CHANGE",
  );

  const proposedBag45Total =
    SEGMENTS_45.shiftEnd + SEGMENTS_45.machineJam + SEGMENTS_45.pvcChange;

  const warnings: string[] = [
    "DO NOT mutate Bag 24 (workflow_bag " + BAG_24_ID + ").",
    "DO NOT duplicate Bag 24 roll-change segment " + BAG_24_ROLL_CHANGE_SEG + ".",
    "PVC-1 lot has never been ROLL_MOUNTED in DB — Bag 45 backfill is the intended first mount.",
    "Bag 24 audit shows old_lot Legacy PVC-02 → new PVC-2; physical story is PVC-1 → PVC-2 — separate correction likely required after Bag 45.",
    "Global ROLL_DEPLETED/ROLL_MOUNTED at Bag 45 T516 conflicts with existing Legacy PVC-02 segments on other bags unless full timeline replay + Bag 24 fix.",
    "card 45 is intake-reserved (ASSIGNED, no workflow_bag_id) — must CREATE workflow_bag on apply.",
  ];

  if (!oldPvcLotIdArg) {
    warnings.push(
      "Step 6 (PVC change @ 516) blocked in proposal: pass --old-pvc-lot-id <uuid>. DB machine-state proof before Card 24: Legacy PVC-02 (" +
        LOT.LEGACY_PVC_02 +
        ").",
    );
  } else if (oldPvcLotIdArg !== LOT.LEGACY_PVC_02) {
    warnings.push(
      "Non-default old PVC lot id supplied — verify against machine mount history before apply.",
    );
  }

  const proposal = {
    target: { scanToken: SCAN_TOKEN_45, qrCardId: card45?.id ?? null },
    workflowBag: {
      action: bag45Exists ? "use_existing" : "create_new",
      existingId: card45?.assigned_workflow_bag_id ?? null,
      inventoryBagId: inv45?.id ?? null,
    },
    proposedOccurredAtOrder: [
      "T0 < 2026-06-01 15:13:44 ET (before Card 24 CARD_ASSIGNED)",
      "T1 shift_end pause + segments 187",
      "T2 BAG_RESUMED",
      "T3 machine_jam pause + segments 18",
      "T4 BAG_RESUMED",
      "T5 ROLL_CHANGE segments 516 (FOIL + old PVC) → mount PVC-1",
      "Optional T6 BAG_RELEASED / BLISTER_COMPLETE only if Sahil confirms bag ended",
    ],
    proposedWorkflowEvents: [
      "CARD_ASSIGNED (if new bag)",
      "BAG_PAUSED reason=shift_end counter_snapshot_count=187",
      "BAG_RESUMED",
      "BAG_PAUSED reason=machine_jam counter_snapshot_count=18",
      "BAG_RESUMED",
      "BAG_PAUSED reason=pvc_swap (optional UI parity) OR roll-change only",
    ],
    proposedMaterialEvents: [
      "ROLL_COUNTER_SEGMENT_RECORDED x2 seg=187 reason=SHIFT_END_SNAPSHOT (PVC+FOIL)",
      "ROLL_COUNTER_SEGMENT_RECORDED x2 seg=18 reason=PAUSE_SNAPSHOT",
      oldPvcLotIdArg
        ? "ROLL_COUNTER_SEGMENT_RECORDED x2 seg=516 reason=ROLL_CHANGE on old PVC + FOIL"
        : "(blocked) roll change @ 516",
      oldPvcLotIdArg
        ? "ROLL_DEPLETED old PVC; ROLL_MOUNTED PVC-1 — PVC-1 must NOT receive seg 516"
        : null,
    ].filter(Boolean),
    proposedAudit: [
      "live_ops_backfill.bag45_dry_run",
      "ROLL_CHANGED_MID_BAG on old PVC lot if roll change applied",
    ],
    bag45SegmentSumAfter: proposedBag45Total,
    bag24Preserved: { workflowBagId: BAG_24_ID, has645Block: bag24Has645 },
    rollLots: lots,
    activeMachineRollsNow: activeNow,
    readModelRebuildOnApply: [
      "rebuildRollUsage",
      "rebuildMaterialLotState",
      "projector read_bag_state / read_station_live (via workflow_events)",
    ],
    warnings,
  };

  if (jsonOut) {
    console.log(JSON.stringify(proposal, null, 2));
    return;
  }

  console.log("=== BAG CARD 45 BACKFILL — DRY-RUN ONLY (no writes) ===\n");
  console.log("Card 45:", card45 ?? "NOT FOUND");
  console.log("Inventory:", inv45 ?? "NOT FOUND");
  console.log("\nRoll lots:");
  for (const l of lots) console.log(`  ${l.roll_number}  ${l.id}  ${l.status}`);
  console.log("\nBag 24 material events (preserve):");
  for (const r of bag24Mat) {
    console.log(
      `  ${r.occurred_at}  ${r.event_type}  ${r.roll_number}  seg=${r.counter_segment_count ?? "-"}  ${r.segment_reason ?? ""}`,
    );
  }
  console.log("\nActive machine rolls NOW:", activeNow);
  console.log("\n--- Proposed Bag 45 logical sequence ---");
  for (const line of proposal.proposedOccurredAtOrder) console.log(" ", line);
  console.log("\n--- Proposed workflow_events ---");
  for (const e of proposal.proposedWorkflowEvents) console.log(" ", e);
  console.log("\n--- Proposed material_inventory_events ---");
  for (const e of proposal.proposedMaterialEvents) console.log(" ", e);
  console.log("\n--- Before / after (Bag 45 bag-scoped segment sum) ---");
  console.log("  before: 0");
  console.log("  after: ", proposedBag45Total, "(187+18+516; excludes Bag 24 645)");
  console.log("\n--- Warnings ---");
  for (const w of warnings) console.log("  !", w);
  if (!oldPvcLotIdArg) {
    console.log(
      "\n*** DRY RUN BLOCKED — needs --old-pvc-lot-id for PVC change @ 516 ***",
    );
    console.log(
      "  DB machine-state hint:",
      LOT.LEGACY_PVC_02,
      "(Legacy PVC-02)",
    );
  } else {
    console.log("\n*** DRY RUN PLAN B COMPLETE — apply path NOT implemented ***");
  }
  console.log("Apply is NOT implemented in this script.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
