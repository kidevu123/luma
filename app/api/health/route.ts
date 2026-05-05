import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { sql } from "drizzle-orm";

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
    sha: process.env.BUILD_GIT_SHA ?? "dev",
    elapsedMs: Date.now() - t0,
  });
}
