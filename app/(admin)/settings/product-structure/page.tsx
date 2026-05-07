// Phase H.x0.5 — Generic product-structure admin page.
//
// Lists every product and the conversion chain configured for it.
// Lets admins add a new conversion step (e.g. "1 case = 24 displays")
// without writing code. Empty state surfaces "Product structure
// missing — configure item_conversions" — exactly the canonical
// label the metric API returns.
//
// This page does NOT hardcode pill / card / bottle. The form lets
// admins pick any item as parent and any item as child, choose pack
// levels, units, and quantities. Tablet → card and tablet → bottle
// are configured the same way as a future gummy → pouch.

import { asc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  itemConversions,
  items,
  products,
  productionRoutes,
} from "@/lib/db/schema";
import { requireAdmin } from "@/lib/auth-guards";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { saveItemConversionAction, deactivateItemConversionAction } from "./actions";

export const dynamic = "force-dynamic";

const PACK_LEVELS = [
  "RAW",
  "COMPONENT",
  "INTERMEDIATE",
  "UNIT",
  "INNER_PACK",
  "DISPLAY",
  "CASE",
  "PALLET",
  "FINISHED_GOOD",
  "SELLABLE",
] as const;

export default async function ProductStructurePage({
  searchParams,
}: {
  searchParams: Promise<{ productId?: string }>;
}) {
  await requireAdmin();
  const sp = await searchParams;
  const selectedProductId = sp.productId;

  const productList = await db
    .select({ id: products.id, name: products.name, sku: products.sku })
    .from(products)
    .where(eq(products.isActive, true))
    .orderBy(asc(products.name));

  const itemList = await db
    .select({
      id: items.id,
      itemCode: items.itemCode,
      name: items.name,
      itemCategory: items.itemCategory,
      defaultUom: items.defaultUnitOfMeasure,
    })
    .from(items)
    .where(eq(items.isActive, true))
    .orderBy(asc(items.itemCategory), asc(items.name));

  const routeList = await db
    .select({ id: productionRoutes.id, code: productionRoutes.code, name: productionRoutes.name })
    .from(productionRoutes)
    .where(eq(productionRoutes.isActive, true))
    .orderBy(asc(productionRoutes.code));

  type ConvRow = {
    id: string;
    parentName: string;
    parentLevel: string;
    parentQty: string;
    parentUom: string;
    childName: string;
    childLevel: string;
    childQty: string;
    childUom: string;
    routeCode: string | null;
    isActive: boolean;
  };
  let conversions: ConvRow[] = [];
  if (selectedProductId) {
    const rows = await db.execute<ConvRow>(`
      SELECT ic.id::text AS id,
             p.name AS "parentName", ic.parent_pack_level AS "parentLevel",
             ic.parent_quantity::text AS "parentQty", ic.parent_unit_of_measure AS "parentUom",
             c.name AS "childName", ic.child_pack_level AS "childLevel",
             ic.child_quantity::text AS "childQty", ic.child_unit_of_measure AS "childUom",
             r.code AS "routeCode",
             ic.is_active AS "isActive"
        FROM item_conversions ic
        JOIN items p ON p.id = ic.parent_item_id
        JOIN items c ON c.id = ic.child_item_id
        LEFT JOIN production_routes r ON r.id = ic.route_id
       WHERE ic.product_id = '${selectedProductId.replace(/'/g, "''")}'
       ORDER BY ic.is_active DESC, ic.created_at DESC
    `);
    conversions = (rows as unknown as ConvRow[]) ?? [];
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Product structure"
        description="Generic conversion chains. Define how 1 X contains N Y for any item — works for tablet→card, tablet→bottle, or future products without code changes."
      />

      <Card>
        <CardHeader>
          <CardTitle>Pick a product</CardTitle>
        </CardHeader>
        <CardContent>
          <form className="flex gap-2 items-end" action="/settings/product-structure">
            <div className="flex-1">
              <label className="text-xs uppercase text-text-muted">Product</label>
              <select
                name="productId"
                defaultValue={selectedProductId ?? ""}
                className="block w-full bg-surface border border-border/60 rounded px-2 py-1.5 text-sm"
              >
                <option value="">— Select product —</option>
                {productList.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.sku})
                  </option>
                ))}
              </select>
            </div>
            <Button type="submit" size="sm">
              Load
            </Button>
          </form>
        </CardContent>
      </Card>

      {selectedProductId && (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Conversion chain</CardTitle>
            </CardHeader>
            <CardContent>
              {conversions.length === 0 ? (
                <p className="text-sm text-text-muted">
                  Product structure missing. Add a conversion step below to begin.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="text-text-muted text-xs uppercase">
                      <tr>
                        <th className="text-left py-1">Parent</th>
                        <th className="text-left py-1">Parent qty</th>
                        <th className="text-left py-1">Child</th>
                        <th className="text-left py-1">Child qty</th>
                        <th className="text-left py-1">Route</th>
                        <th className="text-left py-1">Status</th>
                        <th className="text-left py-1"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {conversions.map((c) => (
                        <tr key={c.id} className="border-t border-border/40">
                          <td className="py-1.5">
                            {c.parentName} <span className="text-text-muted">({c.parentLevel})</span>
                          </td>
                          <td className="py-1.5 tabular-nums">
                            {c.parentQty} {c.parentUom}
                          </td>
                          <td className="py-1.5">
                            {c.childName} <span className="text-text-muted">({c.childLevel})</span>
                          </td>
                          <td className="py-1.5 tabular-nums">
                            {c.childQty} {c.childUom}
                          </td>
                          <td className="py-1.5">{c.routeCode ?? "—"}</td>
                          <td className="py-1.5">
                            {c.isActive ? (
                              <span className="text-green-700">Active</span>
                            ) : (
                              <span className="text-text-muted">Inactive</span>
                            )}
                          </td>
                          <td className="py-1.5">
                            {c.isActive ? (
                              <form
                                action={async (fd) => {
                                  "use server";
                                  await deactivateItemConversionAction(fd);
                                }}
                              >
                                <input type="hidden" name="id" value={c.id} />
                                <input type="hidden" name="productId" value={selectedProductId} />
                                <Button type="submit" variant="ghost" size="sm">
                                  Deactivate
                                </Button>
                              </form>
                            ) : null}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Add conversion step</CardTitle>
            </CardHeader>
            <CardContent>
              <form
                action={async (fd) => {
                  "use server";
                  await saveItemConversionAction(fd);
                }}
                className="grid sm:grid-cols-2 gap-3"
              >
                <input type="hidden" name="productId" value={selectedProductId} />
                <ItemSelect
                  label="Parent (output) item"
                  name="parentItemId"
                  items={itemList}
                />
                <ItemSelect
                  label="Child (input) item"
                  name="childItemId"
                  items={itemList}
                />
                <NumberField label="Parent quantity" name="parentQty" defaultValue="1" />
                <TextField label="Parent UOM" name="parentUom" defaultValue="cases" />
                <SelectField label="Parent pack level" name="parentPackLevel" options={PACK_LEVELS} />
                <NumberField label="Child quantity" name="childQty" defaultValue="24" />
                <TextField label="Child UOM" name="childUom" defaultValue="displays" />
                <SelectField label="Child pack level" name="childPackLevel" options={PACK_LEVELS} />
                <SelectField
                  label="Route (optional)"
                  name="routeId"
                  options={["", ...routeList.map((r) => r.id)]}
                  optionLabels={["—", ...routeList.map((r) => `${r.code} · ${r.name}`)]}
                />
                <DateField label="Effective from" name="effectiveFrom" />
                <div className="sm:col-span-2 flex gap-2 pt-2">
                  <Button type="submit" size="sm">
                    Save conversion
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

function ItemSelect({
  label,
  name,
  items,
}: {
  label: string;
  name: string;
  items: Array<{ id: string; itemCode: string; name: string; itemCategory: string; defaultUom: string }>;
}) {
  return (
    <label className="text-sm">
      <div className="text-xs uppercase text-text-muted mb-0.5">{label}</div>
      <select
        name={name}
        required
        className="block w-full bg-surface border border-border/60 rounded px-2 py-1.5 text-sm"
      >
        <option value="">— Select item —</option>
        {items.map((i) => (
          <option key={i.id} value={i.id}>
            {i.itemCode} · {i.name} [{i.itemCategory} · {i.defaultUom}]
          </option>
        ))}
      </select>
    </label>
  );
}

function NumberField({
  label,
  name,
  defaultValue,
}: {
  label: string;
  name: string;
  defaultValue: string;
}) {
  return (
    <label className="text-sm">
      <div className="text-xs uppercase text-text-muted mb-0.5">{label}</div>
      <input
        type="number"
        step="0.000001"
        min="0.000001"
        required
        name={name}
        defaultValue={defaultValue}
        className="block w-full bg-surface border border-border/60 rounded px-2 py-1.5 text-sm tabular-nums"
      />
    </label>
  );
}

function TextField({
  label,
  name,
  defaultValue,
}: {
  label: string;
  name: string;
  defaultValue?: string;
}) {
  return (
    <label className="text-sm">
      <div className="text-xs uppercase text-text-muted mb-0.5">{label}</div>
      <input
        type="text"
        required
        name={name}
        defaultValue={defaultValue}
        className="block w-full bg-surface border border-border/60 rounded px-2 py-1.5 text-sm"
      />
    </label>
  );
}

function SelectField({
  label,
  name,
  options,
  optionLabels,
}: {
  label: string;
  name: string;
  options: ReadonlyArray<string>;
  optionLabels?: ReadonlyArray<string>;
}) {
  return (
    <label className="text-sm">
      <div className="text-xs uppercase text-text-muted mb-0.5">{label}</div>
      <select
        name={name}
        className="block w-full bg-surface border border-border/60 rounded px-2 py-1.5 text-sm"
      >
        {options.map((opt, idx) => (
          <option key={`${opt}-${idx}`} value={opt}>
            {optionLabels?.[idx] ?? opt}
          </option>
        ))}
      </select>
    </label>
  );
}

function DateField({
  label,
  name,
}: {
  label: string;
  name: string;
}) {
  const today = new Date().toISOString().slice(0, 10);
  return (
    <label className="text-sm">
      <div className="text-xs uppercase text-text-muted mb-0.5">{label}</div>
      <input
        type="date"
        required
        name={name}
        defaultValue={today}
        className="block w-full bg-surface border border-border/60 rounded px-2 py-1.5 text-sm"
      />
    </label>
  );
}
