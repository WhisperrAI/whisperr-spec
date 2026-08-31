# 01 — Canonical event envelope

`envelope_version: 2.0.0` · Schema: [`../schemas/envelope.schema.json`](../schemas/envelope.schema.json)

The shape every fact takes once it is inside Whisperr, regardless of which system produced it.

## Why this exists

Canonical events are currently owned by the wizard: `app_events.project_id` and
`app_events.created_by_run_id` are `NOT NULL` with an `ON DELETE RESTRICT` FK to `wizard_runs`
(`whisperr-go/migrations/0079_wizard_generated_universe.sql:120`). That makes the wizard a
required participant in every event's existence. The envelope removes that: an event belongs to
an **app**, is defined by a **registration revision**, and is *observed by* one or more
**sources**. The wizard becomes one writer among many.

## Shape

```json
{
  "envelope_version": "2.0.0",
  "event_id": "aev_7Yk2…",
  "app_id": "app_3Qd…",
  "mode": "live",

  "event": {
    "code": "payment_failed",
    "registration_revision_id": "rev_9Fa…",
    "properties": { "amount_minor": 4900, "currency": "USD" }
  },

  "subject": {
    "authority": "resolve_only",
    "source_subject_id": "cus_NffrFeUfNV2Hib",
    "customer_stable_id": "user_8842",
    "resolution": "resolved"
  },

  "origin": {
    "connection_id": "con_5Hj…",
    "provider": "stripe",
    "source_kind": "webhook",
    "provider_event_id": "evt_1P9xKl2eZvKYlo2C",
    "contract_version": "2.0.0"
  },

  "time": {
    "occurred_at": "2026-08-31T09:14:02.117Z",
    "received_at": "2026-08-31T09:14:03.402Z",
    "source_sequence": "1724921642-000431"
  },

  "correlation": {
    "occurrence_key": "stripe:invoice:in_1P9x:payment_failed",
    "idempotency_key": "con_5Hj…:evt_1P9xKl2eZvKYlo2C"
  }
}
```

## Field rules

### `mode` — `live` | `test`
The single discriminator that makes test isolation structural rather than per-connector
convention. A `test` event uses **this same envelope** — so validating the test path proves the
production path — but travels a separate lane and can never:

- create or mutate a production user,
- change user state,
- trigger an intervention evaluation,
- generate any delivery,
- contribute to analytics,
- advance a coverage state past `validated` (see [08](08-coverage-health.md)).

This matters because the normal ingestion path auto-creates users and fans out to evaluation
(`whisperr-go/internal/ingestion/store.go:183`, `EnsureUser` at `:189`, fan-out at `:218`).
Without a contract-level discriminator, every connector would re-solve isolation separately and
one of them would get it wrong.

**`mode` is not the provider's sandbox flag.** A connection points at a provider environment
(`production` / `staging` / `development` — Stripe's live-vs-test, Shopify's dev store). That is
the connection's `environment` in [02](02-source-connection-manifest.md). A real event arriving
from a Stripe *test-mode* connection is `mode: live` — it is a genuine observation of that
connection. `mode: test` is reserved for Whisperr's own isolated validation lane. Collapsing the
two axes either leaks sandbox data into production coverage or makes real events from a
development connection unprocessable; both have happened to other people's connectors.

### `event.code`
Lowercase `snake_case`, `^[a-z][a-z0-9]*(_[a-z0-9]+)*$` — identical to the existing
`app_events.code` CHECK constraint and to `event_type` in `SPEC.md`. An event code is only legal
if a **committed** registration revision defines it ([05](05-registration-revision.md)). An
unregistered code is a `unregistered_event_code` quarantine, not a silent accept and not a 500.

### `event.properties`
Only fields allowlisted by the registered `payload_schema` survive into durable storage.
Everything else is dropped **before** persistence, not after — webhook payload minimization is a
storage rule, not a display rule ([09](09-error-quarantine.md), F13).

### `subject`
Carries the *source's* claim, never a merge decision. `authority` is the source's mode from
[03](03-identity-authority.md); `resolution` is `resolved` | `unresolved` | `quarantined`. A
`resolve_only` source that resolves to nothing yields `unresolved` — it does **not** create a
user. `event_id` is assigned once and preserved for the life of the event, including through the
F10 backfill.

### `time` — occurrence is authoritative, receipt never is
- `occurred_at` — when it happened *in the source system*. **This is the ordering key.**
- `received_at` — when Whisperr durably accepted it. Diagnostic only; never used for ordering,
  windowing, or state transitions.
- `source_sequence` — optional provider ordering token, used only to break `occurred_at` ties.

Auth0 log streams are at-least-once *and* out-of-order, so ordering on receipt would corrupt
state. Ordering on occurrence is therefore mandatory for every source, not an Auth0 special case.

`occurred_at` is RFC3339 UTC, millisecond precision, `Z` suffix — the same format `SPEC.md`
already pins for SDKs. Acceptance window: **+5 min / −30 days** of receipt, matching the existing
SDK rule. Outside it: `timestamp_out_of_window`, rejected before acknowledge.

### `correlation` — two distinct keys, do not conflate them

| key | scope | question it answers |
|---|---|---|
| `idempotency_key` | per **connection** | "have I already ingested *this delivery*?" |
| `occurrence_key` | per **app** | "is this the same real-world occurrence another source already told me about?" |

`idempotency_key` defaults to `{connection_id}:{provider_event_id}`. Scoping it to the connection
is deliberate: two connections observing the same provider event must **not** dedupe each other
into silence — they must *correlate*.

`occurrence_key` is what implements "one event ← multiple sources". Two envelopes sharing an
`occurrence_key` resolve to **one** canonical event with two source bindings, not two events.
Each connector's manifest declares how it derives its `occurrence_key`; a connector that cannot
derive a stable one declares `occurrence_key: null` and its events are never correlated (safe
default — duplicates are visible, not silently merged).

## Invariants

1. An envelope with `mode: test` never reaches production evaluation or delivery.
2. `occurred_at` orders; `received_at` never does.
3. An unregistered `event.code` quarantines; it never auto-registers.
4. Two envelopes with the same `idempotency_key` on the same connection collapse to one ingest.
5. Two envelopes with the same `occurrence_key` collapse to one canonical event with two bindings.
6. `event_id` is stable for the life of the event, including across registration revisions and
   the F10 backfill.
7. No field outside the registered `payload_schema` allowlist is ever durably stored.
