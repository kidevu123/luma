export default function Home() {
  return (
    <main className="min-h-dvh flex items-center justify-center p-8">
      <div className="max-w-md w-full text-center space-y-3">
        <h1 className="text-4xl font-semibold tracking-tight">Luma</h1>
        <p className="text-sm text-text-muted">
          Production-floor traceability — bootstrapping. Six bounded contexts
          live: master data, inbound, batches, production events, output,
          read models. Floor + admin UIs land next.
        </p>
        <p className="text-xs text-text-subtle">
          Build {process.env.BUILD_GIT_SHA?.slice(0, 7) ?? "dev"}
        </p>
      </div>
    </main>
  );
}
