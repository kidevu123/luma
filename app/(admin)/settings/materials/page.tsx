import { db } from "@/lib/db";
import { eq, desc, sql } from "drizzle-orm";
import { packagingMaterials } from "@/lib/db/schema";
import { requireAdmin } from "@/lib/auth-guards";
import { PageHeader, StatusPill, EmptyState } from "@/components/ui/page-header";
import { DataTable, THead, TR, TH, TD } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { Boxes } from "lucide-react";
import {
  saveMaterialItemAction,
  toggleMaterialItemActiveAction,
  setMaterialCategoryAction,
  deleteMaterialAction,
} from "./actions";

export const dynamic = "force-dynamic";

const KIND_LABELS: Record<string, string> = {
  BLISTER_CARD: "Blister card",
  DISPLAY: "Display box",
  CASE: "Master case",
  LABEL: "Label",
  BOTTLE: "Bottle",
  CAP: "Cap",
  INDUCTION_SEAL: "Induction seal",
  INSERT: "Insert",
  SHRINK_BAND: "Shrink band",
  PVC_ROLL: "PVC roll",
  FOIL_ROLL: "Foil roll",
  BLISTER_FOIL: "Blister foil (legacy)",
  HEAT_SEAL_FILM: "Heat-seal film",
  DESICCANT: "Desiccant",
  COTTON: "Cotton",
  OTHER: "Other",
};

export default async function MaterialsAdminPage({
  searchParams,
}: {
  searchParams: Promise<{ kind?: string; q?: string; err?: string }>;
}) {
  await requireAdmin();
  const sp = await searchParams;
  const kindFilter = sp.kind && sp.kind !== "ALL" ? sp.kind : null;
  const q = sp.q?.trim().toLowerCase() ?? "";
  const actionError = sp.err ? decodeURIComponent(sp.err) : null;
  const rows = await db
    .select()
    .from(packagingMaterials)
    .where(kindFilter ? eq(packagingMaterials.kind, kindFilter as never) : sql`true`)
    .orderBy(desc(packagingMaterials.createdAt));
  const filtered = q
    ? rows.filter((r) => r.name.toLowerCase().includes(q) || r.sku.toLowerCase().includes(q))
    : rows;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Packaging & Materials"
        description={`${rows.length} item${rows.length === 1 ? "" : "s"} in the master list. Inactive items are hidden from BOM and receiving forms.`}
      />

      {actionError && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {actionError}
        </div>
      )}

      {/* Filter bar */}
      <form method="get" className="flex flex-wrap items-end gap-2 rounded-xl border border-border bg-surface px-4 py-3">
        <div className="space-y-1">
          <Label htmlFor="kind-filter">Kind</Label>
          <Select id="kind-filter" name="kind" defaultValue={kindFilter ?? "ALL"}>
            <option value="ALL">All kinds</option>
            {Object.entries(KIND_LABELS).map(([k, label]) => (
              <option key={k} value={k}>{label}</option>
            ))}
          </Select>
        </div>
        <div className="space-y-1 flex-1 min-w-[200px]">
          <Label htmlFor="q-filter">Search</Label>
          <Input id="q-filter" name="q" placeholder="name or SKU" defaultValue={q} />
        </div>
        <Button type="submit" variant="secondary">Filter</Button>
      </form>

      {/* Create form */}
      <div className="rounded-xl border border-border bg-surface px-4 py-4 space-y-3">
        <p className="text-sm font-semibold text-text-strong">New material</p>
        <form
          action={async (fd) => {
            "use server";
            await saveMaterialItemAction(fd);
          }}
          className="grid grid-cols-1 sm:grid-cols-3 gap-3"
        >
          <div className="space-y-1">
            <Label htmlFor="new-sku">SKU / code</Label>
            <Input id="new-sku" name="sku" required placeholder="DISP-A-12" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="new-name">Name</Label>
            <Input id="new-name" name="name" required placeholder="Display box — A pack" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="new-kind">Kind</Label>
            <Select id="new-kind" name="kind" required defaultValue="">
              <option value="">— select —</option>
              {Object.entries(KIND_LABELS).map(([v, l]) => (
                <option key={v} value={v}>{l}</option>
              ))}
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="new-category">Category</Label>
            <Select id="new-category" name="category" defaultValue="PACKAGING">
              <option value="PACKAGING">Packaging</option>
              <option value="MATERIAL">Material</option>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="new-uom">Unit of measure</Label>
            <Input id="new-uom" name="uom" required defaultValue="each" placeholder="each / kg / roll" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="new-par">Par level (optional)</Label>
            <Input id="new-par" name="parLevel" type="number" min={0} placeholder="—" />
          </div>
          <label className="flex items-end gap-2 pb-1">
            <input
              type="checkbox"
              name="isActive"
              defaultChecked
              className="h-4 w-4 rounded border-border accent-brand-700"
            />
            <span className="text-sm text-text-muted">Active</span>
          </label>
          <div className="sm:col-span-3 flex justify-end">
            <Button type="submit">Add material</Button>
          </div>
        </form>
      </div>

      {/* List */}
      {filtered.length === 0 ? (
        <EmptyState
          icon={Boxes}
          title={rows.length === 0 ? "No materials yet" : "No items match the filter"}
          description={
            rows.length === 0
              ? "Add packaging materials above so receiving and BOM forms have something to reference."
              : "Clear the filter to see all materials."
          }
        />
      ) : (
        <DataTable>
          <THead>
            <TR>
              <TH>SKU</TH>
              <TH>Name</TH>
              <TH>Kind</TH>
              <TH>Category</TH>
              <TH>UoM</TH>
              <TH className="text-right">Par</TH>
              <TH>Status</TH>
              <TH className="text-right">Actions</TH>
            </TR>
          </THead>
          <tbody>
            {filtered.map((r) => (
              <TR key={r.id}>
                <TD className="font-mono text-xs">{r.sku}</TD>
                <TD className="font-medium">{r.name}</TD>
                <TD>{KIND_LABELS[r.kind] ?? r.kind}</TD>
                <TD>
                  <StatusPill kind={r.category === "PACKAGING" ? "info" : "neutral"}>
                    {r.category === "PACKAGING" ? "Packaging" : "Material"}
                  </StatusPill>
                </TD>
                <TD className="font-mono text-xs">{r.uom}</TD>
                <TD className="text-right tabular-nums">{r.parLevel ?? "—"}</TD>
                <TD>
                  <StatusPill kind={r.isActive ? "ok" : "neutral"}>
                    {r.isActive ? "Active" : "Inactive"}
                  </StatusPill>
                </TD>
                <TD className="text-right">
                  <div className="flex items-center justify-end gap-3">
                    <form
                      action={async () => {
                        "use server";
                        await setMaterialCategoryAction(
                          r.id,
                          r.category === "PACKAGING" ? "MATERIAL" : "PACKAGING",
                        );
                      }}
                    >
                      <button
                        type="submit"
                        className="text-xs text-text-subtle hover:text-brand-700 transition-colors"
                      >
                        {r.category === "PACKAGING" ? "→ Material" : "→ Packaging"}
                      </button>
                    </form>
                    <form
                      action={async () => {
                        "use server";
                        await toggleMaterialItemActiveAction(r.id, !r.isActive);
                      }}
                    >
                      <button
                        type="submit"
                        className="text-xs text-text-subtle hover:text-text transition-colors"
                      >
                        {r.isActive ? "Deactivate" : "Activate"}
                      </button>
                    </form>
                    <form action={deleteMaterialAction}>
                      <input type="hidden" name="id" value={r.id} />
                      <button
                        type="submit"
                        className="text-xs text-text-subtle hover:text-red-600 transition-colors"
                      >
                        Delete
                      </button>
                    </form>
                  </div>
                </TD>
              </TR>
            ))}
          </tbody>
        </DataTable>
      )}
    </div>
  );
}
