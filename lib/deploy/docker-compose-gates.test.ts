import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const GATE_VARS = [
  "ZOHO_PRODUCTION_OUTPUT_PERSIST_ENABLED",
  "ZOHO_PRODUCTION_OUTPUT_PREVIEW_ENABLED",
  "ZOHO_PRODUCTION_OUTPUT_COMMIT_ENABLED",
  "ZOHO_PRODUCTION_OUTPUT_AUTO_QUEUE",
  "ZOHO_ALLOW_SCRIPT_COMMIT_BYPASS",
  "ZOHO_DRY_RUN_WRITES_ENABLED",
] as const;

describe("docker-compose production-output gates", () => {
  const compose = readFileSync(join(process.cwd(), "docker-compose.yml"), "utf8");

  for (const key of GATE_VARS) {
    it(`forwards ${key} to the app service`, () => {
      expect(compose).toMatch(new RegExp(`${key}:\\s*\\$\\{${key}`));
    });
  }
});
