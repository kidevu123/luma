/** Deep links from floor board into /metrics sections and lanes. */

export type MetricsLane = "blister" | "card" | "bottle" | "packaging";

export type MetricsSection =
  | "overview"
  | "cycle-time"
  | "by-product"
  | "by-machine"
  | "by-station"
  | "operators"
  | "downtime"
  | "daily-throughput"
  | "material-burn";

const SECTION_HASH: Record<MetricsSection, string> = {
  overview: "",
  "cycle-time": "#cycle-time",
  "by-product": "#by-product",
  "by-machine": "#by-machine",
  "by-station": "#by-station",
  operators: "#operators",
  downtime: "#downtime",
  "daily-throughput": "#daily-throughput",
  "material-burn": "#material-burn",
};

export function metricsUrl(
  section: MetricsSection = "overview",
  days = 30,
): string {
  const base = `/metrics?days=${days}`;
  const hash = SECTION_HASH[section];
  return hash ? `${base}${hash}` : base;
}

export function metricsLaneUrl(lane: MetricsLane, days = 30): string {
  return `/metrics/${lane}?days=${days}`;
}

/** Map bottleneck / queue stage keys to lane deep-dive pages. */
export function stageKeyToMetricsLane(stageKey: string | null | undefined): MetricsLane | null {
  if (!stageKey) return null;
  const s = stageKey.toUpperCase();
  if (s.includes("BLISTER")) return "blister";
  if (s.includes("BOTTLE")) return "bottle";
  if (s.includes("PACKAGING") || s.includes("PACK")) return "packaging";
  if (s.includes("SEAL") || s.includes("STAGING") || s.includes("CARD")) return "card";
  return null;
}

export function bottleneckMetricsHref(stageKey: string | null | undefined): string {
  const lane = stageKeyToMetricsLane(stageKey);
  if (lane) return metricsLaneUrl(lane, 7);
  return metricsUrl("cycle-time", 7);
}

export const FLOOR_METRICS_QUICK_LINKS: Array<{
  label: string;
  section: MetricsSection;
  short?: string;
}> = [
  { label: "Cycle times", section: "cycle-time", short: "Cycle" },
  { label: "By product", section: "by-product", short: "Yield" },
  { label: "By machine", section: "by-machine", short: "Machines" },
  { label: "Operators", section: "operators", short: "Ops" },
  { label: "Downtime", section: "downtime", short: "Pause" },
  { label: "Throughput", section: "daily-throughput", short: "Daily" },
  { label: "Materials", section: "material-burn", short: "Mat." },
];
