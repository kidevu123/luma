---
name: luma-zoho-gateway
description: Keep Zoho integration safe. Luma uses the gateway, not direct OAuth. Block live writes; honor readiness; never log secrets; dry-run before apply.
---

# Luma Zoho gateway

## When this skill applies

Any time you touch `lib/integrations/zoho/*`, settings page
`/settings/integrations/zoho`, or a sync run / dry-run path.

## Architecture rule

Luma **must** call Zoho through the gateway on LXC 9503 at
`http://192.168.1.205:8000`. Luma never holds Zoho OAuth refresh /
access tokens — the gateway owns them.

Legacy direct-OAuth code in `lib/zoho/client.ts` is kept for the
`/settings/zoho` "test connection" button only. New live-sync code
must NOT import it.

## Env contract

| Env var | Purpose |
|---------|---------|
| `ZOHO_INTEGRATION_URL` | Base gateway URL |
| `ZOHO_INTEGRATION_SECRET` | Shared internal token, sent as `X-Internal-Token` |
| `ZOHO_BRAND` | Which brand's Zoho creds the gateway should use (currently `haute_brands`) |

If any of these are missing, every call returns
`NOT_CONFIGURED` → 503. Never proceed.

## Request shape

Always:

```ts
const headers = buildZohoGatewayHeaders();
// -> {
//   "accept": "application/json",
//   "x-luma-source": "luma",
//   "x-internal-token": "<redacted>",
//   "x-brand": "haute_brands",
// }
```

Use `stripZohoSecret(headers)` before logging.

## Readiness gate

Before any live read or write, derive readiness via
`deriveZohoReadiness({ health, brand })`. Vocabulary:

| Readiness | Meaning | Action |
|-----------|---------|--------|
| `NOT_CONFIGURED` | env vars missing | 503; do not call |
| `UNREACHABLE` | gateway down | block; surface honestly |
| `ERROR` | gateway error | block; surface honestly |
| `CONNECTED_HEALTH_ONLY` | gateway up, no brand info | block; surface honestly |
| `NEEDS_SELECTION` | multiple brands, none picked | block; surface honestly |
| `NEEDS_REAUTH` | brand found, tokens expired | block; **write a PARTIAL audit row** with reason |
| `READY_FOR_DRY_RUN` | go | proceed |

On `NEEDS_REAUTH`, the dry-run orchestrator writes one `PARTIAL`
audit row to `zoho_sync_runs` with `dry_run=true` and a message
explaining the operator must re-authorize tokens on the gateway.
Never calls the live endpoint in that state.

## Write blockers

Until a phase explicitly authorizes Zoho writes:

- No `POST` / `PUT` / `PATCH` / `DELETE` calls against any Zoho
  endpoint.
- No write to Zoho via the gateway.
- Item / customer / invoice sync is **read-only**.
- Finished-lot push to Zoho is gated separately under the LOT-1G
  contract and uses `FINISHED_LOT_PUSH` as its `zoho_sync_kind`.

## Dry-run before apply

Every sync kind ships a dry-run phase first:

1. Fetch via gateway (GET only).
2. Normalize the response into the Luma-canonical shape.
3. Diff against the current Luma snapshot.
4. Write one `zoho_sync_runs` row per kind with `dry_run=true`.
5. Return a preview the operator confirms before any apply path.

Apply phases (CT-3B etc.) are separate, named explicitly, and gated
on an explicit owner-approved click.

## Secrets

- Never log `ZOHO_INTEGRATION_SECRET` or any bearer token.
- Use `stripZohoSecret` on any headers object before passing it to
  `console.log`, audit JSON, or error messages.
- Settings page may show whether the secret is configured (boolean)
  but never its value.

## Error mapping

Use `mapZohoGatewayError({ thrown, httpStatus })`. Connection
refused / DNS failures / timeouts → `UNREACHABLE`. Everything else
non-2xx → `ERROR`. 2xx → `CONNECTED`. The mapper is pure; tests
stub it for transport-failure scenarios.
