// app/api/dashboard-config/route.ts
import { requireSession } from "@/lib/auth-guards";
import { db } from "@/lib/db";
import { userDashboardConfig } from "@/lib/db/schema";
import { DEFAULT_LAYOUT } from "@/lib/floor-command/types";
import { and, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

const BOARD_KEY = "floor-command";

const WidgetLayoutSchema = z.object({
  key: z.string(),
  x: z.number().int().min(0),
  y: z.number().int().min(0),
  w: z.number().int().min(1),
  h: z.number().int().min(1),
  config: z
    .object({ stationId: z.string().optional() })
    .optional(),
});

const PutBodySchema = z.object({
  layout: z.array(WidgetLayoutSchema).min(1).max(20),
});

export async function GET() {
  const user = await requireSession();

  const existing = await db
    .select({ layoutJson: userDashboardConfig.layoutJson })
    .from(userDashboardConfig)
    .where(
      and(
        eq(userDashboardConfig.userId, user.id),
        eq(userDashboardConfig.boardKey, BOARD_KEY),
      ),
    )
    .limit(1);

  const layout = existing[0]?.layoutJson ?? DEFAULT_LAYOUT;
  return NextResponse.json({ layout });
}

export async function PUT(req: NextRequest) {
  const user = await requireSession();
  const body = await req.json();
  const parsed = PutBodySchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid layout" }, { status: 400 });
  }

  await db
    .insert(userDashboardConfig)
    .values({
      userId: user.id,
      boardKey: BOARD_KEY,
      layoutJson: parsed.data.layout,
    })
    .onConflictDoUpdate({
      target: [userDashboardConfig.userId, userDashboardConfig.boardKey],
      set: {
        layoutJson: parsed.data.layout,
        updatedAt: new Date(),
      },
    });

  return NextResponse.json({ ok: true });
}
