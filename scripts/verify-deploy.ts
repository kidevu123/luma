// Deployment verification: compare local git HEAD against the running container.
//
// Run from the repo root:
//   npm run verify:deploy
//   # or with a custom host
//   LUMA_HOST=http://192.168.1.134:3000 npm run verify:deploy

import { execSync } from "node:child_process";

const host = process.env.LUMA_HOST ?? "http://192.168.1.134:3000";
const url = `${host}/api/health`;

let localSha: string;
try {
  localSha = execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
} catch {
  console.error("❌  Could not read local git HEAD. Are you in the repo root?");
  process.exit(1);
}

console.log(`Local HEAD : ${localSha.slice(0, 12)}`);
console.log(`Health URL : ${url}`);

let data: { status: string; sha?: string; checks?: Record<string, string> };
try {
  const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
  if (!res.ok) {
    console.error(`❌  Health endpoint returned HTTP ${res.status}`);
    process.exit(1);
  }
  data = (await res.json()) as typeof data;
} catch (err) {
  console.error(`❌  Could not reach ${url}: ${String(err)}`);
  process.exit(1);
}

const remoteSha = data.sha ?? "dev";
console.log(`Remote SHA : ${remoteSha.slice(0, 12)}`);
console.log(`App status : ${data.status}`);
if (data.checks) {
  for (const [k, v] of Object.entries(data.checks)) {
    console.log(`  ${k.padEnd(8)}: ${v}`);
  }
}

const shaShort = (s: string) => s.slice(0, 12);
if (remoteSha === "dev" || remoteSha === "local") {
  console.log("⚠️   Remote is running a dev build — no SHA to compare.");
} else if (shaShort(remoteSha) === shaShort(localSha)) {
  console.log("✅  Deployed SHA matches local HEAD.");
} else {
  console.log("⚠️   SHA mismatch — deploy may be in progress or branch diverged.");
  console.log(`    local : ${localSha}`);
  console.log(`    remote: ${remoteSha}`);
}
