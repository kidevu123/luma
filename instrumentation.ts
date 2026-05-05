// Next.js instrumentation hook — registers OTel SDK + Prometheus
// scrape endpoint on port 9464. Same pattern as payroll-rebuild so
// the existing Prometheus collector on LXC 112 just adds a scrape job.

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // Hydrate BUILD_GIT_SHA from /app/.git-sha if not set.
  if (!process.env.BUILD_GIT_SHA) {
    try {
      const fs = await import("node:fs");
      const sha = fs.readFileSync("/app/.git-sha", "utf8").trim();
      if (sha) process.env.BUILD_GIT_SHA = sha;
    } catch {
      /* dev environments — file absent */
    }
  }

  const exporterUrl = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  const headers = parseHeaders(process.env.OTEL_EXPORTER_OTLP_HEADERS);
  const promPort = Number(process.env.OTEL_PROMETHEUS_PORT ?? 9464);
  const promHost = process.env.OTEL_PROMETHEUS_HOST ?? "0.0.0.0";

  const { NodeSDK } = await import("@opentelemetry/sdk-node");
  const { Resource } = await import("@opentelemetry/resources");

  const resource = new Resource({
    "service.name": process.env.OTEL_SERVICE_NAME ?? "luma",
    "service.version": process.env.npm_package_version ?? "0.0.0",
    "deployment.environment":
      process.env.OTEL_DEPLOYMENT_ENVIRONMENT ??
      process.env.NODE_ENV ??
      "production",
  });

  const { PrometheusExporter } = await import(
    "@opentelemetry/exporter-prometheus"
  );
  const prometheusExporter = new PrometheusExporter({
    port: promPort,
    host: promHost,
    endpoint: "/metrics",
  });

  let traceExporter:
    | import("@opentelemetry/sdk-trace-base").SpanExporter
    | undefined;
  if (exporterUrl) {
    const { OTLPTraceExporter } = await import(
      "@opentelemetry/exporter-trace-otlp-http"
    );
    traceExporter = new OTLPTraceExporter({
      url: `${trim(exporterUrl)}/v1/traces`,
      headers,
    });
  }

  const { HttpInstrumentation } = await import(
    "@opentelemetry/instrumentation-http"
  );
  const { PgInstrumentation } = await import(
    "@opentelemetry/instrumentation-pg"
  );

  const sdkConfig = {
    resource,
    ...(traceExporter ? { traceExporter } : {}),
    metricReader: prometheusExporter,
    instrumentations: [
      new HttpInstrumentation({
        ignoreIncomingRequestHook: (req) =>
          (req.url ?? "").startsWith("/metrics"),
      }),
      new PgInstrumentation({ enhancedDatabaseReporting: false }),
    ],
  };

  const sdk = new NodeSDK(
    sdkConfig as unknown as ConstructorParameters<typeof NodeSDK>[0],
  );
  sdk.start();

  // Eager-load telemetry so meter primings + observable callbacks
  // register before the first request.
  await import("@/lib/telemetry");
}

function parseHeaders(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  const out: Record<string, string> = {};
  for (const pair of raw.split(",")) {
    const [k, ...rest] = pair.split("=");
    if (!k || rest.length === 0) continue;
    out[k.trim()] = rest.join("=").trim();
  }
  return out;
}

function trim(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}
