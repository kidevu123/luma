import {
  formatFloorBuildFooterLabel,
  getBuildFooterParts,
  getPackageVersion,
} from "@/lib/build-metadata";
import { Heart } from "lucide-react";

export function AdminFooter() {
  const parts = getBuildFooterParts();
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
          v{version} · {parts.shortSha}
          {parts.branch ? ` · ${parts.branch}` : ""}
          {parts.buildDate ? ` · ${parts.buildDate}` : ""}
        </span>
      </div>
    </footer>
  );
}
