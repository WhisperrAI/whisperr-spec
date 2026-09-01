# 07 — Delivery relay contract

Schema: [`../schemas/relay.schema.json`](../schemas/relay.schema.json)

The lowest-PII handoff: Whisperr decides *what to say to whom*; the customer's own system knows
*where to send it*. This is what lets a customer use any unsupported provider on day one without
Whisperr ever holding an address.

## Outbound relay payload

```json
{
  "relay_version": "2.0.0",
  "message_id": "msg_7Kd…",
  "intervention_id": "itv_2Ba…",
  "customer_user_id": "user_8842",
  "channel": "email",
  "content": {
    "rendered": { "subject": "Your trial ends tomorrow", "body_text": "…", "body_html": "…" }
  },
  "idempotency_key": "msg_7Kd…",
  "expires_at": "2026-09-01T09:00:00.000Z",
  "attribution": { "intervention_code": "trial_expiring", "reason_code": "trial_ends_in_24h" }
}
```

`content` is either `rendered` (Whisperr produced the copy) or `structured` (Whisperr supplies
variables and the customer's own templates render). Exactly one.

## Forbidden fields — enforced by schema, not by review

The relay payload **must not** contain:

- any channel address (email, phone, push token) — `customer_user_id` is the customer's own id
- any raw trait
- any raw event row
- any consent record
- any Whisperr-internal identifier beyond `message_id` / `intervention_id`

The schema sets `additionalProperties: false` and explicitly forbids address-shaped keys, so a
violation fails CI rather than a code review. The customer resolves `customer_user_id` → address
in their own system. Whisperr never learns it.

## Receipts

```json
{ "message_id": "msg_7Kd…", "status": "delivered", "at": "…Z", "reason_code": null }
```

`status`: `accepted` · `delivered` · `failed` · `suppressed`
`reason_code` is required for `failed` and `suppressed`, and comes from the taxonomy in
[09](09-error-quarantine.md).

A relay timeout is not a lost message: it becomes `retrying`, then `quarantined` or
`dead_lettered`. It is never silently dropped ([09](09-error-quarantine.md), invariant 1).

## Whisperr-operated delivery

The relay is one of three modes; the other two already exist and are completed, not replaced:

| mode | addresses | credentials |
|---|---|---|
| customer relay | never held | none |
| managed Postmark | held, **encrypted at rest** | Whisperr's |
| FCM / OneSignal BYOK | held, **encrypted at rest** | customer's, encrypted |

`user_channels.address` is plaintext today (`migrations/0001_initial_schema.sql:144`). F13
encrypts it using the existing versioned AES-256-GCM keyring
(`whisperr-go/internal/crypto/secrets.go`) — no new crypto is written for this program. Rotation
must preserve readability of rows encrypted under prior versions.

## Rules for every mode

1. **Consent is checked immediately before dispatch**, never at enqueue
   ([04](04-consent-assertion.md)). A revocation landing in between must block the send.
2. **Idempotency** — the same `idempotency_key` sends exactly once, across retries and across
   process crashes.
3. **Expiration** — an expired message is never sent, and is accounted for as `suppressed`, not
   dropped.
4. **Rotation** of a delivery credential must not drop in-flight sends.
5. **Non-name-dependent copy.** Display name is optional in the stored projection
   ([03](03-identity-authority.md)), so every template must render correctly without one. "Hi
   there," not "Hi ,".

## Invariants

1. The relay payload provably contains no address and no raw traits. (schema-level test)
2. Unknown consent blocks dispatch.
3. Consent revoked between enqueue and dispatch blocks the send. (timing test)
4. The same idempotency key sends exactly once.
5. An expired message is suppressed and accounted for, never silently dropped.
6. A relay timeout ends in retrying, quarantined, or dead-lettered — never lost.
7. Copy renders correctly with no display name available.
