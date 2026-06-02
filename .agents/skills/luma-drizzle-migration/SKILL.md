---
name: luma-drizzle-migration
description: Make Drizzle schema changes safe. Inspect journal + existing migrations first, additive-only, split enum ALTER from table DDL, mirror in lib/db/schema.ts, verify on staging.
---

# Luma Drizzle migrations

## When this skill applies

Any time you touch `drizzle/*.sql`, `drizzle/meta/_journal.json`, or
add tables / columns / enum values to `lib/db/schema.ts`.

## Audit before writing migrations

1. Read `drizzle/meta/_journal.json` — note the latest `idx` and
   `when` timestamp.
2. List `drizzle/*.sql` — confirm there's no existing migration for
   the change you're planning.
3. Inspect `lib/db/schema.ts` for the affected tables / enums. Many
   schema additions already exist in fragments.

## Migration number + journal `when`

- Use the **next unused** migration number (current latest +1). Never
  reuse, never skip ahead.
- The journal `when` must be **strictly greater** than the previous
  entry. Out-of-order timestamps silently skip migrations on populated
  DBs. Step the timestamp by 100_000_000 ms (~28 hours) to leave
  headroom for hot-fix migrations.
- Use `XXXX_descriptive_name.sql` format (zero-padded 4 digits).

## Additive-only rule

Migrations may:
- `CREATE TABLE IF NOT EXISTS`
- `ALTER TABLE ADD COLUMN IF NOT EXISTS`
- `CREATE INDEX IF NOT EXISTS`
- `ALTER TYPE ADD VALUE IF NOT EXISTS`
- Add `CHECK` constraints with a safe default

Migrations must NOT (without explicit owner approval):
- Drop tables, columns, or enums.
- Rename user-data columns.
- Change column types in a destructive way.
- Truncate or delete user data.
- Backfill from external sources without an approval comment.

## Enum gotcha — always split

`ALTER TYPE foo ADD VALUE 'BAR'` **silently rolls back** when batched
in the same migration as DDL that references the new value. The fix
is mandatory:

- Migration N: `ALTER TYPE foo ADD VALUE IF NOT EXISTS 'BAR'`.
  Single statement, nothing else.
- Migration N+1: table DDL that uses the new value.

The Drizzle pg migrator runs each `.sql` in its own transaction, so
the new enum value commits before N+1 runs.

## Schema mirror

After writing the migration, update `lib/db/schema.ts`:

- Add the new `pgTable` definition or extend the existing one.
- Add the new enum value to the `pgEnum(...)` array.
- Export the inferred type (`export type Foo = typeof foo.$inferSelect`).
- Add a doc comment naming the phase (`// COMMERCIAL-TRACE-2 — ...`).

## Tests

Every schema migration needs:

- A shape test in `lib/production/*.test.ts` that imports the new
  table / enum and asserts the expected columns and enum values are
  present.
- A migration-files test that asserts the SQL file exists and contains
  the expected `CREATE` / `ALTER` statements plus any CHECK constraints.
- A journal test asserting the new `idx` is registered.

## Staging verification

Before reporting done:

- Confirm health endpoint shows the new SHA.
- Run a `psql` query against staging confirming the table / column /
  enum value landed (use the recipes in `docs/handoff.md`).
- For CHECK constraints, query `pg_constraint` to confirm the
  expression is what you wrote.
- Never seed fake production data through a migration; QA fixtures
  live in `scripts/seed-*.ts` with a cleanup path.

## Final report must include

1. Migration number used (`0036_commercial_trace_schema`).
2. Tables / columns / enums added.
3. Tests added.
4. Staging verification proof (psql query + result).
5. Any rollback notes.
