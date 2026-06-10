#!/usr/bin/env npx tsx
// Controlled backfill: HYROXI MIT B product_family on products, tablet types, PO lines.
// Dry-run by default — pass --apply to write.

import { eq, ilike, inArray, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { poLines, products, tabletTypes } from "@/lib/db/schema";

const FAMILY = "HYROXI_MIT_B" as const;
const NAME_PATTERNS = ["Hyroxi MIT B%", "Hyroxi Mit B%", "Choco Drift%"];

type ReportRow = {
  table: string;
  id: string;
  name: string;
  before: string | null;
  after: string;
};

async function main() {
  const apply = process.argv.includes("--apply");
  const report: ReportRow[] = [];

  const productRows = await db
    .select({ id: products.id, name: products.name, family: products.productFamily })
    .from(products)
    .where(
      or(
        ...NAME_PATTERNS.map((p) => ilike(products.name, p)),
        eq(products.sku, "453535"),
      ),
    );

  for (const row of productRows) {
    if (row.family === FAMILY) continue;
    report.push({
      table: "products",
      id: row.id,
      name: row.name,
      before: row.family,
      after: FAMILY,
    });
    if (apply) {
      await db
        .update(products)
        .set({ productFamily: FAMILY, updatedAt: sql`now()` })
        .where(eq(products.id, row.id));
    }
  }

  const tabletRows = await db
    .select({ id: tabletTypes.id, name: tabletTypes.name, family: tabletTypes.productFamily })
    .from(tabletTypes)
    .where(or(...NAME_PATTERNS.map((p) => ilike(tabletTypes.name, p))));

  for (const row of tabletRows) {
    if (row.family === FAMILY) continue;
    report.push({
      table: "tablet_types",
      id: row.id,
      name: row.name,
      before: row.family,
      after: FAMILY,
    });
    if (apply) {
      await db
        .update(tabletTypes)
        .set({ productFamily: FAMILY, updatedAt: sql`now()` })
        .where(eq(tabletTypes.id, row.id));
    }
  }

  const hyroxiTabletIds = tabletRows.map((r) => r.id);
  if (hyroxiTabletIds.length > 0) {
    const poLineRows = await db
      .select({
        id: poLines.id,
        tabletTypeId: poLines.tabletTypeId,
        notes: poLines.notes,
      })
      .from(poLines)
      .where(inArray(poLines.tabletTypeId, hyroxiTabletIds));

    for (const row of poLineRows) {
      report.push({
        table: "po_lines",
        id: row.id,
        name: row.notes ?? row.tabletTypeId ?? row.id,
        before: "via_tablet_type",
        after: FAMILY,
      });
    }
  }

  console.log(
    JSON.stringify(
      {
        mode: apply ? "apply" : "dry-run",
        family: FAMILY,
        rows: report.length,
        changes: report,
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
