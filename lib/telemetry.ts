// OpenTelemetry meter + structured logger. Same shape as the payroll
// platform so Grafana dashboards translate one-to-one.

import { metrics, trace, type Tracer } from "@opentelemetry/api";

export function getTracer(name = "luma"): Tracer {
  return trace.getTracer(name);
}

const meter = metrics.getMeter("luma");

// Domain metrics — production-floor specific.
export const workflowEventsTotal = meter.createCounter("luma.workflow.events", {
  description: "Workflow events emitted, labeled by event_type",
});

export const bagsFinalizedTotal = meter.createCounter("luma.bags.finalized", {
  description: "Workflow bags finalized, labeled by product",
});

export const machineBusySeconds = meter.createCounter(
  "luma.machine.busy_seconds",
  { description: "Cumulative machine busy time", unit: "s" },
);

export const materialConsumedTotal = meter.createCounter(
  "luma.material.consumed",
  { description: "Packaging material qty consumed by material+kind" },
);

export const errorEvents = meter.createCounter("luma.errors", {
  description: "Errors emitted via logger.error()",
});

// Build/deploy info — observable gauge so Grafana shows current SHA
// without traffic.
const buildInfo = meter.createObservableGauge("luma.build.info", {
  description: "Build/deploy info (1) with sha + branch labels",
});
const startTime = meter.createObservableGauge(
  "luma.process.start_time_seconds",
  { description: "Unix epoch seconds when this process started", unit: "s" },
);
const PROCESS_START = Math.floor(Date.now() / 1000);
buildInfo.addCallback((result) =>
  result.observe(1, {
    sha: process.env.BUILD_GIT_SHA ?? "dev",
    branch: process.env.BUILD_GIT_BRANCH ?? "unknown",
    version: process.env.npm_package_version ?? "0.0.0",
  }),
);
startTime.addCallback((result) => result.observe(PROCESS_START));

// Prime counters so series appear at /metrics with zero before traffic.
workflowEventsTotal.add(0, { event_type: "_init" });
bagsFinalizedTotal.add(0, { product_id: "_init" });
materialConsumedTotal.add(0, { material_id: "_init" });
errorEvents.add(0, { source: "_init" });

export const logger = {
  debug: (...args: unknown[]) => log("debug", args),
  info: (...args: unknown[]) => log("info", args),
  warn: (...args: unknown[]) => log("warn", args),
  error: (...args: unknown[]) => {
    log("error", args);
    try {
      const first = args[0];
      const source =
        first && typeof first === "object" && "source" in first
          ? String((first as { source?: unknown }).source ?? "app")
          : "app";
      errorEvents.add(1, { source });
    } catch {
      /* SDK may be uninitialized in tests */
    }
  },
};

function log(level: "debug" | "info" | "warn" | "error", args: unknown[]) {
  const [first, second] = args;
  const msg =
    typeof first === "string"
      ? first
      : typeof second === "string"
        ? second
        : "";
  const ctx = typeof first === "object" && first !== null ? first : undefined;
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    msg,
    ...(ctx as object | undefined),
  });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}
