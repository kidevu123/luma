// Danger zone — snapshots + database wipe. Owner-only. Every
// destructive action is captured by an audit row, takes a
// pre-action snapshot, and requires a typed confirmation phrase.

import Link from "next/link";
import { ArrowLeft, Save, Trash2, AlertTriangle, Download, Database } from "lucide-react";
import { requireOwner } from "@/lib/auth-guards";
import { listSnapshots } from "@/lib/admin/snapshots";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { TakeSnapshotForm, DeleteSnapshotButton, WipeForm } from "./forms";

export const dynamic = "force-dynamic";

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export default async function DangerZonePage() {
  await requireOwner();
  const snapshots = await listSnapshots();

  return (
    <div className="space-y-5">
      <div>
        <Link
          href="/settings"
          className="inline-flex items-center gap-1 text-xs text-text-muted hover:text-text mb-2"
        >
          <ArrowLeft className="h-3 w-3" /> Settings
        </Link>
        <PageHeader
          title="Danger zone"
          description="Database snapshots + reset. Owner-only. Every action is audited and a pre-action snapshot is taken automatically."
        />
      </div>

      <div className="rounded-lg border-2 border-amber-300 bg-amber-50 p-4 text-amber-900">
        <p className="font-semibold flex items-center gap-2">
          <AlertTriangle className="h-4 w-4" /> Read this first
        </p>
        <ul className="text-sm mt-2 space-y-1 leading-relaxed list-disc pl-5">
          <li>
            Snapshots run <span className="font-mono text-xs">pg_dump</span>{" "}
            inside the app container, gzipped. They live at{" "}
            <span className="font-mono text-xs">/data/snapshots/</span> on
            LX122. Download yours for off-host safety.
          </li>
          <li>
            <span className="font-semibold">Wipe production data</span>{" "}
            keeps products / tablet types / machines / stations / packaging
            materials / QR cards / users / audit log. Use this when you want
            to clear out test runs.
          </li>
          <li>
            <span className="font-semibold">Reset everything</span> wipes
            master data too — only users and the audit log survive. Use
            when you want a totally fresh tenant.
          </li>
          <li>
            Both actions take a pre-wipe snapshot first. To recover, you
            download the snapshot and pipe it back in via{" "}
            <span className="font-mono text-xs">
              gunzip -c file.sql.gz | psql $DATABASE_URL
            </span>
            .
          </li>
        </ul>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Save className="h-4 w-4 text-text-subtle" /> Take a snapshot
          </CardTitle>
        </CardHeader>
        <CardContent>
          <TakeSnapshotForm />
          <p className="text-[11px] text-text-subtle mt-3">
            Tip: take a snapshot right before any test data import or admin
            test cycle. Restores from a snapshot are a deliberate manual
            operation — that's the right level of friction.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Database className="h-4 w-4 text-text-subtle" /> Existing
            snapshots ({snapshots.length})
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {snapshots.length === 0 ? (
            <p className="text-sm text-text-muted px-4 py-3">
              No snapshots yet.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-surface-2/40 text-[10px] uppercase tracking-wider text-text-subtle">
                <tr>
                  <th className="text-left px-4 py-2 font-medium">Filename</th>
                  <th className="text-right px-4 py-2 font-medium">Size</th>
                  <th className="text-left px-4 py-2 font-medium">Created</th>
                  <th className="text-right px-4 py-2 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/40">
                {snapshots.map((s) => (
                  <tr key={s.filename}>
                    <td className="px-4 py-2 font-mono text-xs truncate max-w-md">
                      {s.filename}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">
                      {fmtBytes(s.bytes)}
                    </td>
                    <td className="px-4 py-2 text-xs text-text-muted tabular-nums">
                      {s.createdAt.toLocaleString()}
                    </td>
                    <td className="px-4 py-2 text-right">
                      <div className="inline-flex items-center gap-1.5">
                        <a
                          href={`/api/snapshots/${encodeURIComponent(s.filename)}`}
                          className="inline-flex items-center gap-1 text-xs text-brand-700 hover:underline"
                        >
                          <Download className="h-3 w-3" /> Download
                        </a>
                        <DeleteSnapshotButton filename={s.filename} />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <Card className="border-red-200">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-red-700">
            <Trash2 className="h-4 w-4" /> Wipe data
          </CardTitle>
        </CardHeader>
        <CardContent>
          <WipeForm />
        </CardContent>
      </Card>
    </div>
  );
}
