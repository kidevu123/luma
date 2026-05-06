"use client";

import * as React from "react";
import { Save, Trash2, AlertCircle, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import {
  takeSnapshotAction,
  deleteSnapshotAction,
  wipeDatabaseAction,
} from "./actions";

export function TakeSnapshotForm() {
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [ok, setOk] = React.useState<string | null>(null);

  return (
    <form
      action={async (fd) => {
        setPending(true);
        setError(null);
        setOk(null);
        const r = await takeSnapshotAction(fd);
        setPending(false);
        if (r && "error" in r && r.error) setError(r.error);
        else if (r && "ok" in r && r.ok)
          setOk(`Snapshot saved: ${r.filename}`);
      }}
      className="flex items-end gap-2 flex-wrap"
    >
      <div className="flex-1 min-w-[200px] space-y-1">
        <Label htmlFor="label">Label (optional)</Label>
        <Input
          id="label"
          name="label"
          placeholder="e.g. before-test-import"
          maxLength={60}
          disabled={pending}
        />
      </div>
      <Button type="submit" disabled={pending}>
        <Save className="h-4 w-4" />
        {pending ? "Snapshotting…" : "Take snapshot"}
      </Button>
      {error && (
        <p className="w-full text-xs text-red-700 bg-red-50 border border-red-200 rounded px-2 py-1 inline-flex items-center gap-1.5">
          <AlertCircle className="h-3 w-3" /> {error}
        </p>
      )}
      {ok && (
        <p className="w-full text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded px-2 py-1 inline-flex items-center gap-1.5">
          <Check className="h-3 w-3" /> {ok}
        </p>
      )}
    </form>
  );
}

export function DeleteSnapshotButton({ filename }: { filename: string }) {
  const [pending, setPending] = React.useState(false);
  return (
    <Button
      size="sm"
      variant="ghost"
      type="button"
      disabled={pending}
      onClick={async () => {
        if (!confirm(`Delete snapshot ${filename}? This can't be undone.`))
          return;
        setPending(true);
        const fd = new FormData();
        fd.set("filename", filename);
        await deleteSnapshotAction(fd);
        setPending(false);
      }}
      className="text-red-700"
    >
      <Trash2 className="h-3 w-3" />
    </Button>
  );
}

const REQUIRED_PHRASE = "RESET MY DATABASE";

export function WipeForm() {
  const [mode, setMode] = React.useState<"production" | "everything">(
    "production",
  );
  const [confirm, setConfirm] = React.useState("");
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [ok, setOk] = React.useState<string | null>(null);

  const phraseMatches = confirm.trim() === REQUIRED_PHRASE;

  return (
    <form
      action={async (fd) => {
        if (
          !window.confirm(
            `You are about to wipe ${mode === "everything" ? "EVERYTHING (master data + production)" : "all production data"}. A pre-wipe snapshot will be taken automatically. Continue?`,
          )
        )
          return;
        setPending(true);
        setError(null);
        setOk(null);
        const r = await wipeDatabaseAction(fd);
        setPending(false);
        if (r && "error" in r && r.error) setError(r.error);
        else if (r && "ok" in r && r.ok) {
          setOk(
            `Wiped ${r.tablesWiped.length} tables. Pre-wipe snapshot: ${r.snapshot}`,
          );
          setConfirm("");
        }
      }}
      className="space-y-3"
    >
      <div className="space-y-1">
        <Label htmlFor="mode">Mode</Label>
        <Select
          id="mode"
          name="mode"
          value={mode}
          onChange={(e) =>
            setMode(e.target.value as "production" | "everything")
          }
          disabled={pending}
        >
          <option value="production">
            Wipe production data — keeps products / machines / users / audit
          </option>
          <option value="everything">
            Reset everything — wipes master data too. Only users + audit
            survive.
          </option>
        </Select>
      </div>

      <div className="space-y-1">
        <Label htmlFor="confirm">
          Type{" "}
          <span className="font-mono bg-red-50 border border-red-200 rounded px-1 py-0.5 text-red-800">
            {REQUIRED_PHRASE}
          </span>{" "}
          to enable the button
        </Label>
        <Input
          id="confirm"
          name="confirm"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          placeholder={REQUIRED_PHRASE}
          disabled={pending}
        />
      </div>

      <Button
        type="submit"
        variant="destructive"
        disabled={pending || !phraseMatches}
      >
        <Trash2 className="h-4 w-4" />
        {pending ? "Wiping…" : `Wipe ${mode}`}
      </Button>

      {error && (
        <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded px-2 py-1 inline-flex items-center gap-1.5">
          <AlertCircle className="h-3 w-3" /> {error}
        </p>
      )}
      {ok && (
        <p className="text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded px-2 py-1 inline-flex items-center gap-1.5">
          <Check className="h-3 w-3" /> {ok}
        </p>
      )}
    </form>
  );
}
