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
| `customer_declared` | the customer asserts it on their user's behalf, from their own records | the customer's own SDK/backend/API, or the app owner's client email consent answer (see [Client SDK consent](#client-sdk-consent)) |
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
   message. Neither can an assertion from the `client_sdk` origin, whatever its basis: anyone
   holding the app's publishable key can send one.

## Checked immediately before dispatch

Consent is evaluated at **dispatch time**, not at enqueue time. A revocation that lands between
enqueueing an intervention and sending it must block the send. This is a timing test in
[07](07-delivery-relay.md), not a best-effort.

## Relationship to the SDK `channels[]` field

`SPEC.md`'s `identify.channels[].opted_in` is the customer declaring consent from their own
records — `basis: customer_declared`. That is an assertion, not an inference. By default only an
identify made with the **server key** can assert `opted_in: true` (or `verified: true`) for an
`email` or `sms` channel: anyone can read a publishable key from an app, so the server stores an
`email` or `sms` channel sent with it as pending (unverified, not opted in), and records no
assertion for it. The request still succeeds. The one exception is email under the app's client
email consent setting: see [Client SDK consent](#client-sdk-consent). Either key can assert an opt-out (`opted_in: false`). A later
server-key identify of a pending address confirms it; for `email` an omitted `opted_in` is
enough, but an `sms` channel without `opted_in` is never opted in. Push tokens follow the
device permission (`SPEC.md`, "Push permission and the token"). A channel Whisperr merely
*observed* on a webhook gets no assertion at all.

The customer's backend can also record an assertion directly with
`POST /v1/consent/assertions` (server key only; `origin: customer_backend`, basis
`customer_declared` or `explicit_user_action`). It records consent proof or an opt-out. It does
not change the address itself, so it cannot confirm a pending address alone: the engine also
needs the address opted in and verified, which only a server-key identify (or tracked
`user.channels`) does. A pending address never overrides an assertion that arrived first.

## Client SDK consent

An app with no backend (for example an Expo or React Native app on Firebase or Supabase) can only
identify from the client, with the publishable key. Under the rule above it could never email its
users. The app owner therefore answers one question per app: **"Does your signup get permission to
email users?"** The answer is the app setting `client_email_consent`:

| answer | value | an email channel sent with the publishable key |
|---|---|---|
| never answered | `null` | behaves as `off` |
| No | `off` | is stored pending (the default rule above) |
| Yes | `assumed` | is opted in, unless it carries `opted_in: false` |
| Per user (the app asks) | `per_user` | is opted in only when it carries `opted_in: true` **and** `consent_source: "user"` |

`consent_source: "user"` (`SPEC.md`, `<identify>`) is the client SDK saying that the end user
agreed in the app (`emailOptedIn: true`). `opted_in: true` alone is not enough under `per_user`,
because some released client SDKs send it by default.

The app setting `email_requires_server_key = true` is the stricter mode and always wins: with it,
a publishable key never opts an email in, whatever `client_email_consent` says.

A grant from the publishable key:

- applies only to a **new or pending** address. It never re-opts-in an address that holds a
  decision: an opt-out from the app (`opted_in: false`), the unsubscribe link, or a suppression
  after a bounce or complaint. An earlier opt-out, including the unsubscribe link, is kept.
- stores the address verified, so it can receive email.
- records an assertion with origin `client_sdk`, basis `customer_declared` (`assumed`) or
  `explicit_user_action` (`per_user`). A `client_sdk` assertion only ever opts in, and it never
  clears a Whisperr-side unsubscribe (see Resolution, rule 3). Only the server key or the end
  user through Whisperr can lift one.
- never applies to `sms`. Phone numbers from the client stay pending.

Abuse limits, for the publishable key only. A refused grant stores the address pending; the
request still succeeds (2xx).

1. An existing email on a user cannot be changed without the server key (403
   `contact_change_requires_server_key`, unchanged).
2. One address, one user: if another user of the app already holds the address opted in, the
   grant is refused (`client_consent_address_taken`). Addresses compare trimmed and
   case-insensitively.
3. A rate limit on new client-granted addresses per app (default 200 per rolling hour). Over it
   the grant is refused (`client_consent_rate_limited`); a later identify of the same address
   retries it.
4. A hard bounce or a spam complaint suppresses the address automatically, and a complaint or
   unsubscribe also records the sticky `delivery_unsubscribe` opt-out.
5. Every email carries an unsubscribe link.

## Store consent sources

A store may already ask shoppers for marketing consent: in its checkout, a newsletter plugin, or
its own code. WooCommerce reads those records only from a source the **owner chose and confirmed**
("This checkbox asks shoppers for marketing email consent"). The confirmation is an attestation:
who, when, which source, and the statement. It is never deleted; choosing another source
supersedes it. Fixtures: [`woocommerce_consent_sources.json`](../conformance/connectors/woocommerce_consent_sources.json),
schema [`consent-source-fixture.schema.json`](../schemas/consent-source-fixture.schema.json).

| consent | recorded as |
|---|---|
| a tick on the plugin's own checkbox (`whisperr_checkbox`) | `explicit_user_action` — always counts, needs no attestation |
| an opt-in from a confirmed third-party source, or any `store_sync` re-read | `imported_record` — a record the store keeps |
| an opt-in from a source that is not confirmed (or was superseded before the shopper opted in) | nothing; the receipt ends `superseded` with the repair "The store owner has not confirmed this consent source; the consent was not recorded." |
| an opt-out from any known source, confirmed or not | `explicit_user_action` — an opt-out always counts |

- **Backfill.** Once a source is confirmed, its existing subscribers count too. Each is sent with
  `backfill: true` and the time the shopper opted in at the source, or `null` when the source
  keeps none. Only a third-party opt-in may be a backfill, and only a backfill may have no time;
  anything else is rejected (`invalid_request`). A backfill of unknown time is asserted at the
  confirmation and is not recorded at all when the shopper has any recorded opt-out.
- **Evidence.** `{provider}:{delivery_id}:{source}[:{attestation_id}][:{source_detail}]`, and a
  backfill adds `:backfill:{opted_in_at|unknown}:{confirmed_at}` (UTC, `20060102T150405Z`), so the
  reference names the source, the attestation, the original opt-in and the confirmation.
- An `imported_record` opt-in never clears a Whisperr unsubscribe or complaint (Resolution,
  rule 3). Only a new tick on the plugin's own checkbox does.
- A consent is for an existing subject only; it never creates a user.

## Store opt-ins

A store address is stored pending (not opted in, not verified), and only a recorded opt-in makes
it sendable. Shopify's optional contact import (owner opt-in, address vault strict, the address
re-read from Shopify and never kept in the receipt) and WooCommerce's `contact_sync` both follow
this rule. When the consent record allows the opt-in, the store's own address row is verified as
a store opt-in: `verified_by` is `store_opt_in`, or `provider_double_opt_in` for Shopify's
`CONFIRMED_OPT_IN`, with the connection, the evidence and the time. It is never mistaken for an
address the customer verified. A purchase, or an address alone, never verifies a row. A row that
bounced, was suppressed, or that the customer verified or declared unverified is left as it is,
and a later unsubscribe, bounce or complaint still stops sending.

## Invariants

1. `unknown` blocks delivery. (invariant test)
2. No auth, billing, or commerce event ever creates an assertion. (negative fixture, each)
3. A source cannot assert consent for a channel it does not own.
4. Consent is evaluated immediately before dispatch, not at enqueue.
5. A Whisperr-side unsubscribe cannot be reversed except by `explicit_user_action`, and never by
   the `client_sdk` origin.
6. A publishable key opts an email in only under the app's `client_email_consent` setting, only
   for a new or pending address, and never for `sms`.
7. A third-party store consent source counts only after the owner confirmed it; an opt-out from
   any source always counts. (consent source fixtures)
8. A store address becomes sendable only through a recorded opt-in, marked as a store opt-in.
