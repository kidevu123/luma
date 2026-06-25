import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { zohoProductionOutputOps } from "@/lib/db/schema";
import { upsertConsolidatedProductionOutputOpForLot } from "@/lib/db/queries/zoho-production-output-consolidated";

const FINISHED_LOT_ID = "61c0ad45-dd1a-4764-b560-57291cf35022";
const OP_ID = "f0256ebc-5f3c-4d54-aff8-3e76228a3847";

async function main() {
  const upsert = await upsertConsolidatedProductionOutputOpForLot(
    FINISHED_LOT_ID,
    null,
    { previewRetry: true },
  );
  const [op] = await db
    .select({
      id: zohoProductionOutputOps.id,
      status: zohoProductionOutputOps.status,
      mappingBlockers: zohoProductionOutputOps.mappingBlockers,
      previewHttpStatus: zohoProductionOutputOps.previewHttpStatus,
      previewStatus: zohoProductionOutputOps.previewStatus,
      previewResponse: zohoProductionOutputOps.previewResponse,
      requestPayload: zohoProductionOutputOps.requestPayload,
    })
    .from(zohoProductionOutputOps)
    .where(eq(zohoProductionOutputOps.id, OP_ID))
    .limit(1);

  console.log(JSON.stringify({ upsert, op: op ?? null }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
