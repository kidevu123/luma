// Compact build footer — floor PWA style (version · sha · branch).

import {
  formatFloorBuildFooterLabel,
  getBuildFooterParts,
} from "@/lib/build-metadata";

export function LumaBuildFooter({ className }: { className?: string }) {
  const parts = getBuildFooterParts();
  return (
    <p
      className={
        className ??
        "text-center text-[10px] font-mono text-text-subtle tabular-nums"
      }
    >
      {formatFloorBuildFooterLabel(parts)}
    </p>
  );
}
