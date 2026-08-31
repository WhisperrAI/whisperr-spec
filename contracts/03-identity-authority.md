# 03 — Identity authority modes

Schema: [`../schemas/identity.schema.json`](../schemas/identity.schema.json)

Who is allowed to say who a person is — and, more importantly, who is *not*.

## Why this exists

`users` is `(app_id, external_id)` and nothing else
(`whisperr-go/migrations/0001_initial_schema.sql:133`), while ingestion auto-creates users on
first sight (`internal/ingestion/store.go:189`). Add six providers each with their own notion of
a customer and, without an authority model, the system will quietly merge two different people
because they share an email address. This contract makes that outcome impossible by construction.

## The four modes

| mode | may create a link | may resolve to a link | may promote | examples |
|---|---|---|---|---|
| `authoritative` | **yes** | yes | yes | Clerk, Auth0, Supabase Auth, the customer's own SDK/backend |
| `namespace_authoritative` | yes, **inside its own namespace only** | yes | no | Shopify (its customer namespace) |
| `resolve_only` | **no** | yes | no | Stripe, RevenueCat, Segment |
| `anonymous_capable` | anonymous handle only | yes | only via explicit verified transition | browser SDK before `identify()` |

### `authoritative`
Owns identity for the app. May create a user, may bind a `source_subject_id` to a
`customer_stable_id`.

### `namespace_authoritative`
Authoritative *within its own namespace* and nowhere else. Shopify may say "this is Shopify
customer 4471"; it may not say "and that is the same person as Clerk user_8842" unless the
customer's own stable id is present in the payload. It can never override an `authoritative`
source's link.

### `resolve_only`
Stripe knows `cus_Nffr…` has a subscription. It does **not** know who that is in the customer's
product. A `resolve_only` source may look up an existing link and attach its event to it; if no
link exists, the event is `resolution: unresolved` and is retained without a user. It never
creates one, and it never promotes itself.

This is the mode that prevents the most likely real-world corruption: a Stripe webhook creating a
shadow user that later collides with the real one.

### `anonymous_capable`
Behavior may be attached to an anonymous handle before identity is known. Promotion to a real
identity happens **only** through an explicit verified transition carrying the promoting source —
never by inference, and never retroactively across two different anonymous handles.

## The absolute prohibitions

1. **No email-based merging.** Email is a channel address, not an identity. Two sources
   presenting the same email are two claims, not one person.
2. **No fuzzy matching.** No name similarity, no phone normalization heuristics, no
   probabilistic linking, no "confidence score" merges.
3. **No silent merges.** Every merge is the result of an explicit, authorized, recorded claim.
4. **Segment `userId` resolves but never merges** — it is `resolve_only` precisely because
   customers route heterogeneous identities through Segment.

## Conflict handling — quarantine the link, not the user

A conflict is any of:

- two `authoritative` sources binding the same `customer_stable_id` to different
  `source_subject_id`s,
- one `source_subject_id` binding to two different `customer_stable_id`s,
- a `resolve_only` or `namespace_authoritative` source contradicting an `authoritative` link.

On conflict:

- the **link** is quarantined (`identity_conflict`, see [09](09-error-quarantine.md)),
- the **user** remains fully functional — existing links, state, and interventions are untouched,
- the event is retained with `resolution: quarantined`,
- a smallest-repair-action is surfaced (usually: confirm which subject id is correct),
- **no automatic winner is chosen** between two `authoritative` sources. Precedence is not a
  tiebreaker; ambiguity is a question for a human, not a heuristic.

Precedence exists only to *reject* weaker claims, never to resolve ties between equals:
`authoritative` > `namespace_authoritative` (outside its namespace) > `resolve_only`.

## Stored user projection — the minimum, and nothing more

| field | stored | note |
|---|---|---|
| internal id | always | |
| customer stable id | always | the customer's own id |
| source subject ids | always | one per authorized source |
| first / display name | optional | only for message personalisation |
| approved traits | explicit only | allowlisted per app; never "whatever arrived" |
| consent assertions | always | channel, source, timestamp, status ([04](04-consent-assertion.md)) |
| channel address | **only when Whisperr performs delivery** | encrypted at rest; absent entirely on the relay path ([07](07-delivery-relay.md)) |

The message generator already excludes raw event rows and raw traits
(`whisperr-go/internal/engine/messagegen/assemble.go:18`). This projection is the same boundary
applied at *storage* time rather than only at generation time.

## Invariants

1. A `resolve_only` source can never create a user. (negative fixture, every such connector)
2. Two sources presenting the same email never merge. (negative fixture)
3. A conflict quarantines a link and leaves the user working.
4. Anonymous → identified requires an explicit verified transition.
5. `namespace_authoritative` never overrides `authoritative`.
6. No address, raw trait, or raw event row is stored outside the projection above.
