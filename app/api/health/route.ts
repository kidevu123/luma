import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { sql } from "drizzle-orm";
import { getPackageVersion } from "@/lib/build-metadata";

export const dynamic = "force-dynamic";

export async function GET() {
  const t0 = Date.now();
  let dbOk = false;
  try {
    await db.execute(sql`SELECT 1`);
    dbOk = true;
  } catch {
    dbOk = false;
  }
  return NextResponse.json({
    status: dbOk ? "ok" : "degraded",
    checks: { app: "ok", db: dbOk ? "ok" : "fail" },
    // VERSION-CONTRACT-v1.4.0 — single source of truth for the
    // operator-facing version is package.json read through
    // getPackageVersion(). The admin footer, floor footer, settings
    // page, and this endpoint all use the same source so the badge
    // can never drift from the API response. Guard tests in
    // lib/version.contract.test.ts enforce 1.x.y semver and pin
    // CHANGELOG / health consistency.
    version: getPackageVersion(),
    sha: process.env.BUILD_GIT_SHA ?? "dev",
    elapsedMs: Date.now() - t0,
  });
}
