"use client";

// SIMPLIFY-B — preset reason chips so a tablet operator is not writing a
// novel. Picking a chip FILLS the input; nothing is submitted until the
// operator's explicit confirm (suggested is never confirmed).

export function ReasonPresets({
  presets,
  onPick,
}: {
  presets: string[];
  onPick: (text: string) => void;
}) {
  if (presets.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1">
      {presets.map((p) => (
        <button
          key={p}
          type="button"
          onClick={() => onPick(p)}
          className="rounded-full border border-border bg-surface-2 px-2 py-0.5 text-[10px] text-text-muted hover:bg-surface hover:text-text-strong"
        >
          {p}
        </button>
      ))}
    </div>
  );
}
