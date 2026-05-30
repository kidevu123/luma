"use client";

import * as React from "react";

const PREVIEW_LEN = 48;

export function BagNotesCell({ notes }: { notes: string | null }) {
  if (!notes?.trim()) {
    return <span className="text-xs text-text-muted">—</span>;
  }

  const trimmed = notes.trim();
  if (trimmed.length <= PREVIEW_LEN) {
    return (
      <span className="text-xs text-text-muted whitespace-pre-wrap">{trimmed}</span>
    );
  }

  return (
    <details className="text-xs text-text-muted group">
      <summary className="cursor-pointer list-none [&::-webkit-details-marker]:hidden">
        <span className="line-clamp-2">{trimmed.slice(0, PREVIEW_LEN)}…</span>
        <span className="ml-1 text-brand-700 font-medium group-open:hidden">
          View
        </span>
        <span className="ml-1 text-brand-700 font-medium hidden group-open:inline">
          Hide
        </span>
      </summary>
      <p className="mt-2 whitespace-pre-wrap rounded-md border border-border/60 bg-surface-2 px-2 py-1.5 text-text">
        {trimmed}
      </p>
    </details>
  );
}
