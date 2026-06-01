import type { BottleneckResult, MetricBundle } from "@/lib/production/types";

/** Serializable bundle for the live floor board (server → client). */
export type FloorProductionIntelligence = {
  dashboard: MetricBundle;
  bottleneck: BottleneckResult;
  queues: MetricBundle;
};
