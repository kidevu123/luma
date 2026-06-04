import type { ReactNode } from "react";

/** Full-bleed floor board: cancel admin main padding so the command center uses the viewport. */
export default function FloorBoardLayout({ children }: { children: ReactNode }) {
  return (
    <div className="-mx-4 sm:-mx-6 lg:-mx-8 -my-4 sm:-my-6 lg:-my-8 min-h-[calc(100dvh-3.5rem)] flex flex-col">
      {children}
    </div>
  );
}
