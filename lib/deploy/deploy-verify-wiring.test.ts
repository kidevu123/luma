import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("DEPLOY-VERIFY-1 · deploy drift guards", () => {
  const deploySh = readFileSync(
    join(process.cwd(), "deploy/lxc/luma-deploy.sh"),
    "utf8",
  );
  const deployService = readFileSync(
    join(process.cwd(), "deploy/lxc/luma-deploy.service"),
    "utf8",
  );
  const verifySrc = readFileSync(
    join(process.cwd(), "scripts/verify-deploy.ts"),
    "utf8",
  );
  const smokeSrc = readFileSync(
    join(process.cwd(), "scripts/smoke-authenticated-routes.ts"),
    "utf8",
  );

  it("deploy script rebuilds on git change, drift, or unknown running SHA", () => {
    expect(deploySh).toMatch(/docker compose up -d --build/);
    expect(deploySh).toMatch(/"\$before" != "\$after"/);
    expect(deploySh).toMatch(/"\$running" != "\$after"/);
    expect(deploySh).toMatch(/running SHA unknown/);
    expect(deploySh).toMatch(/api\/health/);
  });

  it("deploy service invokes the repo deploy script", () => {
    expect(deployService).toMatch(/luma-deploy\.sh/);
    expect(deploySh).toMatch(/docker compose up -d --build/);
  });

  it("verify-deploy exits non-zero on SHA mismatch", () => {
    expect(verifySrc).toMatch(/evaluateDeployShaMatch/);
    expect(verifySrc).toMatch(/DEPLOY DRIFT/);
    expect(verifySrc).toMatch(/process\.exit\(1\)/);
    expect(verifySrc).toMatch(/running app SHA from \/api\/health/);
  });

  it("auth smoke includes workflow-submissions", () => {
    expect(smokeSrc).toMatch(
      /\{\s*group:\s*"Operations",\s*path:\s*"\/workflow-submissions"\s*\}/,
    );
  });
});
