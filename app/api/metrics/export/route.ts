// Metrics CSV export. Streams server-side-rendered CSV so an
// admin can hand a vendor numbers in seconds. Same query layer
// the /metrics pages use, so the CSV is the same source of truth.
//
// Query params:
//   set     = bags | products | machines | operators | downtime | daily | materials
//   days    = window (default 30)
//   lane    = all | blister | card | bottle | packaging (default all)

import { NextResponse } from "next/server";
import { sql, gte, eq } from "drizzle-orm";
import { requireSession } from "@/lib/auth-guards";
import { db } from "@/lib/db";
import {
  readBagMetrics,
  readDailyThroughput,
  readOperatorDaily,
  readMaterialBurn,
  packagingMaterials,
  products,
  machines,
} from "@/lib/db/schema";
import { loadMetrics, type Lane } from "@/lib/metrics/loader";

function csvEscape(v: unknown): string {
  if (v == null) return "";
  const s = String(v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function rowsToCsv(headers: string[], rows: Array<Record<string, unknown>>): string {
  const lines = [headers.join(",")];
  for (const r of rows) {
    lines.push(headers.map((h) => csvEscape(r[h])).join(","));
  }
  return lines.join("\n");
}

export async function GET(req: Request): Promise<Response> {
  await requireSession();
  const url = new URL(req.url);
  const set = url.searchParams.get("set") ?? "bags";
  const days = Math.max(1, Math.min(365, Number(url.searchParams.get("days") ?? "30")));
  const lane = (url.searchParams.get("lane") as Lane) ?? "all";

  const since = new Date();
  since.setUTCDate(since.getUTCDate() - days);
  const sinceStr = since.toISOString().slice(0, 10);

  let csv = "";
  let filename = `${set}-${days}d.csv`;

  if (set === "bags") {
    const m = await loadMetrics(lane, days);
    const productById = new Map(
      (await db.select().from(products)).map((p) => [p.id, p]),
    );
    const headers = [
      "workflow_bag_id",
      "started_at",
      "finalized_at",
      "product",
      "sku",
      "total_seconds",
      "active_seconds",
      "paused_seconds",
      "blister_seconds",
      "sealing_seconds",
      "packaging_seconds",
      "bottle_handpack_seconds",
      "bottle_cap_seal_seconds",
      "bottle_sticker_seconds",
      "master_cases",
      "displays_made",
      "loose_cards",
      "damaged_packaging",
      "ripped_cards",
      "input_pill_count",
      "units_yielded",
      "yield_pct",
      "operator_codes",
    ];
    const rows = m.bags.map((b) => {
      const p = b.productId ? productById.get(b.productId) : null;
      return {
        workflow_bag_id: b.workflowBagId,
        started_at: b.startedAt,
        finalized_at: b.finalizedAt,
        product: p?.name ?? "",
        sku: p?.sku ?? "",
        total_seconds: b.totalSeconds,
        active_seconds: b.activeSeconds,
        paused_seconds: b.pausedSeconds,
        blister_seconds: b.blisterSeconds ?? "",
        sealing_seconds: b.sealingSeconds ?? "",
        packaging_seconds: b.packagingSeconds ?? "",
        bottle_handpack_seconds: b.bottleHandpackSeconds ?? "",
        bottle_cap_seal_seconds: b.bottleCapSealSeconds ?? "",
        bottle_sticker_seconds: b.bottleStickerSeconds ?? "",
        master_cases: b.masterCases,
        displays_made: b.displaysMade,
        loose_cards: b.looseCards,
        damaged_packaging: b.damagedPackaging,
        ripped_cards: b.rippedCards,
        input_pill_count: b.inputPillCount ?? "",
        units_yielded: b.unitsYielded,
        yield_pct: b.yieldPct ?? "",
        operator_codes: (b.operatorCodes ?? []).join(";"),
      };
    });
    csv = rowsToCsv(headers, rows);
    filename = `bags-${lane}-${days}d.csv`;
  } else if (set === "daily") {
    const rows = await db
      .select()
      .from(readDailyThroughput)
      .where(sql`${readDailyThroughput.day} >= ${sinceStr}`)
      .orderBy(readDailyThroughput.day);
    csv = rowsToCsv(
      [
        "day",
        "product_id",
        "machine_id",
        "bags_blistered",
        "bags_sealed",
        "bags_packaged",
        "bags_finalized",
      ],
      rows.map((r) => ({
        day: r.day,
        product_id: r.productId ?? "",
        machine_id: r.machineId ?? "",
        bags_blistered: r.bagsBlistered,
        bags_sealed: r.bagsSealed,
        bags_packaged: r.bagsPackaged,
        bags_finalized: r.bagsFinalized,
      })),
    );
  } else if (set === "operators") {
    const rows = await db
      .select()
      .from(readOperatorDaily)
      .where(sql`${readOperatorDaily.day} >= ${sinceStr}`)
      .orderBy(readOperatorDaily.day, readOperatorDaily.operatorCode);
    csv = rowsToCsv(
      ["day", "operator_code", "bags_finalized", "active_seconds_total", "damage_count_total"],
      rows.map((r) => ({
        day: r.day,
        operator_code: r.operatorCode,
        bags_finalized: r.bagsFinalized,
        active_seconds_total: r.activeSecondsTotal,
        damage_count_total: r.damageCountTotal,
      })),
    );
  } else if (set === "materials") {
    const rows = await db
      .select({
        day: readMaterialBurn.day,
        materialName: packagingMaterials.name,
        materialSku: packagingMaterials.sku,
        uom: packagingMaterials.uom,
        qty: readMaterialBurn.qtyConsumed,
      })
      .from(readMaterialBurn)
      .leftJoin(
        packagingMaterials,
        eq(readMaterialBurn.packagingMaterialId, packagingMaterials.id),
      )
      .where(sql`${readMaterialBurn.day} >= ${sinceStr}`)
      .orderBy(readMaterialBurn.day);
    csv = rowsToCsv(
      ["day", "material", "sku", "uom", "qty_consumed"],
      rows.map((r) => ({
        day: r.day,
        material: r.materialName ?? "",
        sku: r.materialSku ?? "",
        uom: r.uom ?? "",
        qty_consumed: r.qty,
      })),
    );
  } else {
    return new NextResponse("Unknown set.", { status: 400 });
  }

  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
