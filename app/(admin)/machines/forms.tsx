"use client";

import * as React from "react";
import { Plus, RefreshCw } from "lucide-react";
import type { Machine } from "@/lib/db/schema";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import {
  createMachineAction,
  createStationAction,
  rotateTokenAction,
} from "./actions";

const STATION_KINDS = [
  ["BLISTER", "Blister (machine)"],
  ["HANDPACK_BLISTER", "Hand-pack blister (no machine)"],
  ["SEALING", "Sealing"],
  ["PACKAGING", "Packaging"],
  ["BOTTLE_HANDPACK", "Bottle hand-pack"],
  ["BOTTLE_CAP_SEAL", "Bottle cap-seal"],
  ["BOTTLE_STICKER", "Bottle sticker"],
  ["COMBINED", "Combined"],
] as const;

const MACHINE_KINDS = [
  ["BLISTER", "Blister"],
  ["SEALING", "Sealing"],
  ["PACKAGING", "Packaging"],
  ["BOTTLE_HANDPACK", "Bottle handpack"],
  ["BOTTLE_CAP_SEAL", "Bottle cap-seal"],
  ["BOTTLE_STICKER", "Bottle sticker"],
  ["COMBINED", "Combined"],
] as const;

export function CreateMachineForm() {
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);
  const formRef = React.useRef<HTMLFormElement>(null);
  return (
    <form
      ref={formRef}
      action={async (form) => {
        setPending(true);
        setError(null);
        try {
          const r = await createMachineAction(form);
          if (r?.error) setError(r.error);
          else formRef.current?.reset();
        } catch (err) {
          setError(err instanceof Error ? err.message : "Save failed.");
        } finally {
          setPending(false);
        }
      }}
      className="border border-dashed border-border rounded-lg p-3 space-y-2.5"
    >
      <p className="text-[11px] font-semibold uppercase tracking-wider text-text-subtle">
        Add a machine
      </p>
      <div className="grid grid-cols-3 gap-2">
        <div>
          <Label htmlFor="m_name">Name</Label>
          <Input id="m_name" name="name" placeholder="Machine 3" required />
        </div>
        <div>
          <Label htmlFor="m_kind">Kind</Label>
          <Select id="m_kind" name="kind" defaultValue="SEALING">
            {MACHINE_KINDS.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Label htmlFor="m_cpt">Cards / turn</Label>
          <Input id="m_cpt" name="cardsPerTurn" type="number" min={1} defaultValue={1} />
        </div>
      </div>
      {error && (
        <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-md px-2 py-1.5">
          {error}
        </p>
      )}
      <Button type="submit" size="sm" disabled={pending}>
        <Plus className="h-3.5 w-3.5" /> Add
      </Button>
    </form>
  );
}

export function CreateStationForm({ machines }: { machines: Machine[] }) {
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);
  const formRef = React.useRef<HTMLFormElement>(null);
  return (
    <form
      ref={formRef}
      action={async (form) => {
        setPending(true);
        setError(null);
        try {
          const r = await createStationAction(form);
          if (r?.error) setError(r.error);
          else formRef.current?.reset();
        } catch (err) {
          setError(err instanceof Error ? err.message : "Save failed.");
        } finally {
          setPending(false);
        }
      }}
      className="border border-dashed border-border rounded-lg p-3 space-y-2.5"
    >
      <p className="text-[11px] font-semibold uppercase tracking-wider text-text-subtle">
        Add a station
      </p>
      <div className="grid grid-cols-3 gap-2">
        <div>
          <Label htmlFor="s_label">Label</Label>
          <Input id="s_label" name="label" placeholder="M3 Sealing" required />
        </div>
        <div>
          <Label htmlFor="s_kind">Kind</Label>
          <Select id="s_kind" name="kind" defaultValue="SEALING">
            {STATION_KINDS.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Label htmlFor="s_machine">Machine</Label>
          <Select id="s_machine" name="machineId" defaultValue="">
            <option value="">— none —</option>
            {machines.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </Select>
        </div>
      </div>
      {error && (
        <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-md px-2 py-1.5">
          {error}
        </p>
      )}
      <Button type="submit" size="sm" disabled={pending}>
        <Plus className="h-3.5 w-3.5" /> Add
      </Button>
    </form>
  );
}

export function RotateTokenButton({ stationId }: { stationId: string }) {
  const [pending, setPending] = React.useState(false);
  const [recent, setRecent] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  return (
    <div className="inline-flex items-center gap-2">
      {recent && (
        <span className="font-mono text-[11px] text-emerald-700">
          {recent.slice(0, 16)}…
        </span>
      )}
      {error && (
        <span className="text-[11px] text-red-700" title={error}>
          {error.length > 28 ? error.slice(0, 26) + "…" : error}
        </span>
      )}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={pending}
        onClick={async () => {
          setPending(true);
          setError(null);
          try {
            const r = await rotateTokenAction(stationId);
            if (r?.token) setRecent(r.token);
            else if (r && "error" in r && r.error) setError(r.error);
          } catch (err) {
            setError(err instanceof Error ? err.message : "Rotate failed.");
          } finally {
            setPending(false);
          }
        }}
      >
        <RefreshCw className="h-3.5 w-3.5" />
        Rotate
      </Button>
    </div>
  );
}
