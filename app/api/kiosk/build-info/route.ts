import { NextResponse } from "next/server";
import { getBuildFooterParts } from "@/lib/build-metadata";

export const dynamic = "force-dynamic";

/** Lightweight SHA endpoint for floor kiosk deploy-drift reload. */
export async function GET() {
  const parts = getBuildFooterParts();
  return NextResponse.json({
    sha: parts.shortSha,
  });
}
