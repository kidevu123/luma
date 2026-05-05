import { Plus, Pill } from "lucide-react";
import { requireAdmin } from "@/lib/auth-guards";
import { listTabletTypes } from "@/lib/db/queries/tablet-types";
import { PageHeader, StatusPill, EmptyState } from "@/components/ui/page-header";
import { DataTable, THead, TR, TH, TD, EmptyRow } from "@/components/ui/table";
import { TabletTypeDialog } from "./tablet-type-dialog";

export const dynamic = "force-dynamic";

export default async function TabletTypesPage() {
  await requireAdmin();
  const rows = await listTabletTypes();
  return (
    <div className="space-y-5">
      <PageHeader
        title="Tablet types"
        description="Master list of physical tablets received from vendors. Each receiving bag inherits a tablet_type_id; products specify allowed tablet types via the BOM."
        actions={
          <TabletTypeDialog
            triggerLabel="New tablet type"
            triggerIcon={Plus}
          />
        }
      />

      {rows.length === 0 ? (
        <EmptyState
          icon={Pill}
          title="No tablet types yet"
          description="Add your first tablet type to start receiving inventory."
          action={
            <TabletTypeDialog
              triggerLabel="Create tablet type"
              triggerIcon={Plus}
            />
          }
        />
      ) : (
        <DataTable>
          <THead>
            <TR>
              <TH>Name</TH>
              <TH>SKU</TH>
              <TH className="text-right">mg / tablet</TH>
              <TH>Zoho item</TH>
              <TH>Status</TH>
              <TH className="text-right">Actions</TH>
            </TR>
          </THead>
          <tbody>
            {rows.length === 0 ? (
              <EmptyRow colSpan={6}>—</EmptyRow>
            ) : (
              rows.map((row) => (
                <TR key={row.id}>
                  <TD className="font-medium">{row.name}</TD>
                  <TD className="font-mono text-xs text-text-muted">{row.sku ?? "—"}</TD>
                  <TD className="text-right tabular-nums">
                    {row.defaultMgPerTablet ?? "—"}
                  </TD>
                  <TD className="font-mono text-xs text-text-muted">
                    {row.zohoItemId ?? "—"}
                  </TD>
                  <TD>
                    <StatusPill kind={row.isActive ? "ok" : "neutral"}>
                      {row.isActive ? "Active" : "Inactive"}
                    </StatusPill>
                  </TD>
                  <TD className="text-right">
                    <TabletTypeDialog row={row} triggerLabel="Edit" />
                  </TD>
                </TR>
              ))
            )}
          </tbody>
        </DataTable>
      )}
    </div>
  );
}
