"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { requireOwner } from "@/lib/auth-guards";
import { db } from "@/lib/db";
import { zohoCredentials, companies } from "@/lib/db/schema";
import { writeAudit } from "@/lib/db/audit";
import {
  checkZohoGatewayHealth,
  deriveZohoReadiness,
  fetchZohoBrandStatus,
} from "@/lib/integrations/zoho/gateway";

const schema = z.object({
  organizationId: z.string().min(1).max(40),
  clientId: z.string().min(1).max(120),
  clientSecret: z.string().max(200).optional(),
  refreshToken: z.string().max(400).optional(),
  dataCenter: z.enum(["us", "eu", "in", "au", "jp"]),
  warehouseId: z.string().max(80).optional(),
  isActive: z.coerce.boolean().optional(),
});

async function getCompanyId(): Promise<string> {
  const [c] = await db.select({ id: companies.id }).from(companies).limit(1);
  if (!c) throw new Error("No company configured.");
  return c.id;
}

export async function saveZohoCredentialsAction(formData: FormData) {
  const actor = await requireOwner();
  const parsed = schema.safeParse({
    organizationId: formData.get("organizationId"),
    clientId: formData.get("clientId"),
    clientSecret: formData.get("clientSecret") || undefined,
    refreshToken: formData.get("refreshToken") || undefined,
    dataCenter: formData.get("dataCenter") || "us",
    warehouseId: formData.get("warehouseId") || undefined,
    isActive: formData.get("isActive") === "on",
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }
  try {
    const companyId = await getCompanyId();
    const [existing] = await db
      .select()
      .from(zohoCredentials)
      .where(eq(zohoCredentials.companyId, companyId));
    if (existing) {
      await db
        .update(zohoCredentials)
        .set({
          organizationId: parsed.data.organizationId,
          clientId: parsed.data.clientId,
          // Only overwrite secret/refresh when the operator typed
          // something — otherwise they're masked in the UI and we
          // keep the stored values.
          ...(parsed.data.clientSecret
            ? { clientSecret: parsed.data.clientSecret }
            : {}),
          ...(parsed.data.refreshToken
            ? { refreshToken: parsed.data.refreshToken, accessToken: null, accessTokenExpiresAt: null }
            : {}),
          dataCenter: parsed.data.dataCenter,
          warehouseId: parsed.data.warehouseId ?? null,
          isActive: parsed.data.isActive ?? true,
          updatedById: actor.id,
          updatedAt: new Date(),
        })
        .where(eq(zohoCredentials.id, existing.id));
    } else {
      if (!parsed.data.clientSecret || !parsed.data.refreshToken) {
        return { error: "Client secret + refresh token both required on first save." };
      }
      await db.insert(zohoCredentials).values({
        companyId,
        organizationId: parsed.data.organizationId,
        clientId: parsed.data.clientId,
        clientSecret: parsed.data.clientSecret,
        refreshToken: parsed.data.refreshToken,
        dataCenter: parsed.data.dataCenter,
        warehouseId: parsed.data.warehouseId ?? null,
        isActive: parsed.data.isActive ?? true,
        updatedById: actor.id,
      });
    }
    await writeAudit({
      actorId: actor.id,
      actorRole: actor.role,
      action: "zoho.credentials.update",
      targetType: "ZohoCredential",
      targetId: companyId,
      after: {
        organizationId: parsed.data.organizationId,
        dataCenter: parsed.data.dataCenter,
        warehouseId: parsed.data.warehouseId ?? null,
        isActive: parsed.data.isActive ?? true,
      },
    });
    revalidatePath("/settings/zoho");
    return { ok: true as const };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Save failed." };
  }
}

export async function testZohoConnectionAction() {
  await requireOwner();
  try {
    const health = await checkZohoGatewayHealth();
    const shouldProbeBrand = health.status === "CONNECTED";
    const brand = shouldProbeBrand ? await fetchZohoBrandStatus() : null;
    const { readiness, message } = deriveZohoReadiness({ health, brand });

    if (readiness !== "READY_FOR_DRY_RUN") {
      return { error: message };
    }

    const selected =
      brand && (brand.kind === "OK" || brand.kind === "NEEDS_REAUTH")
        ? brand.brand
        : null;
    if (!selected) {
      return { error: message };
    }

    return {
      ok: true as const,
      organizationName: selected.brandKey,
      organizationId: selected.organizationId ?? selected.brandKey,
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Test failed." };
  }
}
