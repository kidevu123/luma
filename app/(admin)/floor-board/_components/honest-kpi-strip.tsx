// Server wrapper — prefer ProductionIntelligenceStrip on the live
// floor board; this remains for pages that import HonestKpiStrip directly.

import { getFloorProductionIntelligence } from "@/lib/production/floor-production-intelligence";
import { ProductionIntelligenceStrip } from "./production-intelligence-strip";

export async function HonestKpiStrip() {
  const data = await getFloorProductionIntelligence();
  return <ProductionIntelligenceStrip data={data} />;
}
