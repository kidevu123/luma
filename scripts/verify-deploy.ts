// Deployment verification: compare local git HEAD against the running container
// via /api/health (runtime SHA), not the LXC checkout alone.
//
// Run from the repo root:
//   npm run verify:deploy
//   LUMA_HOST=http://192.168.1.134:3000 npm run verify:deploy
//
// Exits 1 when health is not ok or when the running SHA does not match local HEAD.

import { execSync } from "node:child_process";
import { evaluateDeployShaMatch } from "@/lib/deploy/verify-deploy-sha";

const host = process.env.LUMA_HOST ?? "http://192.168.1.134:3000";
const url = `${host}/api/health`;

async function main() {
  let localSha: string;
  try {
    localSha = execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
  } catch {
    console.error("Could not read local git HEAD. Are you in the repo root?");
    process.exit(1);
  }

  console.log(`Local HEAD : ${localSha.slice(0, 12)}`);
  console.log(`Health URL : ${url}`);
  console.log(
    "Note: compares git HEAD to the running app SHA from /api/health (not /opt/luma checkout alone).",
  );

  let data: { status: string; sha?: string; checks?: Record<string, string> };
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) {
      console.error(`Health endpoint returned HTTP ${res.status}`);
      process.exit(1);
    }
    data = (await res.json()) as typeof data;
  } catch (err) {
    console.error(`Could not reach ${url}: ${String(err)}`);
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

  const verdict = evaluateDeployShaMatch(localSha, remoteSha, data.status);
  if (!verdict.ok) {
    if (verdict.reason === "health_not_ok") {
      console.error(`Health status is not ok (${verdict.status}).`);
      process.exit(1);
    }
    console.error("DEPLOY DRIFT: running container SHA does not match local HEAD.");
    console.error(`  local HEAD (expected): ${localSha}`);
    console.error(`  /api/health (running):  ${remoteSha}`);
    console.error(
      "  On LXC: systemctl start luma-deploy.service (rebuilds when drift is detected).",
    );
    process.exit(1);
  }
  if (!verdict.comparable) {
    console.log("Remote is running a dev/local build — SHA compare skipped.");
    return;
  }

  console.log("Deployed SHA matches local HEAD.");
}

main().catch((err) => {
  console.error(String(err));
  process.exit(1);
});
