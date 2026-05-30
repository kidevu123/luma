import type { ReactNode } from "react";
import { LumaBuildFooter } from "@/components/ui/luma-build-footer";

/** Shared floor station shell — version footer on every station sub-page. */
export default function FloorStationLayout({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <div className="min-h-dvh flex flex-col">
      <div className="flex-1">{children}</div>
      <div className="pb-[calc(0.75rem+env(safe-area-inset-bottom))] pt-2 px-4">
        <LumaBuildFooter />
      </div>
    </div>
  );
}
