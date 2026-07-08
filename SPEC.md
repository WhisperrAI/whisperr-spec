# Whisperr SDK spec

The single source of truth for the ingestion contract every Whisperr SDK must
produce and honor.
The SDKs (`@whisperr/web`, `@whisperr/react`, `@whisperr/next`,
`@whisperr/react-native`, `whisperr-flutter`, `whisperr-swift`, `@whisperr/node`,
`Whisperr` for .NET, `whisperr` for Python, `whisperr/php`) each hand-implement
this contract, so the fixtures pin the expected behavior:

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
  - **Empty / whitespace token:** silently ignored — no buffer, no request.
    `getToken()` can return an empty string before the device has registered,
    and `setPushToken` is documented as safe to call on every launch, so an
    empty token must be a no-op (not an error and not a buffered value). All
    SDKs agree on silent-ignore.
  - **Dedup (persisted):** the SDK remembers the last (user, token) pair it
    *delivered* and persists it through the SDK's storage layer, alongside the
    persisted identity. Setting the same token again for the same user is a
    no-op — including after an app restart — so wiring `onTokenRefresh` /
    every-launch `getToken()` can't spam identify. A different token always
    sends, and because the last-sent pair survives restarts, a rotation that
    happens after a relaunch still opts out the stale token. Without
    persistence the every-launch `getToken()` wiring would re-send identify on
    each start and a post-restart rotation would strand the old token
    forever — persistence is required, not optional.
  - **Restore is not conditional on `identify()`.** Apps call `identify(user)`
    in the same launch tick as construction, before the async restore resolves.
    The SDK must still restore the persisted last-sent pair; skipping the
    restore because `identify()` already ran leaves the pair null, so a
    post-restart rotation sends no opt-out (stale tokens accumulate) and the
    same-token dedup is defeated (identify spam every launch). Restoring after
    `identify()` is safe: `setPushToken` only ever opts out / dedups against a
    pair whose user matches the current user, so a pair belonging to a prior
    user is ignored on use. Only `reset()` invalidates the pair.
  - **Mark on delivery, not on enqueue.** The dedup pair records what was
    *delivered*. If the request carrying a token is dropped (a non-retryable
    `4xx`) or evicted from a full queue before delivery, the SDK clears the
    pair for that (user, token) so the next `setPushToken` re-registers it —
    otherwise a single rejected registration wedges the token opted-out of
    every future attempt. (Retryable failures retain the op and the pair; the
    op is redelivered.)
  - `reset()` (logout) clears the buffered token and the last-sent pair —
    including the persisted copy; after the next login the app calls
    `setPushToken` again (which re-registers, since the pair was forgotten).

`identify()` **also rotates.** When an `identify()` call carries an opted-in
push token (via the `pushToken` shortcut or an explicit push channel) that
differs from the last token this SDK sent for that user, it opts the previous
token out in the same body — exactly like `setPushToken`. Passing `pushToken`
to `identify` must not strand the earlier token opted-in.

Most of these flows are executable in
[`conformance/push.json`](conformance/push.json) — including `reset`, the
empty/whitespace-token case, the `identify(pushToken:)` rotation, and the
restart-then-`identify()` restore cases. The mark-on-delivery clearing is the
one flow not pinned there (the push harness never injects delivery failures);
it is covered by per-SDK unit tests.

### Known limitations

- **User switch without `reset()`.** If the app calls `identify(userB)` while
  `userA`'s token is still registered — without a `reset()` in between — this
  SDK does not opt `userA`'s token out (an SDK instance only ever retires a
  token for the user it belongs to). The token stays opted-in for `userA`.
  Retiring it needs a product decision (server-side retirement on user switch
  vs. SDK-side) and is tracked separately; apps that hand one device between
  users should call `reset()` on logout.

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
