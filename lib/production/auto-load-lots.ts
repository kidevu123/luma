import { db } from "@/lib/db";
import { packagingLots, packagingMaterials } from "@/lib/db/schema";
import { and, eq, asc } from "drizzle-orm";

export type AutoLoadedLot = {
  lotId: string;
  materialName: string;
  materialKind: string;
  qtyOnHand: number;
  boxNumber: string | null;
  supplierLotNumber: string | null;
};

// Maps station kind to the material kinds it auto-loads.
// Only unit-based materials are listed here — roll-based (PVC_ROLL, FOIL_ROLL)
// require physical mounting with tare weight and are loaded manually.
export const STATION_AUTO_MATERIAL_KINDS: Record<string, string[]> = {
  HANDPACK_BLISTER: ["BLISTER_CARD"],
  BOTTLE_HANDPACK: ["BOTTLE", "CAP"],
  BOTTLE_CAP_SEAL: ["INDUCTION_SEAL"],
};

export async function loadAutoLots(stationKind: string): Promise<AutoLoadedLot[]> {
  const kinds = STATION_AUTO_MATERIAL_KINDS[stationKind];
  if (!kinds || kinds.length === 0) return [];

  const isMaterialOnly = stationKind === "HANDPACK_BLISTER";

  const rows = await db
    .select({
      lotId: packagingLots.id,
      materialName: packagingMaterials.name,
      materialKind: packagingMaterials.kind,
      qtyOnHand: packagingLots.qtyOnHand,
      boxNumber: packagingLots.boxNumber,
      supplierLotNumber: packagingLots.supplierLotNumber,
      category: packagingMaterials.category,
    })
    .from(packagingLots)
    .innerJoin(packagingMaterials, eq(packagingMaterials.id, packagingLots.packagingMaterialId))
    .where(eq(packagingLots.status, "AVAILABLE"))
    .orderBy(asc(packagingLots.receivedAt));

  return rows
    .filter((r) => {
      if (!kinds.includes(r.materialKind)) return false;
      if (isMaterialOnly && r.category !== "MATERIAL") return false;
      return true;
    })
    .map((r) => ({
      lotId: r.lotId,
      materialName: r.materialName,
      materialKind: r.materialKind,
      qtyOnHand: r.qtyOnHand,
      boxNumber: r.boxNumber,
      supplierLotNumber: r.supplierLotNumber,
    }));
}
