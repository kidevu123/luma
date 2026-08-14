// The client barrel's one invariant: it must not reach the database.
//
// A `"use client"` file importing something that transitively imports
// `@/lib/db` puts the Postgres driver in a browser bundle, and the Next
// build fails outright (`Can't resolve 'perf_hooks'`). That failure is
// loud but late — it shows up in `npm run build`, not in the suite — so
// this walks the import graph and says which edge broke it.

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "fs";
import { join, dirname, resolve } from "path";

const REPO_ROOT = join(__dirname, "..", "..", "..");
const ENTRY = join(__dirname, "client.ts");

/** Runtime (value) imports only — `import type` is erased by the
 *  compiler and cannot pull anything into a bundle, which is exactly why
 *  client.ts is allowed to re-export a type from a server module. */
function runtimeImportSpecifiers(src: string): string[] {
  const out: string[] = [];
  const re = /(?:^|\n)\s*(?:import|export)\s+(?!type\b)([\s\S]*?)from\s+["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const clause = m[1] ?? "";
    const spec = m[2];
    if (!spec) continue;
    // `export { type A, type B } from "..."` is also fully erased.
    const named = clause.match(/\{([\s\S]*)\}/)?.[1];
    if (named != null && named.trim() !== "") {
      const items = named
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s !== "");
      if (items.length > 0 && items.every((s) => s.startsWith("type "))) continue;
    }
    out.push(spec);
  }
  return out;
}

/** The module literals that mean "this cannot run in a browser".
 *
 *  `@/lib/db` is the usual door, but it is not the only one: a module
 *  could import the `postgres` driver directly, and drizzle's SUBPATHS
 *  (drizzle-orm/pg-core, drizzle-orm/postgres-js) pull schema builders
 *  and dialect code that have no business in a tablet bundle. Bare
 *  "drizzle-orm" is deliberately NOT flagged — it is the tree-shakeable
 *  expression helpers (eq, and, sql) and nothing more. */
function isServerOnlySpecifier(spec: string): boolean {
  if (spec === "@/lib/db" || spec.startsWith("@/lib/db/")) return true;
  if (spec === "postgres" || spec.startsWith("postgres/")) return true;
  if (spec.startsWith("drizzle-orm/")) return true;
  return false;
}

function resolveSpecifier(fromFile: string, spec: string): string | null {
  let base: string | null = null;
  if (spec.startsWith("@/")) base = join(REPO_ROOT, spec.slice(2));
  else if (spec.startsWith(".")) base = resolve(dirname(fromFile), spec);
  else return null; // node_modules — not ours to police
  for (const candidate of [
    `${base}.ts`,
    `${base}.tsx`,
    join(base, "index.ts"),
    join(base, "index.tsx"),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

describe("lib/production/engine/client.ts — client-safe barrel", () => {
  it("reaches no module that imports the database, the driver, or a drizzle subpath", () => {
    const seen = new Set<string>();
    const offenders: string[] = [];
    const walk = (file: string, trail: string[]): void => {
      if (seen.has(file)) return;
      seen.add(file);
      const src = readFileSync(file, "utf8");
      for (const spec of runtimeImportSpecifiers(src)) {
        if (isServerOnlySpecifier(spec)) {
          offenders.push([...trail, file, spec].join("\n  -> "));
          continue;
        }
        const next = resolveSpecifier(file, spec);
        if (next) walk(next, [...trail, file]);
      }
    };
    walk(ENTRY, []);
    expect(offenders).toEqual([]);
    // Non-vacuous: the walk must actually have visited the graph.
    expect(seen.size).toBeGreaterThan(5);
  });

  it("flags the server-only module literals it is supposed to catch", () => {
    // Guards the guard: a typo in isServerOnlySpecifier would make the
    // test above pass by never matching anything.
    for (const spec of [
      "@/lib/db",
      "@/lib/db/schema",
      "postgres",
      "drizzle-orm/pg-core",
    ]) {
      expect(isServerOnlySpecifier(spec)).toBe(true);
    }
    for (const spec of ["drizzle-orm", "react", "./types"]) {
      expect(isServerOnlySpecifier(spec)).toBe(false);
    }
  });

  it("still exports what the mounted client components import", () => {
    const src = readFileSync(ENTRY, "utf8");
    for (const name of [
      "assembleCompletionInputs",
      "autoProductSubmission",
      "helpChecklistForView",
      "operatorMaterialLinks",
      "partialScreenFor",
      "REPORT_PROBLEM_CATEGORY_LAYOUT",
      "reportProblemRouteFor",
      "StationView",
      "CompletionInput",
    ]) {
      expect(src).toContain(name);
    }
  });
});
