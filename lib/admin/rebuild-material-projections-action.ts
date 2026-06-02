"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/auth-guards";
import { rebuildAllMaterialProjections } from "@/lib/projector/material-read-model-refresh";

const REVALIDATE_PATHS = [
  "/settings/blister-standards",
  "/po-reconciliation-v2",
  "/material-alerts",
  "/floor-board",
  "/metrics/forecast",
  "/packaging-output",
] as const;

/** One-click rebuild for material burn, reconciliation v2, recommendations, rolls. */
export async function rebuildAllMaterialProjectionsAction(): Promise<{
  ok?: true;
  error?: string;
}> {
  await requireAdmin();
  try {
    await db.transaction(async (tx) => {
      await rebuildAllMaterialProjections(tx);
    });
    for (const path of REVALIDATE_PATHS) {
      revalidatePath(path);
    }
    return { ok: true };
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : "Rebuild failed.",
    };
  }
}
