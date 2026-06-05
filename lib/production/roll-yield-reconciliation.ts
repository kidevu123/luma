/**
 * Roll yield reconciliation — blister cycles × cards/turn vs packaging
 * vs manufacturer spec. Read-only derivations; never mutates events.
 */

import { sql, eq, and, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { blisterMaterialStandards } from "@/lib/db/schema";
import {
  MANUFACTURER_YIELD_DEFAULTS,
  type MaterialRole,
  cardsFromMachineCycles,
  manufacturerExpectedCycles,
  materialWasteGramsVsManufacturer,
  remainingCyclesAtRate,
  remainingKgFromCycles,
  yieldPct,
} from "./blister-cycle-math";

export type RollReconciliationRow = {
  packagingLotId: string;
  rollNumber: string | null;
  materialRole: MaterialRole;
  status: string;
  machineName: string | null;
  netWeightGrams: number | null;
  netKg: number | null;
  actualUsedGrams: number | null;
  cardsPerTurn: number;
  /** Raw counter sum — machine cycles as entered on floor. */
  machineCycles: number;
  /** Cycles × cardsPerTurn — finished cards blister room claims. */
  blisterRoomCards: number;
  /** Prorated packaging room finished cards (cases + displays + loose). */
  packagingCards: number | null;
  /** blisterRoomCards − packagingCards when both known. */
  processWasteCards: number | null;
  manufacturerBlistersPerKg: number;
  manufacturerExpectedCycles: number | null;
  manufacturerExpectedCards: number | null;
  cycleYieldVsManufacturerPct: number | null;
  materialWasteGramsVsManufacturer: number | null;
  gramsPerCycleActual: number | null;
  gramsPerCycleManufacturer: number | null;
  isMounted: boolean;
  remainingCyclesVsManufacturer: number | null;
  remainingCardsVsManufacturer: number | null;
  remainingKgVsManufacturer: number | null;
  bagCount: number;
  finalizedBagCount: number;
};

export type ActiveRollRunwayRow = {
  rollNumber: string | null;
  materialRole: MaterialRole;
  machineName: string | null;
  netKg: number | null;
  machineCyclesUsed: number;
  cardsPerTurn: number;
  cardsProducedSoFar: number;
  packagingCardsSoFar: number | null;
  remainingCyclesVsManufacturer: number | null;
  remainingCardsVsManufacturer: number | null;
  remainingKgVsManufacturer: number | null;
};

type MfrRates = Record<MaterialRole, number>;

async function loadManufacturerRates(): Promise<MfrRates> {
  const configured = await db
    .select({
      role: blisterMaterialStandards.materialRole,
      blistersPerKg: blisterMaterialStandards.expectedBlistersPerKg,
      gramsPerBlister: blisterMaterialStandards.expectedGramsPerBlister,
    })
    .from(blisterMaterialStandards)
    .where(
      and(
        eq(blisterMaterialStandards.isActive, true),
        isNull(blisterMaterialStandards.productId),
      ),
    );

  const rates: MfrRates = {
    PVC: MANUFACTURER_YIELD_DEFAULTS.PVC.blistersPerKg,
    FOIL: MANUFACTURER_YIELD_DEFAULTS.FOIL.blistersPerKg,
  };

  for (const row of configured) {
    if (row.role !== "PVC" && row.role !== "FOIL") continue;
    if (row.blistersPerKg != null && Number(row.blistersPerKg) > 0) {
      rates[row.role] = Number(row.blistersPerKg);
    } else if (row.gramsPerBlister != null && Number(row.gramsPerBlister) > 0) {
      rates[row.role] = Math.round(1000 / Number(row.gramsPerBlister));
    }
  }

  return rates;
}

type DbRollRow = {
  packaging_lot_id: string;
  roll_number: string | null;
  material_role: string;
  lot_status: string;
  machine_name: string | null;
  starting_weight_grams: number | null;
  actual_used_grams: number | null;
  cards_per_turn: number | null;
  machine_cycles: number | null;
  packaging_cards: number | null;
  bag_count: number | null;
  finalized_bag_count: number | null;
  unmounted_at: string | null;
  mounted_at: string | null;
};

async function queryRollRows(): Promise<DbRollRow[]> {
  const rows = await db.execute(sql`
    WITH segment_rows AS (
      SELECT
        ev.packaging_lot_id,
        ev.workflow_bag_id,
        (ev.payload->>'counter_segment_count')::int AS seg
      FROM material_inventory_events ev
      WHERE ev.event_type = 'ROLL_COUNTER_SEGMENT_RECORDED'
        AND COALESCE(ev.payload->>'roll_role', 'PVC') IN ('PVC', 'FOIL')
        AND (ev.payload->>'counter_segment_count') ~ '^[0-9]+$'
    ),
    roll_cycles AS (
      SELECT
        packaging_lot_id,
        COALESCE(SUM(seg), 0)::bigint AS machine_cycles,
        COUNT(DISTINCT workflow_bag_id) FILTER (WHERE workflow_bag_id IS NOT NULL)::int AS bag_count
      FROM segment_rows
      GROUP BY packaging_lot_id
    ),
    bag_roll_segments AS (
      SELECT packaging_lot_id, workflow_bag_id, SUM(seg)::int AS roll_bag_cycles
      FROM segment_rows
      WHERE workflow_bag_id IS NOT NULL
      GROUP BY packaging_lot_id, workflow_bag_id
    ),
    bag_total_segments AS (
      SELECT workflow_bag_id, SUM(seg)::int AS total_bag_cycles
      FROM segment_rows
      WHERE workflow_bag_id IS NOT NULL
      GROUP BY workflow_bag_id
    ),
    packaging_on_roll AS (
      SELECT
        brs.packaging_lot_id,
        SUM(
          CASE
            WHEN bm.units_yielded IS NOT NULL AND bts.total_bag_cycles > 0
              THEN ROUND(
                bm.units_yielded::numeric * brs.roll_bag_cycles::numeric / bts.total_bag_cycles
              )::int
            ELSE 0
          END
        )::int AS packaging_cards,
        COUNT(*) FILTER (WHERE bm.workflow_bag_id IS NOT NULL)::int AS finalized_bag_count
      FROM bag_roll_segments brs
      JOIN bag_total_segments bts ON bts.workflow_bag_id = brs.workflow_bag_id
      LEFT JOIN read_bag_metrics bm ON bm.workflow_bag_id = brs.workflow_bag_id
      GROUP BY brs.packaging_lot_id
    )
    SELECT
      rru.packaging_lot_id::text AS packaging_lot_id,
      rru.roll_number,
      rru.material_role::text AS material_role,
      pl.status::text AS lot_status,
      m.name AS machine_name,
      rru.starting_weight_grams,
      rru.actual_used_grams,
      COALESCE(NULLIF(m.cards_per_turn, 0), 1)::int AS cards_per_turn,
      COALESCE(rc.machine_cycles, 0)::bigint AS machine_cycles,
      po.packaging_cards,
      COALESCE(rc.bag_count, 0)::int AS bag_count,
      COALESCE(po.finalized_bag_count, 0)::int AS finalized_bag_count,
      rru.unmounted_at::text AS unmounted_at,
      rru.mounted_at::text AS mounted_at
    FROM read_roll_usage rru
    JOIN packaging_lots pl ON pl.id = rru.packaging_lot_id
    LEFT JOIN machines m ON m.id = rru.machine_id
    LEFT JOIN roll_cycles rc ON rc.packaging_lot_id = rru.packaging_lot_id
    LEFT JOIN packaging_on_roll po ON po.packaging_lot_id = rru.packaging_lot_id
    WHERE rru.material_role IN ('PVC', 'FOIL')
      AND (
        COALESCE(rc.machine_cycles, 0) > 0
        OR (rru.mounted_at IS NOT NULL AND rru.unmounted_at IS NULL)
      )
    ORDER BY
      CASE
        WHEN rru.roll_number ~ '^PVC-[0-9]+$'
          THEN NULLIF(regexp_replace(rru.roll_number, '[^0-9]', '', 'g'), '')::int
        WHEN rru.roll_number ~ '^FOIL-[0-9]+$'
          THEN NULLIF(regexp_replace(rru.roll_number, '[^0-9]', '', 'g'), '')::int
        ELSE 99999
      END,
      rru.roll_number
  `);

  return rows as unknown as DbRollRow[];
}

function mapRow(r: DbRollRow, mfrRates: MfrRates): RollReconciliationRow {
  const role = r.material_role as MaterialRole;
  const cardsPerTurn = r.cards_per_turn != null && r.cards_per_turn > 0 ? r.cards_per_turn : 1;
  const machineCycles = Number(r.machine_cycles ?? 0);
  const blisterRoomCards = cardsFromMachineCycles(machineCycles, cardsPerTurn) ?? 0;
  const netG = r.starting_weight_grams;
  const mfrRate = mfrRates[role];
  const mfrExpected = manufacturerExpectedCycles(netG, mfrRate);
  const mfrExpectedCards =
    mfrExpected != null ? cardsFromMachineCycles(mfrExpected, cardsPerTurn) : null;
  const usedG =
    r.actual_used_grams ??
    (r.lot_status === "DEPLETED" && netG != null ? netG : null);
  const packagingCards =
    r.packaging_cards != null && (r.finalized_bag_count ?? 0) > 0
      ? r.packaging_cards
      : null;
  const processWaste =
    packagingCards != null ? blisterRoomCards - packagingCards : null;
  const isMounted = r.mounted_at != null && r.unmounted_at == null;
  const remainingCycles =
    isMounted && netG != null
      ? remainingCyclesAtRate(netG, machineCycles, mfrRate)
      : null;

  return {
    packagingLotId: r.packaging_lot_id,
    rollNumber: r.roll_number,
    materialRole: role,
    status: r.lot_status,
    machineName: r.machine_name,
    netWeightGrams: netG,
    netKg: netG != null ? Math.round((netG / 1000) * 100) / 100 : null,
    actualUsedGrams: usedG,
    cardsPerTurn,
    machineCycles,
    blisterRoomCards,
    packagingCards,
    processWasteCards: processWaste,
    manufacturerBlistersPerKg: mfrRate,
    manufacturerExpectedCycles: mfrExpected,
    manufacturerExpectedCards: mfrExpectedCards,
    cycleYieldVsManufacturerPct: yieldPct(machineCycles, mfrExpected),
    materialWasteGramsVsManufacturer: materialWasteGramsVsManufacturer(
      usedG,
      machineCycles,
      mfrRate,
    ),
    gramsPerCycleActual:
      usedG != null && machineCycles > 0 ? Math.round((usedG / machineCycles) * 10000) / 10000 : null,
    gramsPerCycleManufacturer: Math.round((1000 / mfrRate) * 10000) / 10000,
    isMounted,
    remainingCyclesVsManufacturer: remainingCycles,
    remainingCardsVsManufacturer:
      remainingCycles != null
        ? cardsFromMachineCycles(remainingCycles, cardsPerTurn)
        : null,
    remainingKgVsManufacturer: remainingKgFromCycles(remainingCycles, mfrRate),
    bagCount: r.bag_count ?? 0,
    finalizedBagCount: r.finalized_bag_count ?? 0,
  };
}

export async function getRollYieldReconciliation(): Promise<{
  rows: RollReconciliationRow[];
  activeRunway: ActiveRollRunwayRow[];
  cardsPerTurnDefault: number;
  manufacturerDefaults: typeof MANUFACTURER_YIELD_DEFAULTS;
}> {
  const mfrRates = await loadManufacturerRates();
  const dbRows = await queryRollRows();
  const rows = dbRows.map((r) => mapRow(r, mfrRates));

  const activeRunway: ActiveRollRunwayRow[] = rows
    .filter((r) => r.isMounted)
    .map((r) => ({
      rollNumber: r.rollNumber,
      materialRole: r.materialRole,
      machineName: r.machineName,
      netKg: r.netKg,
      machineCyclesUsed: r.machineCycles,
      cardsPerTurn: r.cardsPerTurn,
      cardsProducedSoFar: r.blisterRoomCards,
      packagingCardsSoFar: r.packagingCards,
      remainingCyclesVsManufacturer: r.remainingCyclesVsManufacturer,
      remainingCardsVsManufacturer: r.remainingCardsVsManufacturer,
      remainingKgVsManufacturer: r.remainingKgVsManufacturer,
    }));

  const blisterMachine = rows.find((r) => r.isMounted && r.materialRole === "PVC");
  const cardsPerTurnDefault = blisterMachine?.cardsPerTurn ?? 2;

  return {
    rows,
    activeRunway,
    cardsPerTurnDefault,
    manufacturerDefaults: MANUFACTURER_YIELD_DEFAULTS,
  };
}
