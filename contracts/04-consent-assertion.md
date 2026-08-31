# 04 — Consent assertion contract

Schema: [`../schemas/consent.schema.json`](../schemas/consent.schema.json)

When Whisperr is allowed to send. The default is **no**.

## Shape

```json
{
  "channel": "email",
  "status": "opted_in",
  "basis": "explicit_user_action",
  "source": { "connection_id": "con_5Hj…", "provider": "clerk" },
  "asserted_at": "2026-08-31T09:14:02.117Z",
  "evidence_ref": "pref_center:2026-08-14T10:02:11Z"
}
```

## `status`

`opted_in` · `opted_out` · `unknown`

**`unknown` is the default for every (user, channel) pair and it blocks delivery.** Absence of an
opt-out is not consent. A user with no assertion for `sms` cannot be sent an SMS, no matter how
much other signal exists about them.

## `basis` — the only three legitimate origins

| basis | meaning | who may assert |
|---|---|---|
| `explicit_user_action` | the person themselves acted (checkbox, preference centre, unsubscribe link) | any source that owns that interaction |
| `customer_declared` | the customer asserts it on their user's behalf, from their own records | the customer's own SDK/backend/API |
| `imported_record` | migrated from a prior system, with a pointer to the original record | import paths only |

Anything not on this list is not consent.

## Never inferred — the explicit non-list

Consent is **never** derived from:

- a login, signup, or session (Clerk, Auth0, Supabase Auth)
- a payment, subscription, invoice, or renewal (Stripe, RevenueCat)
- a purchase, cart, or checkout (Shopify, WooCommerce)
- the presence of an email address or phone number anywhere
- a Segment `identify` trait that merely *contains* an address
- product usage of any kind

An auth connector delivering a `user.created` event with an email address produces **an address
and no consent**. This has a negative fixture in every auth, billing, and commerce connector,
because it is the single most tempting shortcut in the program.

## Ownership

A source may only assert consent for a channel it actually owns the interaction for. Stripe may
not assert email consent. A delivery provider's unsubscribe webhook may assert `opted_out` for
its own channel and nothing else.

## Resolution — which assertion wins

1. Latest `asserted_at` wins.
2. Exact ties resolve to `opted_out`.
3. An `opted_out` recorded by Whisperr's own delivery unsubscribe path is **sticky**: it can only
   be reversed by a later `explicit_user_action` opt-in. A `customer_declared` or
   `imported_record` opt-in cannot silently re-subscribe someone who unsubscribed from a Whisperr
   message.

## Checked immediately before dispatch

Consent is evaluated at **dispatch time**, not at enqueue time. A revocation that lands between
enqueueing an intervention and sending it must block the send. This is a timing test in
[07](07-delivery-relay.md), not a best-effort.

## Relationship to the SDK `channels[]` field

`SPEC.md`'s `identify.channels[].opted_in` is the customer declaring consent from their own
records — `basis: customer_declared`. That is an assertion, not an inference, and it remains
valid under 2.0.0 with no SDK change. `opted_in` defaults to `true` there because the customer is
actively supplying the channel; a channel Whisperr merely *observed* on a webhook gets no
assertion at all.

## Invariants

1. `unknown` blocks delivery. (invariant test)
2. No auth, billing, or commerce event ever creates an assertion. (negative fixture, each)
3. A source cannot assert consent for a channel it does not own.
4. Consent is evaluated immediately before dispatch, not at enqueue.
5. A Whisperr-side unsubscribe cannot be reversed except by `explicit_user_action`.
