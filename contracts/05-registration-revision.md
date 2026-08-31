# 05 — Registration revision model

Schema: [`../schemas/registration.schema.json`](../schemas/registration.schema.json)

How an event code comes to exist — atomically, from any executor, without the wizard owning it.

## Why this exists

Today an event's existence is inseparable from a wizard run: `app_events.created_by_run_id` is
`NOT NULL` with `ON DELETE RESTRICT` to `wizard_runs`
(`migrations/0079_wizard_generated_universe.sql:120`), and universe generation joins through
`wizard_projects` (`internal/onboardingimport/calibrate.go:274`). Four different executors need to
register events — MCP, the hosted PR agent, the CLI, and the wizard — and they must all write
through **one** model, or they will drift into four different notions of what an event is.

## State machine

```text
draft ──► validating ──► committed ──► superseded
  │            │
  └────────────┴──► failed
```

| state | meaning |
|---|---|
| `draft` | being assembled by an executor; not visible to ingestion |
| `validating` | isolated test events are being submitted against it ([01](01-event-envelope.md) `mode: test`) |
| `committed` | live; its event codes are now legal for ingestion |
| `failed` | validation did not pass; **zero** events were created |
| `superseded` | a later revision replaced it; history retained, never deleted |

## Shape

```json
{
  "revision_id": "rev_9Fa…",
  "app_id": "app_3Qd…",
  "state": "committed",
  "parent_revision_id": "rev_4Bc…",
  "created_by": { "executor": "mcp", "actor_ref": "conn:agent-7" },
  "events": [
    {
      "code": "trial_expired",
      "name": "Trial expired",
      "reasoning": "Drives the reactivation intervention",
      "payload_schema": { "type": "object", "properties": { "plan": { "type": "string" } } },
      "sources": ["con_5Hj…", "con_2Wq…"]
    }
  ],
  "mappings": [
    { "connection_id": "con_5Hj…", "provider_signal": "invoice.payment_failed", "event_code": "payment_failed" }
  ],
  "validation": {
    "test_events_seen": ["trial_expired"],
    "gaps": [{ "event_code": "payment_failed", "reason": "no test event received" }]
  },
  "committed_at": "2026-08-31T09:20:00.000Z"
}
```

`executor` is one of `mcp` · `pr_agent` · `cli` · `wizard` · `console`. It is recorded for audit
and for the X20 parity suite — it carries **no** semantic difference. A revision committed by the
wizard is indistinguishable in behavior from one committed by MCP. That equivalence is the whole
point of X20's "shared integration playbook".

## Atomicity

A revision commits entirely or not at all.

- A `failed` revision leaves **zero** events, zero mappings, zero partial state.
- A crash mid-commit is recoverable to exactly one of `committed` or `failed` — never a partial.
- Two concurrent revisions for the same app serialize; the loser sees a conflict and rebases, it
  does not half-apply.

## Event identity is preserved

A revision changes an event's *definition*, never its identity. Re-registering an existing `code`
updates it in place and keeps `event_id` stable — including through the F10 backfill of
wizard-created events. Historical envelopes keep pointing at the same event.

`sources` is a list: **one event may be observed by many sources.** Registering `payment_failed`
against both Stripe and the customer's own SDK is one event with two bindings, correlated via
`occurrence_key` ([01](01-event-envelope.md)), not two events.

## The minimum event universe

Plan creation gates on a **committed** revision that covers the app's minimum event universe —
not on how many connections exist and not on delivery being configured
([08](08-coverage-health.md)). A customer with one Supabase connection and a committed universe
can create a plan; a customer with six connections and no committed universe cannot.

## Invariants

1. A `failed` revision leaves no events. (crash-injection test)
2. `event_id` is stable across revisions and across the F10 backfill.
3. An event code not in a `committed` revision is not ingestible — it quarantines.
4. All four executors produce byte-identical revisions for the same input (X20 parity suite).
5. Superseding never deletes history.
6. `mode: test` events can validate a revision; they can never commit one on their own.
