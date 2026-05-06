// Snapshot file download. Owner-only. Streams the gzipped SQL
// dump as application/gzip with a Content-Disposition that asks
// the browser to save rather than render.

import { NextResponse } from "next/server";
import { join } from "node:path";
import { stat, readFile } from "node:fs/promises";
import { requireOwner } from "@/lib/auth-guards";

const STORAGE_ROOT = process.env.STORAGE_ROOT ?? "/data";
const SNAPSHOTS_DIR = join(STORAGE_ROOT, "snapshots");

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ filename: string }> },
): Promise<Response> {
  await requireOwner();
  const { filename } = await ctx.params;
  if (!/^[a-zA-Z0-9_.-]+\.sql\.gz$/.test(filename)) {
    return new NextResponse("Invalid filename.", { status: 400 });
  }
  const target = join(SNAPSHOTS_DIR, filename);
  let bytes: Buffer;
  try {
    bytes = await readFile(target);
  } catch {
    return new NextResponse("Not found.", { status: 404 });
  }
  const s = await stat(target).catch(() => null);
  return new NextResponse(bytes as unknown as BodyInit, {
    headers: {
      "Content-Type": "application/gzip",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Length": String(s?.size ?? bytes.byteLength),
      "Cache-Control": "no-store",
    },
  });
}
