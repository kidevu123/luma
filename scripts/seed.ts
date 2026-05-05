// One-shot bootstrap seed. Idempotent: re-runs are no-ops.

import { db } from "../lib/db";
import { companies, users, machines, qrCards } from "../lib/db/schema";
import { hashPassword } from "../lib/auth";
import { sql } from "drizzle-orm";

async function main() {
  console.log("Seeding…");

  const existingCompany = await db.select().from(companies).limit(1);
  if (existingCompany.length === 0) {
    await db.insert(companies).values({
      name: "Haute Nutrition",
      timezone: "America/New_York",
    });
    console.log("  company: created Haute Nutrition");
  } else {
    console.log("  company: present");
  }

  const ownerEmail = process.env.SEED_ADMIN_EMAIL ?? "admin@luma";
  const ownerPassword = process.env.SEED_ADMIN_PASSWORD ?? "luma-admin";
  const existingOwner = await db
    .select()
    .from(users)
    .where(sql`lower(${users.email}) = lower(${ownerEmail})`);
  if (existingOwner.length === 0) {
    await db.insert(users).values({
      email: ownerEmail,
      passwordHash: await hashPassword(ownerPassword),
      role: "OWNER",
      mustChangePassword: true,
    });
    console.log(`  owner: created ${ownerEmail} (password: ${ownerPassword} — rotate on first login)`);
  } else {
    console.log(`  owner: present (${ownerEmail})`);
  }

  const existingMachines = await db.select().from(machines);
  if (existingMachines.length === 0) {
    await db.insert(machines).values([
      { name: "Machine 1", kind: "SEALING" },
      { name: "Machine 2", kind: "SEALING" },
    ]);
    console.log("  machines: created Machine 1 + Machine 2");
  } else {
    console.log(`  machines: ${existingMachines.length} present`);
  }

  const existingCards = await db.select().from(qrCards);
  if (existingCards.length === 0) {
    await db.insert(qrCards).values([1, 2, 3, 4, 5].map((n) => ({
      label: `Bag ${n}`,
      scanToken: `bag-dev-${n}`,
      status: "IDLE" as const,
    })));
    console.log("  qr_cards: created 5 dev cards (bag-dev-1..5)");
  } else {
    console.log(`  qr_cards: ${existingCards.length} present`);
  }

  console.log("Done.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
