"use client";

import * as React from "react";
import {
  KeyRound,
  Plus,
  Power,
  PowerOff,
  Trash2,
  Plug,
  Download,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import {
  saveLegacyImportCredentialsAction,
  testLegacyImportConnectionAction,
  addLegacyImportPathAction,
  togglePathEnabledAction,
  removePathAction,
  fetchNowAction,
} from "./actions";

export function CredentialsForm({
  paUsername,
  hasToken,
  isActive,
}: {
  paUsername: string;
  hasToken: boolean;
  isActive: boolean;
}) {
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);
  const [testMsg, setTestMsg] = React.useState<{
    kind: "ok" | "err";
    text: string;
  } | null>(null);
  const [testing, setTesting] = React.useState(false);
  return (
    <div className="space-y-3">
      <form
        action={async (fd) => {
          setPending(true);
          setError(null);
          try {
            const r = await saveLegacyImportCredentialsAction(fd);
            if (r?.error) setError(r.error);
          } catch (err) {
            setError(err instanceof Error ? err.message : "Save failed.");
          } finally {
            setPending(false);
          }
        }}
        className="grid sm:grid-cols-3 gap-3 items-end"
      >
        <div className="space-y-1">
          <Label htmlFor="paUsername">PA username</Label>
          <Input
            id="paUsername"
            name="paUsername"
            defaultValue={paUsername}
            placeholder="sahilk1"
            required
            disabled={pending}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="paApiToken">API token</Label>
          <Input
            id="paApiToken"
            name="paApiToken"
            type="password"
            placeholder={hasToken ? "•••••• stored — leave blank to keep" : "paste your token"}
            autoComplete="off"
            disabled={pending}
          />
        </div>
        <div className="space-y-1">
          <Label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              name="isActive"
              defaultChecked={isActive}
              className="h-4 w-4"
            />
            Scheduled fetcher active
          </Label>
          <Button type="submit" size="sm" disabled={pending}>
            <KeyRound className="h-3.5 w-3.5" />{" "}
            {pending ? "Saving…" : "Save credentials"}
          </Button>
        </div>
        {error && (
          <p className="sm:col-span-3 text-xs text-red-700 bg-red-50 border border-red-200 rounded-md px-2 py-1.5">
            {error}
          </p>
        )}
      </form>

      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={testing || !hasToken}
          onClick={async () => {
            setTesting(true);
            setTestMsg(null);
            try {
              const r = await testLegacyImportConnectionAction();
              if (r && "error" in r && r.error) {
                setTestMsg({ kind: "err", text: r.error });
              } else if (r && "ok" in r && r.ok) {
                setTestMsg({
                  kind: "ok",
                  text: r.message ?? "Token works.",
                });
              }
            } catch (err) {
              setTestMsg({
                kind: "err",
                text: err instanceof Error ? err.message : "Test failed.",
              });
            } finally {
              setTesting(false);
            }
          }}
        >
          <Plug className="h-3.5 w-3.5" />{" "}
          {testing ? "Testing…" : "Test connection"}
        </Button>
        {testMsg && (
          <span
            className={
              "text-xs " +
              (testMsg.kind === "ok" ? "text-emerald-700" : "text-red-700")
            }
          >
            {testMsg.text}
          </span>
        )}
      </div>
    </div>
  );
}

export function AddPathForm() {
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);
  const formRef = React.useRef<HTMLFormElement>(null);
  return (
    <form
      ref={formRef}
      action={async (fd) => {
        setPending(true);
        setError(null);
        try {
          const r = await addLegacyImportPathAction(fd);
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
        Add a file to fetch
      </p>
      <div className="grid sm:grid-cols-4 gap-2 items-end">
        <div className="sm:col-span-2 space-y-1">
          <Label htmlFor="remotePath">Remote path on PA</Label>
          <Input
            id="remotePath"
            name="remotePath"
            placeholder="/home/sahilk1/dumps/tt-latest.sql.gz"
            required
            disabled={pending}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="label">Label</Label>
          <Input
            id="label"
            name="label"
            placeholder="TT MySQL dump"
            required
            disabled={pending}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="kind">Kind</Label>
          <Select id="kind" name="kind" defaultValue="DB_DUMP" disabled={pending}>
            <option value="DB_DUMP">DB dump</option>
            <option value="ZOHO_CONFIG">Zoho config</option>
            <option value="OTHER">Other</option>
          </Select>
        </div>
      </div>
      {error && (
        <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-md px-2 py-1.5">
          {error}
        </p>
      )}
      <Button type="submit" size="sm" disabled={pending}>
        <Plus className="h-3.5 w-3.5" /> {pending ? "Adding…" : "Add path"}
      </Button>
    </form>
  );
}

export function PathRowActions({
  pathId,
  enabled,
}: {
  pathId: string;
  enabled: boolean;
}) {
  const [pending, setPending] = React.useState(false);
  return (
    <div className="inline-flex items-center gap-1">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={pending}
        onClick={async () => {
          setPending(true);
          try {
            await togglePathEnabledAction(pathId);
          } finally {
            setPending(false);
          }
        }}
        title={enabled ? "Disable scheduled fetch" : "Enable scheduled fetch"}
      >
        {enabled ? (
          <Power className="h-3.5 w-3.5 text-emerald-700" />
        ) : (
          <PowerOff className="h-3.5 w-3.5 text-text-subtle" />
        )}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={pending}
        onClick={async () => {
          if (!confirm("Remove this path? Stored downloads stay on disk.")) return;
          setPending(true);
          try {
            await removePathAction(pathId);
          } finally {
            setPending(false);
          }
        }}
        title="Remove path"
      >
        <Trash2 className="h-3.5 w-3.5 text-red-700" />
      </Button>
    </div>
  );
}

export function FetchNowButton() {
  const [pending, setPending] = React.useState(false);
  const [result, setResult] = React.useState<{
    kind: "ok" | "err";
    text: string;
  } | null>(null);
  return (
    <div className="flex items-center gap-2">
      <Button
        type="button"
        size="sm"
        disabled={pending}
        onClick={async () => {
          setPending(true);
          setResult(null);
          try {
            const r = await fetchNowAction();
            if (r && "error" in r && r.error) {
              setResult({ kind: "err", text: r.error });
            } else if (r && "ok" in r) {
              const perFile = r.perFile ?? [];
              const failures = perFile.filter((f) => !f.ok);
              const succLine = `${r.filesSucceeded ?? 0}/${r.filesAttempted ?? 0} files fetched.`;
              const failLine = failures.length
                ? " " +
                  failures
                    .map(
                      (f) =>
                        `${f.remotePath.split("/").pop()} → ${f.error?.slice(0, 80) ?? "failed"}`,
                    )
                    .join("; ")
                : "";
              setResult({
                kind: failures.length ? "err" : "ok",
                text: succLine + failLine,
              });
            }
          } catch (err) {
            setResult({
              kind: "err",
              text: err instanceof Error ? err.message : "Fetch failed.",
            });
          } finally {
            setPending(false);
          }
        }}
      >
        <Download className="h-3.5 w-3.5" />{" "}
        {pending ? "Fetching…" : "Fetch now"}
      </Button>
      {result && (
        <span
          className={
            "text-xs " +
            (result.kind === "ok" ? "text-emerald-700" : "text-red-700")
          }
        >
          {result.text}
        </span>
      )}
    </div>
  );
}
