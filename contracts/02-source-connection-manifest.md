# 02 — Source connection manifest

`manifest_version: 2.0.0` · Schema: [`../schemas/connection-manifest.schema.json`](../schemas/connection-manifest.schema.json)

One declarative file per provider, describing what that connector *is* — its auth, its honest
capabilities, its health signals, its lifecycle. The control plane (F11) reads it; the setup
screen (U50) renders from it; the coverage system (F14) derives labels from it.

## Why this exists

`app_event_sources` (`whisperr-go/migrations/0001_initial_schema.sql:425`) already carries
provider/status/auth-mode columns, but capability is implicit and unverifiable — and the
analytics connectors it describes are mocked in the UI
(`whisperr-watch/src/services/integrations.ts:1`). The manifest makes capability an explicit,
**testable** claim.

## Shape

```json
{
  "manifest_version": "2.0.0",
  "provider": "shopify",
  "display_name": "Shopify",
  "family": "commerce",
  "environments": ["production", "development"],

  "auth": {
    "mode": "oauth",
    "credential_kinds": ["oauth_token"],
    "scopes": [
      { "scope": "read_orders",    "required": true,  "why": "order and checkout events" },
      { "scope": "read_products",  "required": true,  "why": "catalog projection" },
      { "scope": "read_customers", "required": false, "why": "namespace identity links" }
    ],
    "never_requests": ["write_products", "service_role_key"]
  },

  "capabilities": {
    "live_stream": true,
    "history":     true,
    "identity":    "namespace_authoritative",
    "catalog":     true,
    "delivery":    false
  },

  "correlation": { "occurrence_key_template": "shopify:{topic}:{provider_event_id}" },

  "health": {
    "signals": ["webhook_receipt_lag", "auth_valid", "catalog_freshness", "error_rate"],
    "degraded_when": ["auth_valid == false", "webhook_receipt_lag > 15m"]
  },

  "lifecycle": {
    "disconnect": true, "revocation": true, "recovery": true, "replay": true,
    "uninstall_signal": "app/uninstalled",
    "scope_change_signal": "app/scopes_update"
  },

  "kill_switch": "provider.shopify",
  "version": "1"
}
```

## `auth.mode`

`oauth` · `signed_webhook` · `api_key` · `plugin_pairing` · `none`

## `auth.credential_kinds` — the separation that protects MCP

Credentials are typed, and the type is enforced at issuance *and* at use (F11):

| kind | may be used for | ships in client bundles |
|---|---|---|
| `publishable_ingestion_key` | SDK ingestion only | **yes** — treat as a PostHog project key |
| `server_ingestion_key` | server-side ingestion | no |
| `mcp_credential` | MCP tool calls only | no |
| `oauth_token` | one provider, one connection | no |
| `provider_secret` | webhook signature verification | no |
| `delivery_credential` | one delivery provider | no |

**An `mcp_credential` must never be usable as an ingestion or provider credential.** This is a
type-level constraint with explicit negative tests, not a convention. The publishable ingestion
key genuinely ships in client bundles today (`whisperr-go/internal/apikeys/store.go:120`), which
is exactly why the other kinds must be structurally distinct from it — `api_keys` has no kind or
scope column at all right now (`migrations/0001_initial_schema.sql:118`).

`auth.never_requests` is a positive commitment, fixture-checked. Supabase declares
`service_role_key` there; Shopify declares its write scopes.

## `capabilities` — the honesty contract

| capability | values | meaning |
|---|---|---|
| `live_stream` | bool | delivers events in near-real-time as they happen |
| `history` | bool | can import past events (**never** counts as live coverage) |
| `identity` | `authoritative` \| `namespace_authoritative` \| `resolve_only` \| `anonymous_capable` \| `none` | see [03](03-identity-authority.md) |
| `catalog` | bool | can produce a catalog projection ([06](06-catalog-projection.md)) |
| `delivery` | bool | can send messages ([07](07-delivery-relay.md)) |

**Rule 4 of the program: a connector may not declare a capability its fixtures do not
demonstrate.** CI cross-checks each manifest against its fixture file — a `true` with no
demonstrating case fails the build. This is the mechanism that stops the current mocked-connector
situation from recurring, and it is what makes the C2 scope-shed *safe*: dropping
GA/Mixpanel/Amplitude to "labels-only" is `live_stream: false, history: true` with fixtures to
match — a first-class supported mode, not a hack.

## `health` and `lifecycle`

Every connector must support all four of `disconnect`, `revocation`, `recovery`, `replay` — the
launch gate (§8) requires it, so a manifest declaring `false` for any of them cannot ship.
`kill_switch` names the per-provider flag; disabling one provider must leave every other provider
untouched, and that isolation is a fixture case.

## Invariants

1. Every launch connector has a manifest and a fixture file, and CI checks they agree.
2. A capability declared `true` has at least one demonstrating fixture case.
3. `history: true, live_stream: false` can never surface as live coverage ([08](08-coverage-health.md)).
4. A credential of the wrong kind is rejected at use, with a negative fixture proving it.
5. Nothing in `never_requests` appears in any authorization request the connector builds.
6. One provider's kill switch affects exactly one provider.
