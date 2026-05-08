// PT-4A: register the PackTrack external_systems row.
//
// Idempotent — safe to run repeatedly. Prints the resolved id so
// the operator can confirm one-time setup.
//
// Usage:
//   ALLOW_STAGING_QA_DATA=true tsx scripts/register-packtrack.ts
//   tsx scripts/register-packtrack.ts                   (production)

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import * as schema from "@/lib/db/schema";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set");
  const client = postgres(url, { max: 1 });
  const db = drizzle(client, { schema });

  try {
    const [existing] = await db
      .select({ id: schema.externalSystems.id, name: schema.externalSystems.name })
      .from(schema.externalSystems)
      .where(eq(schema.externalSystems.code, "PACKTRACK"));

    if (existing) {
      console.log(
        `[register-packtrack] PACKTRACK already registered: id=${existing.id} name="${existing.name}"`,
      );
      return;
    }

    const [created] = await db
      .insert(schema.externalSystems)
      .values({
        code: "PACKTRACK",
        name: "PackTrack",
        description:
          "Packaging procurement / receiving — owns supplier POs and box-level receipts. Sends receipts to Luma; Luma owns burn/consumption.",
        isActive: true,
      })
      .returning({ id: schema.externalSystems.id });

    if (!created) throw new Error("Insert returned no row");
    console.log(`[register-packtrack] PACKTRACK registered: id=${created.id}`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("[register-packtrack] failed:", err);
  process.exit(1);
});
