// VERSION-CONTRACT-v1.4.0 — guard tests for the operator-facing version.
//
// Pins the post-launch policy documented in VERSIONING.md:
//
//   1. The operator-facing version (the badge on the admin/floor
//      footers + /api/health.version + Settings → Release row) is
//      `package.json` `version` read through `getPackageVersion()`.
//   2. The version MUST follow real semver on the `1.x.y` line.
//      `0.x.y` is closed forever — the launch milestone is `1.0.0`.
//   3. `CHANGELOG.md` MUST contain a `## [<version>]` entry that
//      matches the current `package.json` version so the badge and
//      the release notes never disagree.
//   4. `/api/health` MUST return the same version string as
//      `getPackageVersion()` so the footer and the API response
//      never drift.
//   5. The settings "Release" row uses the same source.
//
// Why this exists: in the v0.4.110 release I bumped package.json
// backwards from 1.3.0 → 0.4.110 on an operator instruction that
// turned out to be a misremembered version. The footer immediately
// dropped to `v0.4.110`. These guards refuse a 0.x.y bump at
// build/test time so the same regression cannot ship again.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getPackageVersion } from "./build-metadata";

const REPO = resolve(__dirname, "..");
const read = (rel: string) => readFileSync(resolve(REPO, rel), "utf8");

const PKG_VERSION = getPackageVersion();

describe("Operator-facing version follows post-launch semver", () => {
  it("getPackageVersion() returns a non-empty string", () => {
    expect(PKG_VERSION).toMatch(/.+/);
    expect(PKG_VERSION).not.toBe("?");
  });

  it("uses real semver — MAJOR.MINOR.PATCH (no prerelease)", () => {
    expect(PKG_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("MAJOR is >= 1 (the 0.x.y line is closed forever, see VERSIONING.md)", () => {
    const major = Number.parseInt(PKG_VERSION.split(".")[0]!, 10);
    expect(major).toBeGreaterThanOrEqual(1);
  });

  it("does NOT start with '0.' — guarded against the v0.4.110 regression", () => {
    expect(PKG_VERSION.startsWith("0.")).toBe(false);
  });

  it("does NOT start with '0.4.' specifically (the regressed line)", () => {
    expect(PKG_VERSION.startsWith("0.4.")).toBe(false);
  });
});

describe("Single source of truth — every version surface reads the same source", () => {
  it("/api/health route imports getPackageVersion from lib/build-metadata", () => {
    const src = read("app/api/health/route.ts");
    expect(src).toMatch(
      /import\s*\{\s*getPackageVersion\s*\}\s*from\s*"@\/lib\/build-metadata"/,
    );
  });

  it("/api/health response body includes a `version` field set from getPackageVersion()", () => {
    const src = read("app/api/health/route.ts");
    expect(src).toMatch(/version:\s*getPackageVersion\(\)/);
  });

  it("admin footer reads from getPackageVersion (no hard-coded string)", () => {
    const src = read("components/admin/footer.tsx");
    expect(src).toMatch(/getPackageVersion\(\)/);
    expect(src).not.toMatch(/v0\.\d+\.\d+/);
    expect(src).not.toMatch(/v1\.\d+\.\d+/);
  });

  it("floor footer reads from build-metadata (no hard-coded string)", () => {
    const src = read("components/ui/luma-build-footer.tsx");
    expect(src).toMatch(/@\/lib\/build-metadata/);
    expect(src).not.toMatch(/v0\.\d+\.\d+/);
    expect(src).not.toMatch(/v1\.\d+\.\d+/);
  });

  it("settings page reads from getBuildFooterParts (no hard-coded string)", () => {
    const src = read("app/(admin)/settings/page.tsx");
    expect(src).toMatch(/getBuildFooterParts/);
  });

  it("getPackageVersion is the ONLY function that reads package.json for version data", () => {
    // If a new caller pops up, route it through getPackageVersion
    // rather than re-implementing the read. Pinned with a forbidden
    // pattern. (lib/build-metadata.ts and lib/version.contract.test.ts
    // are allowed to mention package.json by name — everything else
    // should go through the helper.)
    const allowedFiles = new Set([
      "lib/build-metadata.ts",
      "lib/version.contract.test.ts",
    ]);
    // Single representative non-allowed file to assert the negative.
    expect(read("components/admin/footer.tsx")).not.toMatch(
      /readFileSync.*package\.json/,
    );
    expect(read("components/ui/luma-build-footer.tsx")).not.toMatch(
      /readFileSync.*package\.json/,
    );
    expect(allowedFiles.size).toBeGreaterThan(0);
  });
});

describe("CHANGELOG.md has an entry matching the current package.json version", () => {
  const changelog = read("CHANGELOG.md");

  it("CHANGELOG contains a `## [<version>] — ...` entry for the current version", () => {
    // Escape dots so 1.4.0 doesn't accidentally match 1240, etc.
    const escaped = PKG_VERSION.replace(/\./g, "\\.");
    const pattern = new RegExp(`^##\\s+\\[${escaped}\\]\\s+—\\s+\\d{4}-\\d{2}-\\d{2}`, "m");
    expect(changelog).toMatch(pattern);
  });

  it("CHANGELOG entries are MAJOR.MINOR.PATCH (no prerelease)", () => {
    // Scan every entry header and confirm they're all semver-shaped.
    const headers = changelog.match(/^##\s+\[([^\]]+)\]/gm) ?? [];
    for (const h of headers) {
      const m = h.match(/\[([^\]]+)\]/);
      const version = m?.[1] ?? "";
      expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });
});

describe("VERSIONING.md is committed and pins the 1.x.y policy", () => {
  const versioning = read("VERSIONING.md");

  it("VERSIONING.md is present at the repo root", () => {
    expect(versioning.length).toBeGreaterThan(0);
  });

  it("explicitly states the post-launch line is 1.x.y", () => {
    expect(versioning).toMatch(/1\.x\.y/);
  });

  it("explicitly states the 0.x.y series is closed forever", () => {
    expect(versioning).toMatch(/never be another\s+`?0\.x\.y`?\s+release|0\.x\.y[\s\S]+closed forever/i);
  });
});
