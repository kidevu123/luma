// Database snapshot utilities. Wraps pg_dump (for capture) and a
// safe TRUNCATE list (for the wipe-production-data button). Lives
// behind the OWNER role on /settings/danger-zone — destructive,
// audited, typed-confirmation gated.
//
// Storage: /data/snapshots/<ISO>.sql.gz, persisted in the same
// volume as uploads so a container rebuild doesn't lose them.

import { promisify } from "node:util";
import { spawn } from "node:child_process";
import { mkdir, readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { db } from "@/lib/db";
import { sql } from "drizzle-orm";
import { writeAudit } from "@/lib/db/audit";
import type { CurrentUser } from "@/lib/auth";

const STORAGE_ROOT = process.env.STORAGE_ROOT ?? "/data";
const SNAPSHOTS_DIR = join(STORAGE_ROOT, "snapshots");

export type SnapshotFile = {
  filename: string;
  bytes: number;
  createdAt: Date;
};

async function ensureDir(): Promise<void> {
  await mkdir(SNAPSHOTS_DIR, { recursive: true });
}

export async function listSnapshots(): Promise<SnapshotFile[]> {
  await ensureDir();
  const entries = await readdir(SNAPSHOTS_DIR);
  const out: SnapshotFile[] = [];
  for (const f of entries) {
    if (!f.endsWith(".sql.gz")) continue;
    try {
      const s = await stat(join(SNAPSHOTS_DIR, f));
      out.push({
        filename: f,
        bytes: s.size,
        createdAt: s.mtime,
      });
    } catch {
      /* skip — file vanished mid-listing */
    }
  }
  return out.sort(
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
  );
}

/** Run pg_dump → gzip into a single file. Returns the snapshot
 *  filename. The DB connection comes from DATABASE_URL so this
 *  works the same in dev + prod. */
export async function createSnapshot(
  actor: CurrentUser,
  label?: string,
): Promise<{ filename: string; bytes: number }> {
  await ensureDir();
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL not set.");
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const slug = (label ?? "snapshot").replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 40);
  const filename = `${slug}-${ts}.sql.gz`;
  const target = join(SNAPSHOTS_DIR, filename);

  await new Promise<void>((resolve, reject) => {
    const dump = spawn(
      "sh",
      [
        "-c",
        // pg_dump → gzip → file. --no-owner / --no-privileges
        // make the dump portable to any restore target.
        `pg_dump --no-owner --no-privileges --format=plain "${url}" | gzip > "${target}"`,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stderr = "";
    dump.stderr?.on("data", (b: Buffer) => {
      stderr += b.toString();
    });
    dump.on("error", reject);
    dump.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`pg_dump exited ${code}: ${stderr.slice(0, 400)}`));
    });
  });

  const s = await stat(target);
  await writeAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: "snapshot.create",
    targetType: "DatabaseSnapshot",
    targetId: filename,
    after: { filename, bytes: s.size, label },
  });
  return { filename, bytes: s.size };
}

export async function deleteSnapshot(
  filename: string,
  actor: CurrentUser,
): Promise<void> {
  if (!/^[a-zA-Z0-9_.-]+\.sql\.gz$/.test(filename)) {
    throw new Error("Invalid snapshot filename.");
  }
  const target = join(SNAPSHOTS_DIR, filename);
  await unlink(target);
  await writeAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: "snapshot.delete",
    targetType: "DatabaseSnapshot",
    targetId: filename,
  });
}

// ── Wipe-production-data ────────────────────────────────────────────────────
//
// Truncates only the rolling production tables. Keeps master data
// (products / tablet types / machines / stations / packaging
// materials / QR cards), users + sessions, audit log, zoho creds.
// After a wipe the system is fresh-but-configured: ready to import
// or run a new test cycle.

const PRODUCTION_TABLES = [
  // Workflow event stream + read models
  "workflow_events",
  "workflow_bags",
  "read_station_live",
  "read_bag_state",
  "read_bag_metrics",
  "read_daily_throughput",
  "read_operator_daily",
  "read_material_burn",
  // Output
  "finished_lot_inputs",
  "finished_lots",
  "zoho_pushes",
  // Inbound / lifecycle
  "inventory_bags",
  "small_boxes",
  "receives",
  "shipments",
  "batch_holds",
  "batches",
  "packaging_lots",
] as const;

export type WipeMode = "production" | "everything";

/** TRUNCATE production tables CASCADE inside a transaction. Takes
 *  a pre-wipe snapshot first so an "oops" can be reversed by
 *  reloading the dump file. Audit row written. */
export async function wipeProductionData(
  actor: CurrentUser,
  mode: WipeMode,
): Promise<{ snapshot: string; tablesWiped: string[] }> {
  // 1. Take a pre-wipe snapshot so the action is reversible.
  const { filename } = await createSnapshot(actor, `pre-wipe-${mode}`);

  // 2. Truncate. CASCADE handles foreign-key chains within the set.
  const tables =
    mode === "everything"
      ? [
          ...PRODUCTION_TABLES,
          // Master data — only when the operator picks "everything".
          "product_packaging_specs",
          "product_allowed_tablets",
          "qr_cards",
          "stations",
          "machines",
          "packaging_materials",
          "tablet_types",
          "products",
          "purchase_orders",
          "po_lines",
        ]
      : [...PRODUCTION_TABLES];

  // Audit BEFORE truncate so the action is captured even if the
  // truncate cascades into audit_log somehow (it won't — audit_log
  // is intentionally outside the wipe set).
  await writeAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: "database.wipe",
    targetType: "Database",
    targetId: mode,
    before: { tables, snapshot: filename },
  });

  // Build a single TRUNCATE statement so all the CASCADE happens in
  // one shot. RESTART IDENTITY resets sequences too.
  await db.execute(
    sql.raw(
      `TRUNCATE TABLE ${tables
        .map((t) => `"${t}"`)
        .join(", ")} RESTART IDENTITY CASCADE`,
    ),
  );

  return { snapshot: filename, tablesWiped: tables };
}
