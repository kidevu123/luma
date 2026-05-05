import { Plus, PackageCheck } from "lucide-react";
import { requireAdmin } from "@/lib/auth-guards";
import { listPackagingMaterials } from "@/lib/db/queries/packaging";
import { PageHeader, StatusPill, EmptyState } from "@/components/ui/page-header";
import { DataTable, THead, TR, TH, TD } from "@/components/ui/table";
import { PackagingDialog } from "./packaging-dialog";

export const dynamic = "force-dynamic";

const KIND_LABEL: Record<string, string> = {
  BLISTER_FOIL: "Blister foil",
  HEAT_SEAL_FILM: "Heat-seal film",
  BOTTLE: "Bottle",
  CAP: "Cap",
  INDUCTION_SEAL: "Induction seal",
  LABEL: "Label",
  DESICCANT: "Desiccant",
  COTTON: "Cotton",
  DISPLAY: "Display",
  CASE: "Case",
  INSERT: "Insert",
  OTHER: "Other",
};

export default async function PackagingPage() {
  await requireAdmin();
  const rows = await listPackagingMaterials();
  return (
    <div className="space-y-5">
      <PageHeader
        title="Packaging materials"
        description="Bottles, caps, labels, foil, cases — every consumable that touches a finished lot. Each lot you receive is tied to a packaging batch so the COA is one click away."
        actions={<PackagingDialog triggerLabel="New material" triggerIcon={Plus} />}
      />

      {rows.length === 0 ? (
        <EmptyState
          icon={PackageCheck}
          title="No packaging materials yet"
          description="Add the consumables your products use. The BOM editor under each product references these."
          action={<PackagingDialog triggerLabel="Create material" triggerIcon={Plus} />}
        />
      ) : (
        <DataTable>
          <THead>
            <TR>
              <TH>SKU</TH>
              <TH>Name</TH>
              <TH>Kind</TH>
              <TH>UoM</TH>
              <TH className="text-right">Par level</TH>
              <TH>Zoho</TH>
              <TH>Status</TH>
              <TH className="text-right">Actions</TH>
            </TR>
          </THead>
          <tbody>
            {rows.map((r) => (
              <TR key={r.id}>
                <TD className="font-mono text-xs">{r.sku}</TD>
                <TD className="font-medium">{r.name}</TD>
                <TD className="text-text-muted">{KIND_LABEL[r.kind] ?? r.kind}</TD>
                <TD className="text-xs text-text-muted">{r.uom}</TD>
                <TD className="text-right tabular-nums">{r.parLevel ?? "—"}</TD>
                <TD className="font-mono text-xs text-text-muted">{r.zohoItemId ?? "—"}</TD>
                <TD>
                  <StatusPill kind={r.isActive ? "ok" : "neutral"}>
                    {r.isActive ? "Active" : "Inactive"}
                  </StatusPill>
                </TD>
                <TD className="text-right">
                  <PackagingDialog row={r} triggerLabel="Edit" />
                </TD>
              </TR>
            ))}
          </tbody>
        </DataTable>
      )}
    </div>
  );
}
