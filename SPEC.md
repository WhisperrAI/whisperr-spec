# Whisperr SDK spec

The single source of truth for the ingestion contract every Whisperr SDK must
produce and honor.
The SDKs (`@whisperr/web`, `@whisperr/react`, `@whisperr/next`, `whisperr-flutter`,
`@whisperr/node`, `whisperr` for Python, `whisperr/php`) each hand-implement this
contract, so the fixtures pin the expected behavior:

- [`conformance/wire.json`](conformance/wire.json) pins serialized request bodies.
- [`conformance/behavior.json`](conformance/behavior.json) pins retry/drop/retain
  outcomes.
- [`conformance/push.json`](conformance/push.json) pins push-token capture flows
  (`setPushToken`) for the SDKs that expose them (mobile: React Native, Flutter,
  Swift).

## Endpoints

| Endpoint | Body | Notes |
|---|---|---|
| `POST /v1/events/batch` | `{ "events": [ <event>, … ] }` | ≤ 500 events per batch |
| `POST /v1/events/track` | `<event>` | single event |
| `POST /v1/identify` | `<identify>` | |

Base URL defaults to `https://api.whisperr.net`.

## Auth

Every request sends the app's ingestion key. Either header is accepted:

- `X-API-Key: <key>` (web, node, python, php)
- `Authorization: Bearer <key>` (flutter)

The ingestion key is **publishable** — it ships in client bundles. Treat it like a
PostHog project key, not a secret.

## `<event>` (track)

```json
{
  "external_user_id": "user_8842",
  "event_type": "payment_failed",
  "occurred_at": "2026-06-14T12:00:00.000Z",
  "properties": { "amount_cents": 4900 },
  "context": { "$message_id": "f7a1…" }
}
```

- `external_user_id` (string, required) — the customer's own stable user id. On
  backends it is always passed explicitly; the browser SDK fills it in on
  `identify()` and backfills buffered anonymous events.
- `event_type` (string, required) — lowercase `snake_case`
  (`^[a-z0-9]+(?:_[a-z0-9]+)*$`). The server rejects anything else.
  SDKs should validate this before enqueueing and surface/drop invalid events so
  one bad name cannot poison an otherwise valid batch.
- `occurred_at` (string) — RFC3339 UTC with millisecond precision and a `Z`
  suffix. Must be within +5 min / −30 days of now.
- `properties` (object) — empty serializes as `{}`, never `[]`.
- `context` (object) — free-form, **must contain `$message_id`**: a per-event
  idempotency key (any stable unique string; UUID recommended) so at-least-once
  retries dedup server-side. It must be stable across retries of the same event.

## `<identify>`

```json
{
  "external_user_id": "user_8842",
  "traits": { "plan": "pro" },
  "preferred_channel": "email",
  "channels": [
    { "channel": "email", "address": "ada@example.com", "opted_in": true, "verified": false }
  ]
}
```

- `external_user_id` (string, required).
- `traits` (object, optional) — omit when empty.
- `preferred_channel` (string, optional) — one of `email` | `sms` | `push`.
- `channels` (array, optional) — each item:
  - `channel` (string, required) — `email` | `sms` | `push`. **The wire field is
    `channel`, not `type`** (a common SDK mistake; the server rejects unknown
    fields, so `type` 400s the whole request).
  - `address` (string, required).
  - `opted_in` (bool) — defaults to `true`.
  - `verified` (bool, optional) — omit unless set.

Convenience shortcuts in the SDK APIs (`email` / `phone` / `pushToken`) expand to
opted-in `email` / `sms` / `push` channels respectively.

### Push tokens

A push token (FCM registration token, APNs device token) is just a `push`
channel: the token string goes in `address`. APNs device tokens are sent as
lowercase hex.

- **Channels upsert by `(channel, address)`.** On identify, the server upserts
  each incoming channel keyed by its type *and* address. Two different push
  tokens are therefore two distinct channels — sending a new token does NOT
  implicitly remove the old one. `opted_in: false` for a known
  `(channel, address)` opts that channel out (sets `opted_out_at`); it is how a
  stale entry is retired over the wire.
- **Rotation = opt out the old token, opt in the new one.** There is no
  channel-patch endpoint; token refresh rides a **partial identify** — a body
  with `external_user_id` and `channels` only, no `traits` key (traits merge
  server-side, so a partial identify never clears them). When the SDK knows the
  previously sent token, the rotation payload carries both entries:

  ```json
  {
    "external_user_id": "user_8842",
    "channels": [
      { "channel": "push", "address": "<old token>", "opted_in": false },
      { "channel": "push", "address": "<new token>", "opted_in": true }
    ]
  }
  ```

  An SDK instance only ever opts out a token it sent itself, so tokens
  belonging to the user's other devices are never touched — multi-device push
  accumulates safely, and stale tokens from *this* device do not.
- **`setPushToken(token)`** — mobile SDKs expose this capture method:
  - With a current user: enqueue the partial identify (opting out the previous
    token, if any, as above) and flush.
  - Before any `identify()`: buffer the token in memory; the next `identify()`
    attaches it as an opted-in push channel, unless that call supplies its own
    `pushToken` or an explicit push channel. The buffer is memory-only — FCM and
    APNs re-deliver the token on every launch.
  - **Dedup:** the SDK remembers the last (user, token) pair it sent; setting
    the same token again for the same user is a no-op, so wiring
    `onTokenRefresh` / every-launch `getToken()` can't spam identify. A
    different token always sends.
  - `reset()` (logout) clears both the buffered and the last-sent token; after
    the next login the app calls `setPushToken` again.

These flows are executable in [`conformance/push.json`](conformance/push.json).

## Delivery contract

SDKs may differ internally, but they must converge on these outcomes:

| Response | Classification | SDK outcome |
|---|---|---|
| `2xx` | ok | Remove the delivered op/batch from the queue. |
| `401`/`403` | auth | Stop flushing, emit/surface `auth`, retain the op/batch for a later flush. |
| `429`, `5xx`, network/timeout | retry | Retry with bounded backoff; after retries are exhausted, emit/surface `retry_exhausted` and retain the op/batch. |
| other `4xx` | drop | Emit/surface `dropped` and remove the offending op/batch. |

Retries must preserve the same `$message_id` for the same event.

These rules are executable in
[`conformance/behavior.json`](conformance/behavior.json). Add or change behavior
there before changing SDK implementations.
