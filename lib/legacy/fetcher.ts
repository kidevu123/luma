// Legacy-import fetcher. Walks the configured paths, downloads each
// from PythonAnywhere, drops the bytes into /data/legacy-imports/ with
// a timestamp suffix, and records per-file + per-run audit data.
//
// Storage layout:
//   /data/legacy-imports/<basename>-<ISO>.<ext>
//
// We keep the last LATEST_LINK_NAME pointer (just a copy of the most
// recent successful download) so importers can target a stable name
// without globbing through timestamps.

import { mkdir, writeFile, readdir, stat, unlink, copyFile } from "node:fs/promises";
import { join, basename, extname } from "node:path";
import { eq, desc } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  legacyImportConfig,
  legacyImportPaths,
  legacyImportRuns,
} from "@/lib/db/schema";
import { paFetchFile, PythonAnywhereError } from "./pa-client";
import { writeAudit } from "@/lib/db/audit";
import type { CurrentUser } from "@/lib/auth";

const STORAGE_ROOT = process.env.STORAGE_ROOT ?? "/data";
const IMPORTS_DIR = join(STORAGE_ROOT, "legacy-imports");

/** Keep this many timestamped versions per remote path. Older
 *  copies get pruned after a successful new fetch. */
const VERSIONS_TO_KEEP = 10;

async function ensureDir(): Promise<void> {
  await mkdir(IMPORTS_DIR, { recursive: true });
}

/** ISO with colons + dots replaced — safe in filenames everywhere. */
function fileTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/** Composes the on-disk filename for a fetched file. */
function localNameFor(remotePath: string): string {
  const base = basename(remotePath); // "tt-latest.sql.gz"
  const ext = extname(base); // ".gz"
  // For multi-part extensions like .sql.gz we want both halves to
  // come after the timestamp, so rebuild from scratch.
  const dotIdx = base.indexOf(".");
  const stem = dotIdx === -1 ? base : base.slice(0, dotIdx);
  const tail = dotIdx === -1 ? "" : base.slice(dotIdx);
  void ext;
  return `${stem}-${fileTimestamp()}${tail}`;
}

/** "stable pointer" filename — same shape as the remote basename so
 *  importers can target /data/legacy-imports/<basename> without
 *  caring about the timestamp. Updated to the latest success. */
function latestNameFor(remotePath: string): string {
  return basename(remotePath);
}

/** Best-effort prune of old versions for a given path stem. Leaves
 *  the LATEST pointer intact regardless of age. */
async function pruneOldVersions(remotePath: string): Promise<void> {
  const stableName = latestNameFor(remotePath);
  const dotIdx = stableName.indexOf(".");
  const stem = dotIdx === -1 ? stableName : stableName.slice(0, dotIdx);
  const entries = await readdir(IMPORTS_DIR);
  // Only consider timestamped variants of THIS path's basename;
  // never delete the stable pointer or unrelated files.
  const candidates: { name: string; mtime: number }[] = [];
  for (const f of entries) {
    if (f === stableName) continue;
    if (!f.startsWith(stem + "-")) continue;
    try {
      const s = await stat(join(IMPORTS_DIR, f));
      candidates.push({ name: f, mtime: s.mtime.getTime() });
    } catch {
      /* file vanished mid-listing */
    }
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  for (const old of candidates.slice(VERSIONS_TO_KEEP)) {
    try {
      await unlink(join(IMPORTS_DIR, old.name));
    } catch {
      /* tolerate races */
    }
  }
}

export type FetchResult = {
  ok: boolean;
  filesAttempted: number;
  filesSucceeded: number;
  perFile: Array<{
    pathId: string;
    remotePath: string;
    ok: boolean;
    bytes?: number;
    statusCode?: number;
    error?: string;
    localPath?: string;
  }>;
};

/** Run a fetch sweep across every enabled path on the config. Inserts
 *  a legacy_import_runs row, updates per-path status, and writes audit
 *  on success/fail. Does NOT throw — partial failures are recorded
 *  per-file and rolled up into the run summary. */
export async function runFetch(args: {
  configId: string;
  triggeredBy: "MANUAL" | "SCHEDULED";
  actor?: CurrentUser;
}): Promise<FetchResult> {
  await ensureDir();

  const [cfg] = await db
    .select()
    .from(legacyImportConfig)
    .where(eq(legacyImportConfig.id, args.configId));
  if (!cfg) throw new Error("Legacy-import config not found.");

  const paths = await db
    .select()
    .from(legacyImportPaths)
    .where(eq(legacyImportPaths.configId, args.configId))
    .orderBy(desc(legacyImportPaths.createdAt));
  const enabled = paths.filter((p) => p.enabled);

  // Open the run row up front so a hard-crash mid-fetch still
  // leaves a breadcrumb.
  const [run] = await db
    .insert(legacyImportRuns)
    .values({
      configId: args.configId,
      triggeredBy: args.triggeredBy,
      ...(args.actor ? { triggeredById: args.actor.id } : {}),
      filesAttempted: enabled.length,
    })
    .returning();
  if (!run) throw new Error("Failed to create run row.");

  const perFile: FetchResult["perFile"] = [];
  let succeeded = 0;
  for (const p of enabled) {
    try {
      const r = await paFetchFile(cfg.paUsername, cfg.paApiToken, p.remotePath);
      const localBasename = localNameFor(p.remotePath);
      const localPath = join(IMPORTS_DIR, localBasename);
      await writeFile(localPath, r.bytes, { mode: 0o600 });
      // Update the stable "latest" pointer so importers can rely on
      // a fixed filename.
      try {
        await copyFile(localPath, join(IMPORTS_DIR, latestNameFor(p.remotePath)));
      } catch {
        /* best-effort */
      }
      await db
        .update(legacyImportPaths)
        .set({
          lastFetchedAt: new Date(),
          lastBytes: r.contentLength,
          lastStatusCode: r.status,
          lastError: null,
          lastLocalPath: localPath,
        })
        .where(eq(legacyImportPaths.id, p.id));
      await pruneOldVersions(p.remotePath);
      perFile.push({
        pathId: p.id,
        remotePath: p.remotePath,
        ok: true,
        bytes: r.contentLength,
        statusCode: r.status,
        localPath,
      });
      succeeded++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown fetch error.";
      const status =
        err instanceof PythonAnywhereError ? err.status : undefined;
      await db
        .update(legacyImportPaths)
        .set({
          lastFetchedAt: new Date(),
          lastBytes: null,
          ...(status !== undefined ? { lastStatusCode: status } : {}),
          lastError: msg.slice(0, 800),
        })
        .where(eq(legacyImportPaths.id, p.id));
      perFile.push({
        pathId: p.id,
        remotePath: p.remotePath,
        ok: false,
        error: msg,
        ...(status !== undefined ? { statusCode: status } : {}),
      });
    }
  }

  const ok = succeeded === enabled.length && enabled.length > 0;
  const summaryStr =
    enabled.length === 0
      ? "No paths enabled."
      : `${succeeded}/${enabled.length} files fetched.`;

  await db
    .update(legacyImportRuns)
    .set({
      finishedAt: new Date(),
      ok,
      filesSucceeded: succeeded,
      summary: summaryStr,
    })
    .where(eq(legacyImportRuns.id, run.id));

  await db
    .update(legacyImportConfig)
    .set({
      lastSyncAt: new Date(),
      lastSyncOk: ok,
      lastSyncError: ok
        ? null
        : perFile.find((f) => !f.ok)?.error?.slice(0, 800) ?? null,
    })
    .where(eq(legacyImportConfig.id, args.configId));

  if (args.actor) {
    await writeAudit({
      actorId: args.actor.id,
      actorRole: args.actor.role,
      action: "legacy_import.fetch",
      targetType: "LegacyImportRun",
      targetId: run.id,
      after: {
        triggeredBy: args.triggeredBy,
        filesAttempted: enabled.length,
        filesSucceeded: succeeded,
        ok,
      },
    });
  }

  return {
    ok,
    filesAttempted: enabled.length,
    filesSucceeded: succeeded,
    perFile,
  };
}
