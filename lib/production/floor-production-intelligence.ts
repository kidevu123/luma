// Live-floor production intelligence bundle. Loads the canonical
// metric API once per /floor-board request so the client strip never
// recomputes numbers.

import {
  deriveBottleneck,
  deriveDashboardMetrics,
  deriveQueueAging,
} from "@/lib/production/metrics";
import type { MetricBundle } from "@/lib/production/types";
import type { FloorProductionIntelligence } from "@/lib/production/floor-production-intelligence-types";

export type { FloorProductionIntelligence } from "@/lib/production/floor-production-intelligence-types";

/** Strip internal / debug keys from dashboard bundle before serializing. */
function cleanBundle(bundle: MetricBundle): MetricBundle {
  const out: MetricBundle = {};
  for (const [k, v] of Object.entries(bundle)) {
    if (k.startsWith("_")) continue;
    out[k] = v;
  }
  return out;
}

export async function getFloorProductionIntelligence(): Promise<FloorProductionIntelligence> {
  const [dashboard, bottleneck, queues] = await Promise.all([
    deriveDashboardMetrics(),
    deriveBottleneck(),
    deriveQueueAging(),
  ]);
  return {
    dashboard: cleanBundle(dashboard),
    bottleneck,
    queues,
  };
}
