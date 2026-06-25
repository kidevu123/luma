/** Static source-scan helpers for guard/contract tests. Test-only — not imported by runtime code. */

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export const REPO_ROOT = resolve(import.meta.dirname, "..", "..");

const DEFAULT_INCLUDES = ["*.ts", "*.tsx"];
const DEFAULT_EXCLUDE_FRAGMENTS = ["node_modules/", ".next/", "coverage/"];

export type GrepRepoOptions = {
  includes?: string[];
  excludePathFragments?: string[];
};

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function parseGrepLines(out: string, excludeFragments: string[]): string[] {
  return out
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .filter((line) => !excludeFragments.some((frag) => line.includes(frag)))
    .map((line) => (line.startsWith("./") ? line.slice(2) : line));
}

function runGrep(pattern: string, includes: string[], excludeFragments: string[]): string[] {
  const includeFlags = includes.map((glob) => `--include=${glob}`).join(" ");
  let out = "";
  try {
    out = execSync(`grep -rEn ${shellSingleQuote(pattern)} ${includeFlags} .`, {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch (err) {
    const e = err as { status?: number; stdout?: string };
    if (e.status === 1 && !e.stdout) return [];
    out = e.stdout ?? "";
  }
  return parseGrepLines(out, excludeFragments);
}

/** Read a repo-relative source file as UTF-8 text. */
export function readRepoSource(relPath: string): string {
  return readFileSync(resolve(REPO_ROOT, relPath), "utf8");
}

/** Run `grep -rEn` from the repo root; returns `path:line:content` lines. */
export function grepRepo(pattern: string, opts?: GrepRepoOptions): string[] {
  return runGrep(
    pattern,
    opts?.includes ?? DEFAULT_INCLUDES,
    opts?.excludePathFragments ?? DEFAULT_EXCLUDE_FRAGMENTS,
  );
}

/** Word-boundary symbol search used by forbidden-reintroduction guards. */
export function grepRepoSymbol(symbol: string, opts?: GrepRepoOptions): string[] {
  return grepRepo(`\\b${symbol}\\b`, {
    includes: ["*.ts", "*.tsx", "*.mjs"],
    ...opts,
  });
}
