// Shared build/version metadata for footers (admin + floor).

import { readFileSync } from "fs";
import path from "path";

export function getPackageVersion(): string {
  try {
    const raw = readFileSync(path.join(process.cwd(), "package.json"), "utf-8");
    const pkg = JSON.parse(raw) as { version?: string };
    return pkg.version ?? "?";
  } catch {
    return "?";
  }
}

export type BuildFooterParts = {
  version: string;
  shortSha: string;
  branch: string | null;
  buildDate: string | null;
};

/** Version + git metadata for compact footers. */
export function getBuildFooterParts(): BuildFooterParts {
  const sha = process.env.BUILD_GIT_SHA;
  const branch = process.env.BUILD_GIT_BRANCH ?? null;
  const rawBuildAt = process.env.BUILD_AT;
  const buildDate =
    rawBuildAt && rawBuildAt !== "unknown" ? rawBuildAt.slice(0, 10) : null;
  return {
    version: getPackageVersion(),
    shortSha: sha ? sha.slice(0, 7) : "local",
    branch,
    buildDate,
  };
}

/** Floor-style single-line label: `Luma · v0.4.58 · e115373 · main` */
export function formatFloorBuildFooterLabel(parts?: BuildFooterParts): string {
  const p = parts ?? getBuildFooterParts();
  const branch = p.branch ? ` · ${p.branch}` : "";
  return `Luma · v${p.version} · ${p.shortSha}${branch}`;
}
