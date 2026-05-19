// Emergency admin password reset.
// Usage: tsx scripts/reset-admin-password.ts [new-password]
// Default new password: luma-admin

import { db } from "../lib/db";
import { users } from "../lib/db/schema";
import { hashPassword } from "../lib/auth";
import { sql } from "drizzle-orm";

const TARGET_EMAIL = process.env.RESET_EMAIL ?? "admin@luma";
const NEW_PASSWORD = process.argv[2] ?? "luma-admin";

async function main() {
  const hash = await hashPassword(NEW_PASSWORD);
  const result = await db
    .update(users)
    .set({ passwordHash: hash, disabledAt: null })
    .where(sql`lower(${users.email}) = lower(${TARGET_EMAIL})`)
    .returning({ id: users.id, email: users.email });

  if (result.length === 0) {
    console.error(`No user found with email: ${TARGET_EMAIL}`);
    console.error("Run: tsx scripts/seed.ts  to create the initial admin user.");
    process.exit(1);
  }

  console.log(`Password reset for ${result[0]!.email} (id: ${result[0]!.id})`);
  console.log(`New password: ${NEW_PASSWORD}`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
