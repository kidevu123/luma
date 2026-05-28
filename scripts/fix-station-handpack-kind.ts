// STATION-KIND-FIX-1 — correct mislabeled hand-pack station kinds in DB.
//
// Root cause: "Blister Hand Pack Station" was created as kind BLISTER via
// admin UI before HANDPACK_BLISTER existed (or by mistake). Stations are
// not seeded from code — see lib/production/station-kind-catalog.ts.
//
// Usage (dry-run — default):
//   tsx scripts/fix-station-handpack-kind.ts
//
// Apply locally / staging:
//   tsx scripts/fix-station-handpack-kind.ts --apply
//
// Apply on production (requires explicit opt-in):
//   ALLOW_STATION_KIND_FIX=true tsx scripts/fix-station-handpack-kind.ts --apply
//
// Refuses --apply when NODE_ENV=production unless ALLOW_STATION_KIND_FIX=true.

import { db } from "../lib/db";
import { stations } from "../lib/db/schema";
import { writeAudit } from "../lib/db/audit";
import {
  plannedDeactivations,
  plannedKindCorrections,
} from "../lib/production/station-kind-catalog";
import { eq, inArray } from "drizzle-orm";

function refuseProductionApply(apply: boolean) {
  if (!apply) return;
  const envSaysProd = process.env.NODE_ENV === "production";
  const allow = process.env.ALLOW_STATION_KIND_FIX === "true";
  if (envSaysProd && !allow) {
    console.error(
      "[fix-station-handpack-kind] Refusing --apply: NODE_ENV=production and ALLOW_STATION_KIND_FIX != 'true'.",
    );
    process.exit(2);
  }
}

async function main() {
  const apply = process.argv.includes("--apply");
  refuseProductionApply(apply);

  const corrections = plannedKindCorrections();
  const deactivations = plannedDeactivations();
  const labels = [
    ...corrections.map((c) => c.label),
    ...deactivations.map((d) => d.label),
  ];

  const rows = await db
    .select()
    .from(stations)
    .where(inArray(stations.label, labels));

  const byLabel = new Map(rows.map((r) => [r.label, r]));

  console.log(
    `[fix-station-handpack-kind] ${apply ? "APPLY" : "DRY-RUN"} — ${rows.length} station row(s) matched`,
  );

  type Change =
    | {
        kind: "kind-correction";
        label: string;
        stationId: string;
        before: { kind: string; machineId: string | null; isActive: boolean };
        after: { kind: string; machineId: string | null; isActive: boolean };
      }
    | {
        kind: "deactivate";
        label: string;
        stationId: string;
        before: { isActive: boolean };
        after: { isActive: boolean };
      }
    | { kind: "missing"; label: string }
    | { kind: "noop"; label: string; reason: string };

  const changes: Change[] = [];

  for (const plan of corrections) {
    const row = byLabel.get(plan.label);
    if (!row) {
      changes.push({ kind: "missing", label: plan.label });
      continue;
    }
    const nextMachineId = plan.clearMachineId ? null : row.machineId;
    const needsKind = row.kind !== plan.expectedKind;
    const needsMachine = plan.clearMachineId && row.machineId != null;
    if (!needsKind && !needsMachine) {
      changes.push({
        kind: "noop",
        label: plan.label,
        reason: `already ${plan.expectedKind}`,
      });
      continue;
    }
    changes.push({
      kind: "kind-correction",
      label: plan.label,
      stationId: row.id,
      before: {
        kind: row.kind,
        machineId: row.machineId,
        isActive: row.isActive,
      },
      after: {
        kind: plan.expectedKind,
        machineId: nextMachineId,
        isActive: row.isActive,
      },
    });
  }

  for (const plan of deactivations) {
    const row = byLabel.get(plan.label);
    if (!row) {
      changes.push({ kind: "missing", label: plan.label });
      continue;
    }
    if (!row.isActive) {
      changes.push({
        kind: "noop",
        label: plan.label,
        reason: "already inactive",
      });
      continue;
    }
    changes.push({
      kind: "deactivate",
      label: plan.label,
      stationId: row.id,
      before: { isActive: true },
      after: { isActive: false },
    });
  }

  for (const c of changes) {
    switch (c.kind) {
      case "missing":
        console.log(`  MISSING  ${c.label} — not in DB (skip)`);
        break;
      case "noop":
        console.log(`  OK       ${c.label} — ${c.reason}`);
        break;
      case "kind-correction":
        console.log(
          `  FIX KIND ${c.label} (${c.stationId}): ${c.before.kind} → ${c.after.kind}` +
            (c.before.machineId !== c.after.machineId
              ? `; machine_id ${c.before.machineId ?? "null"} → null`
              : ""),
        );
        break;
      case "deactivate":
        console.log(`  DEACTIV  ${c.label} (${c.stationId}): is_active true → false`);
        break;
    }
  }

  const actionable = changes.filter(
    (c) => c.kind === "kind-correction" || c.kind === "deactivate",
  );
  if (actionable.length === 0) {
    console.log("[fix-station-handpack-kind] nothing to do.");
    process.exit(0);
  }

  if (!apply) {
    console.log(
      `[fix-station-handpack-kind] dry-run complete — ${actionable.length} change(s) pending. Re-run with --apply.`,
    );
    process.exit(0);
  }

  await db.transaction(async (tx) => {
    for (const c of actionable) {
      if (c.kind === "kind-correction") {
        const [updated] = await tx
          .update(stations)
          .set({
            kind: c.after.kind as typeof stations.$inferInsert.kind,
            machineId: c.after.machineId,
          })
          .where(eq(stations.id, c.stationId))
          .returning();
        if (!updated) throw new Error(`update failed for ${c.label}`);
        await writeAudit(
          {
            actorId: null,
            actorRole: null,
            action: "station.kind_correction",
            targetType: "Station",
            targetId: c.stationId,
            before: c.before,
            after: c.after,
          },
          tx,
        );
      } else if (c.kind === "deactivate") {
        const [updated] = await tx
          .update(stations)
          .set({ isActive: false })
          .where(eq(stations.id, c.stationId))
          .returning();
        if (!updated) throw new Error(`deactivate failed for ${c.label}`);
        await writeAudit(
          {
            actorId: null,
            actorRole: null,
            action: "station.deactivate",
            targetType: "Station",
            targetId: c.stationId,
            before: c.before,
            after: c.after,
          },
          tx,
        );
      }
    }
  });

  console.log(
    `[fix-station-handpack-kind] applied ${actionable.length} change(s).`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error("[fix-station-handpack-kind]", err);
  process.exit(1);
});
