"use client";

import * as React from "react";
import { Save, CheckCircle2, AlertCircle, Plug } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { saveZohoCredentialsAction, testZohoConnectionAction } from "./actions";

type Initial = {
  organizationId: string;
  clientId: string;
  dataCenter: string;
  warehouseId: string | null;
  isActive: boolean;
  hasSecret: boolean;
  hasRefreshToken: boolean;
};

export function ZohoCredentialForm({ initial }: { initial: Initial | null }) {
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [ok, setOk] = React.useState(false);
  const [testing, setTesting] = React.useState(false);
  const [testResult, setTestResult] = React.useState<string | null>(null);
  const [testError, setTestError] = React.useState<string | null>(null);

  return (
    <form
      action={async (fd) => {
        setPending(true);
        setError(null);
        setOk(false);
        const r = await saveZohoCredentialsAction(fd);
        setPending(false);
        if (r && "error" in r && r.error) setError(r.error);
        else setOk(true);
      }}
      className="space-y-4"
    >
      <div className="grid sm:grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label htmlFor="organizationId">Organization ID</Label>
          <Input
            id="organizationId"
            name="organizationId"
            defaultValue={initial?.organizationId ?? ""}
            placeholder="60018xxxxx"
            required
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="dataCenter">Data center</Label>
          <Select
            id="dataCenter"
            name="dataCenter"
            defaultValue={initial?.dataCenter ?? "us"}
          >
            <option value="us">US (zohoapis.com)</option>
            <option value="eu">EU (zohoapis.eu)</option>
            <option value="in">IN (zohoapis.in)</option>
            <option value="au">AU (zohoapis.com.au)</option>
            <option value="jp">JP (zohoapis.jp)</option>
          </Select>
        </div>
      </div>

      <div className="space-y-1">
        <Label htmlFor="clientId">Client ID</Label>
        <Input
          id="clientId"
          name="clientId"
          defaultValue={initial?.clientId ?? ""}
          placeholder="1000.XXXXXXXXXXXX"
          required
        />
      </div>

      <div className="grid sm:grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label htmlFor="clientSecret">Client secret</Label>
          <Input
            id="clientSecret"
            name="clientSecret"
            type="password"
            placeholder={initial?.hasSecret ? "•••••• (leave blank to keep)" : ""}
            required={!initial?.hasSecret}
          />
          <p className="text-[10px] text-text-subtle">
            {initial?.hasSecret
              ? "Stored — leave blank unless rotating."
              : "Required on first save."}
          </p>
        </div>
        <div className="space-y-1">
          <Label htmlFor="refreshToken">Refresh token</Label>
          <Input
            id="refreshToken"
            name="refreshToken"
            type="password"
            placeholder={initial?.hasRefreshToken ? "•••••• (leave blank to keep)" : ""}
            required={!initial?.hasRefreshToken}
          />
          <p className="text-[10px] text-text-subtle">
            {initial?.hasRefreshToken
              ? "Stored — leave blank unless rotating."
              : "Required on first save."}
          </p>
        </div>
      </div>

      <div className="space-y-1">
        <Label htmlFor="warehouseId">Warehouse ID (app-level default)</Label>
        <Input
          id="warehouseId"
          name="warehouseId"
          defaultValue={initial?.warehouseId ?? ""}
          placeholder="e.g. 460000000012345"
        />
        <p className="text-[11px] text-text-muted">
          Used as the default warehouse for production-output previews
          when no per-product override is set and the operator does not
          pick one on the preview form. Warehouse ID must match a Zoho{" "}
          <span className="font-mono">warehouse_id</span>. Cached
          warehouse dropdown will replace this once gateway v1.23.0 is
          available.
        </p>
      </div>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          name="isActive"
          defaultChecked={initial?.isActive ?? true}
          className="h-4 w-4"
        />
        <span>Active — pushes attempt for new finished lots</span>
      </label>

      <div className="flex items-center justify-between gap-3 pt-2 border-t border-border/60">
        <div className="text-xs">
          {error && (
            <span className="inline-flex items-center gap-1.5 text-red-700">
              <AlertCircle className="h-3.5 w-3.5" /> {error}
            </span>
          )}
          {ok && (
            <span className="inline-flex items-center gap-1.5 text-emerald-700">
              <CheckCircle2 className="h-3.5 w-3.5" /> Saved
            </span>
          )}
          {testResult && (
            <span className="inline-flex items-center gap-1.5 text-emerald-700">
              <CheckCircle2 className="h-3.5 w-3.5" /> Connected to {testResult}
            </span>
          )}
          {testError && (
            <span className="inline-flex items-center gap-1.5 text-red-700">
              <AlertCircle className="h-3.5 w-3.5" /> {testError}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={!initial || testing}
            onClick={async () => {
              setTesting(true);
              setTestError(null);
              setTestResult(null);
              const r = await testZohoConnectionAction();
              setTesting(false);
              if (r && "error" in r && r.error) setTestError(r.error);
              else if (r && "organizationName" in r) setTestResult(r.organizationName);
            }}
          >
            <Plug className="h-3.5 w-3.5" /> {testing ? "Testing…" : "Test connection"}
          </Button>
          <Button type="submit" disabled={pending}>
            <Save className="h-4 w-4" /> {pending ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
    </form>
  );
}
