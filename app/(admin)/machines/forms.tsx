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
  setMachineActiveAction,
  setStationActiveAction,
  updateMachineCardsPerTurnAction,
  updateMachineNameAction,
  updateStationLabelAction,
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
      <p className="text-[11px] text-text-subtle">
        Physical equipment only. Hand-pack areas are stations, not machines.
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
          <Label htmlFor="m_cpt">Cards per press</Label>
          <Input
            id="m_cpt"
            name="cardsPerTurn"
            type="number"
            min={1}
            max={50}
            defaultValue={1}
            title="How many cards this machine seals per counter press"
          />
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

export function EditMachineNameForm({
  machineId,
  currentName,
}: {
  machineId: string;
  currentName: string;
}) {
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);
  return (
    <form
      action={async (form) => {
        setPending(true);
        setError(null);
        try {
          const r = await updateMachineNameAction(form);
          if (r?.error) setError(r.error);
        } catch (err) {
          setError(err instanceof Error ? err.message : "Save failed.");
        } finally {
          setPending(false);
        }
      }}
      className="inline-flex items-center gap-1.5 min-w-0"
    >
      <input type="hidden" name="machineId" value={machineId} />
      <Input
        name="name"
        defaultValue={currentName}
        className="h-8 min-w-[8rem] max-w-[14rem]"
        required
      />
      <Button type="submit" variant="ghost" size="sm" disabled={pending}>
        {pending ? "…" : "Save"}
      </Button>
      {error ? (
        <span className="text-[10px] text-red-700 truncate max-w-[8rem]" title={error}>
          {error}
        </span>
      ) : null}
    </form>
  );
}

export function EditCardsPerPressForm({
  machineId,
  currentValue,
  machineKind,
}: {
  machineId: string;
  currentValue: number;
  machineKind: string;
}) {
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);
  const showHint = machineKind === "SEALING" || machineKind === "COMBINED";
  return (
    <form
      action={async (form) => {
        setPending(true);
        setError(null);
        try {
          const r = await updateMachineCardsPerTurnAction(form);
          if (r?.error) setError(r.error);
        } catch (err) {
          setError(err instanceof Error ? err.message : "Save failed.");
        } finally {
          setPending(false);
        }
      }}
      className="inline-flex items-center gap-1.5"
    >
      <input type="hidden" name="machineId" value={machineId} />
      <Input
        name="cardsPerTurn"
        type="number"
        min={1}
        max={50}
        defaultValue={currentValue}
        className="h-8 w-16 text-right tabular-nums px-2"
        title={
          showHint
            ? "How many cards this sealing machine can seal per press"
            : "Cards per machine cycle"
        }
      />
      <Button type="submit" variant="ghost" size="sm" disabled={pending}>
        {pending ? "…" : "Save"}
      </Button>
      {error ? (
        <span className="text-[10px] text-red-700 max-w-[8rem] truncate" title={error}>
          {error}
        </span>
      ) : null}
    </form>
  );
}

function SetActiveButton({
  id,
  active,
  action,
  label,
}: {
  id: string;
  active: boolean;
  action: (form: FormData) => Promise<{ error?: string; ok?: true } | void>;
  label: string;
}) {
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);
  return (
    <form
      action={async (form) => {
        if (
          !active &&
          !window.confirm(
            "Deactivate this item? It will be hidden from active floor lists. Scan URLs stay the same but will block new work.",
          )
        ) {
          return;
        }
        setPending(true);
        setError(null);
        try {
          const r = await action(form);
          if (r?.error) setError(r.error);
        } catch (err) {
          setError(err instanceof Error ? err.message : "Update failed.");
        } finally {
          setPending(false);
        }
      }}
    >
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="active" value={active ? "true" : "false"} />
      <Button type="submit" variant="ghost" size="sm" disabled={pending}>
        {label}
      </Button>
      {error ? (
        <p className="text-[10px] text-red-700 mt-1 max-w-[12rem]" title={error}>
          {error}
        </p>
      ) : null}
    </form>
  );
}

export function DeactivateMachineButton({ machineId }: { machineId: string }) {
  return (
    <SetActiveButton
      id={machineId}
      active={false}
      action={setMachineActiveAction}
      label="Deactivate"
    />
  );
}

export function ReactivateMachineButton({ machineId }: { machineId: string }) {
  return (
    <SetActiveButton
      id={machineId}
      active={true}
      action={setMachineActiveAction}
      label="Reactivate"
    />
  );
}

export function DeactivateStationButton({ stationId }: { stationId: string }) {
  return (
    <SetActiveButton
      id={stationId}
      active={false}
      action={setStationActiveAction}
      label="Deactivate"
    />
  );
}

export function ReactivateStationButton({ stationId }: { stationId: string }) {
  return (
    <SetActiveButton
      id={stationId}
      active={true}
      action={setStationActiveAction}
      label="Reactivate"
    />
  );
}

export function EditStationLabelForm({
  stationId,
  currentLabel,
}: {
  stationId: string;
  currentLabel: string;
}) {
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);
  return (
    <form
      action={async (form) => {
        setPending(true);
        setError(null);
        try {
          const r = await updateStationLabelAction(form);
          if (r?.error) setError(r.error);
        } catch (err) {
          setError(err instanceof Error ? err.message : "Save failed.");
        } finally {
          setPending(false);
        }
      }}
      className="flex items-center gap-1.5 flex-wrap"
    >
      <input type="hidden" name="stationId" value={stationId} />
      <Input
        name="label"
        defaultValue={currentLabel}
        className="h-8 flex-1 min-w-[8rem]"
        required
      />
      <Button type="submit" variant="ghost" size="sm" disabled={pending}>
        {pending ? "…" : "Save name"}
      </Button>
      {error ? (
        <span className="text-[10px] text-red-700 w-full" title={error}>
          {error}
        </span>
      ) : null}
    </form>
  );
}

export function CreateStationForm({ machines }: { machines: Machine[] }) {
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);
  const formRef = React.useRef<HTMLFormElement>(null);
  const activeMachines = machines.filter((m) => m.isActive);
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
      <p className="text-[11px] text-text-subtle">
        Each station gets a unique floor URL. Select a machine only if this station uses one.
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
            {activeMachines.map((m) => (
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
