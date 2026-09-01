# 08 — Coverage and health states

Schema: [`../schemas/coverage.schema.json`](../schemas/coverage.schema.json)

What "connected" honestly means — per capability, not per connector.

## The five states

State is tracked **per (connection, capability)**, because a connector is rarely uniformly
working. Shopify can be delivering order events perfectly while its catalog sync is stale.

| state | means | reached by |
|---|---|---|
| `available` | the connector supports this capability | manifest declaration |
| `wired` | the customer connected it and authorization succeeded | successful auth |
| `validated` | an isolated test event proved the path end to end | a `mode: test` event |
| `live` | real production traffic has been observed | a `mode: live` event |
| `healthy` | `live`, and within the manifest's health thresholds | health signals |

The progression is monotonic through `validated`, then oscillates between `live` and `healthy` as
health changes. It can also fall back to `wired` if authorization is revoked.

**A `mode: test` event advances state to at most `validated`.** It can never produce `live` or
`healthy`. This is the coverage-side half of the test isolation guarantee
([01](01-event-envelope.md)); the ingress-side half is F12.

**A `history: true, live_stream: false` connection can reach `validated` and carries a distinct
`historical` label. It can never reach `live`.** Analytics imports are not real-time and are never
displayed as though they were.

This preserves the existing coverage-vs-receipt separation
(`whisperr-go/internal/runtimequery/integration_coverage.go:125`) rather than replacing it.

## Customer-facing labels

Three labels, because five states is an engineering concept:

| label | shown when |
|---|---|
| **Working** | `live` or `healthy` |
| **Waiting for activity** | `validated` — the wiring is proven, no real traffic yet |
| **Needs attention** | `wired` but failing, or degraded from `live`/`healthy` |

Every **Needs attention** state must carry exactly **one smallest repair action** — the single
next thing the customer can do. Not a diagnostic dump, not a list of possibilities.

## The plan-creation gate

Plan creation requires:

- a **committed** registration revision covering the app's minimum event universe
  ([05](05-registration-revision.md))

Plan creation does **not** require:

- every connection to be `live`
- every connection to exist at all
- delivery to be configured

A customer can build their intervention plan before deciding how messages get sent.

## After unlock — the workspace never relocks

Once the dashboard unlocks, connector degradation **never** relocks the workspace. This is a hard
invariant (PROGRAM.md §6), and it is the difference between a system that degrades and one that
punishes.

When a connection degrades:

- only the **interventions that depend on it** pause,
- the workspace, dashboard, and every other intervention keep working,
- the smallest repair action is surfaced,
- the pause lifts automatically when the connection returns to `live`.

## Invariants

1. A test event never advances a capability past `validated`. (negative test)
2. A historical-only capability never reports `live`. (negative test)
3. Plan creation succeeds with a committed minimum universe and zero delivery config.
4. A degraded connector after unlock pauses only its dependent interventions; the workspace stays
   unlocked. (explicit test)
5. Every `Needs attention` state renders exactly one smallest repair action.
6. Displayed labels never exceed the connector's declared capabilities ([02](02-source-connection-manifest.md)).
