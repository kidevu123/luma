import type { ReactNode } from "react";

/**
 * Full viewport command center: fills area right of sidebar and below topbar.
 * Escapes admin main max-width padding.
 */
export default function FloorBoardLayout({ children }: { children: ReactNode }) {
  return (
    <div className="fixed inset-x-0 bottom-0 top-14 z-20 flex h-[calc(100dvh-3.5rem)] flex-col overflow-hidden bg-[#07090d] lg:left-[232px] lg:w-[calc(100%-232px)]">
      {children}
    </div>
  );
}
