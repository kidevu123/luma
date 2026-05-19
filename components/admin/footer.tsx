// Admin footer — version + brand sign-off. Both come from build-time
// env (BUILD_GIT_SHA / BUILD_GIT_BRANCH) so a fresh deploy
// immediately bumps the visible release tag.

import { readFileSync } from "fs";
import path from "path";
import { Heart } from "lucide-react";

function getPackageVersion(): string {
  try {
    const raw = readFileSync(path.join(process.cwd(), "package.json"), "utf-8");
    const pkg = JSON.parse(raw) as { version?: string };
    return pkg.version ?? "?";
  } catch {
    return "?";
  }
}

export function AdminFooter() {
  const sha = process.env.BUILD_GIT_SHA ?? "dev";
  const branch = process.env.BUILD_GIT_BRANCH ?? "main";
  const shortSha = sha.slice(0, 7);
  const buildAt = process.env.BUILD_AT;
  const version = getPackageVersion();

  return (
    <footer className="border-t border-border/60 bg-surface/40">
      <div className="max-w-screen-2xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-3 flex items-center justify-between gap-3 flex-wrap">
        <span className="text-[11px] text-text-subtle inline-flex items-center gap-1">
          Made with{" "}
          <Heart
            className="h-3 w-3 fill-rose-500 text-rose-500"
            aria-label="love"
          />{" "}
          by your Haute tech team
        </span>
        <span className="text-[10px] font-mono text-text-subtle/80 tabular-nums">
          v{version} · {shortSha}
          {branch !== "main" && branch !== "unknown" ? ` · ${branch}` : ""}
          {buildAt ? ` · ${buildAt.slice(0, 10)}` : ""}
        </span>
      </div>
    </footer>
  );
}
