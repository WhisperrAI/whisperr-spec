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
- [`conformance/anonymous.json`](conformance/anonymous.json) pins the anonymous
  visitor lane (`anonymous_id` before `identify()`, promotion on `identify()`,
  rotation on `reset()`) for the SDKs that implement it (browser first).
- [`conformance/automatic.json`](conformance/automatic.json) holds the reserved
  automatic events (install, update, open, background, screen, push open) as a
  machine-readable catalogue, and pins the flows that send them for the SDKs
  that implement them (mobile: Swift, React Native, Flutter, Kotlin).
- [`conformance/v2.json`](conformance/v2.json) pins the **contract v2** flows
  (restore identify at start, `app_language`, the anonymous push token lane,
  push token fields and re-registration, version keys in `context`) in opt-in
  sections. The v2 push events are in `automatic.json` (`pushEventsV2`). See
  [Contract v2 conformance](#contract-v2-conformance).

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

- `external_user_id` (string) — the customer's own stable user id. Backend
  SDKs always pass it explicitly; client SDKs fill it in from the current user
  once `identify()` has run.
- `anonymous_id` (string, 1–128 chars) — an opaque handle for a visitor who has
  not been identified yet: the same body with `"anonymous_id": "3f2c…"` in place
  of `external_user_id`. The SDK generates it (a UUID v4), keeps it per device /
  browser profile, and sends pre-identify events under it right away instead of
  holding them back; the server attaches them to an anonymous user that
  `identify` later promotes.
- **At least one of `external_user_id` / `anonymous_id` is required.** When
  both are present the event belongs to the identified user and `anonymous_id`
  is ignored for attachment. Sending `external_user_id` alone works exactly as
  before, so backend SDKs and SDKs that still buffer pre-identify events
  locally are unaffected.
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
  Contract v2 SDKs also put the [version keys](#version-context) in `context`.

### Version context

Contract v2. The server needs the app and SDK version of every event to find
a bad release or an old SDK. These `context` keys are **governed**:

| Key | Client SDKs (mobile, web) | Server SDKs |
|---|---|---|
| `app_version` | User-facing app version (`CFBundleShortVersionString`, `versionName`, the configured web release) | Only when the caller configures a release version |
| `app_build` | Build number as a string (`CFBundleVersion`, `versionCode`) | Never |
| `platform` | OS family, as in the [common properties](#common-properties) | Never |
| `sdk_name` | `whisperr-swift` \| `whisperr-flutter` \| `whisperr-react-native` \| `whisperr-web` | `whisperr-node` \| `whisperr-python` \| `whisperr-php` \| `whisperr-dotnet` |
| `sdk_version` | The SDK release version | The SDK release version |
| `locale` | **Never** | **Never** |

- **Every event.** Custom `track()` events and automatic events, identified
  or anonymous. Automatic events keep the same keys in `properties` too
  (unchanged).
- **No value, no key.** An SDK that cannot get a value omits the key. It
  never sends a guess.
- **The SDK never puts `locale` in `context`.** The server reads
  `context.locale` as the message language of that event (see
  [`app_language`](#app_language)). A device locale there would override the
  language the user picked. Only a caller who passes `context.locale` on
  purpose sets it.
- Adding these keys is not a breaking change: `context` is free-form, and the
  server never rejects an event for them.
- They are environment-dependent, so the legacy fixtures never pin them (see
  [Contract v2 conformance](#contract-v2-conformance)). The `versionContext`
  and `serverVersionContext` sections of `v2.json` pin them with injected
  values.

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

- `external_user_id` (string) — required, except in an
  [anonymous identify](#anonymous-identify) (contract v2).
- `anonymous_id` (string, 1–128 chars, optional) — the handle this device sent
  pre-identify events under. When present the server promotes that anonymous
  user — every event and all state attached to it — into `external_user_id`;
  an unknown handle is not an error. This is the explicit verified transition
  [`contracts/03`](contracts/03-identity-authority.md) requires and the only
  way an anonymous user ever becomes an identified one.
- `traits` (object, optional) — omit when empty. Free-form apart from the
  [reserved keys](#reserved-trait-keys) below.
- `preferred_channel` (string, optional) — one of `email` | `sms` | `push`.
- `channels` (array, optional) — each item:
  - `channel` (string, required) — `email` | `sms` | `push`. **The wire field is
    `channel`, not `type`** (a common SDK mistake; the server rejects unknown
    fields, so `type` 400s the whole request).
  - `address` (string, required).
  - `opted_in` (bool) — defaults to `true`.
  - `verified` (bool, optional) — omit unless set.
  - `kind` (string, optional, `push` only) — `fcm` | `apns` | `expo` |
    `onesignal_sub`. The token type. See [Token fields](#token-fields).
  - `platform` (string, optional, `push` only) — `ios` | `android` | `web` |
    `macos` | `windows` | `linux`.
  - `push_env` (string, optional, `push` only) — `production` | `sandbox`. The
    APNs environment of the token.
  - `client_app_id` (string, optional, `push` only, contract v2) — the app
    that owns the token: iOS bundle id, Android package name, web origin.
  - `provider_project` (string, optional, `push` only, contract v2) — the
    provider project of the token: Firebase project id (`fcm`), EAS project
    id (`expo`), OneSignal app id (`onesignal_sub`).

  See [Token fields](#token-fields) for when SDKs send them.

Convenience shortcuts in the SDK APIs (`email` / `phone` / `pushToken`) expand to
opted-in `email` / `sms` / `push` channels respectively.

The [`identify_body`](schemas/wire.schema.json) definition in
`schemas/wire.schema.json` is the machine-readable shape of this body,
including the anonymous identify.

### Anonymous identify

Contract v2. An identify body with `anonymous_id` and **no**
`external_user_id` is an **anonymous identify**:

```json
{
  "anonymous_id": "3f2c9a1e-…",
  "traits": { "app_language": "de" },
  "channels": [
    { "channel": "push", "address": "<token>", "opted_in": true, "kind": "fcm", "platform": "android" }
  ]
}
```

- **Only `traits` and `push` channels.** An `email` or `sms` channel, or
  `preferred_channel`, in an anonymous identify is a `400`. Contacts belong to
  a known user.
- **The server attaches the data to the anonymous user of that handle.** It
  creates the anonymous user when the handle is new. Traits merge as for any
  identify. Push channels upsert by `(channel, address)` under that anonymous
  user.
- **Promotion moves the push channels.** When an identify later carries the
  handle as `anonymous_id` together with `external_user_id`, the server
  promotes the anonymous user ([Anonymous visitors](#anonymous-visitors)), and
  its push channels move to the identified user. When the identified user
  already has a row for the same address, the identified row wins.
- An anonymous identify never creates a link to a known user. Only an identify
  with `external_user_id` does
  ([`contracts/03`](contracts/03-identity-authority.md)).
- SDKs send it for two reasons only: a push token before `identify()`
  ([Push tokens](#push-tokens)) and `setAppLanguage` before `identify()`
  ([`app_language`](#app_language)). SDKs never send an anonymous identify
  without `traits` or `channels`.
- An SDK that does not implement the anonymous event lane creates the handle
  on first need (the first anonymous identify), persists it next to its queue,
  and from then on puts it on every identify as `anonymous_id` until `reset()`
  rotates it. Its pre-identify `track()` events are unchanged.
- **Release order.** A server older than contract v2 rejects an anonymous
  identify, `client_app_id` and `provider_project` with `400` (unknown or
  missing fields). SDKs release contract v2 only after the server is live.

### Reserved trait keys

`traits` is free-form, but three keys are **reserved**: the engine reads them to
decide *when* and *in which language* to reach the user.

| Key | Format | Used for |
|---|---|---|
| `timezone` | IANA tz database name — `Europe/Berlin`, `America/Sao_Paulo` | Quiet hours and send timing. Absent → the engine evaluates them in UTC (a 3 am send for everyone outside UTC). The engine also accepts the legacy aliases `time_zone` / `tz`, checked in that order; SDKs send `timezone`. |
| `locale` | BCP 47 language tag — `de-DE`, `pt-BR`, `zh-Hans-CN` | The device language. Message language fallback. |
| `app_language` | BCP 47 language tag — `de`, `pt-BR` | Contract v2. The language the user picked **in the product**. Message language. See [`app_language`](#app_language). |

**Message language (server).** The server picks the language of a message in
this order: `traits.app_language`, then the `context.locale` of the event that
triggered the message, then `traits.locale`. The first value present wins.

- **Client SDKs populate both by default.** On every `identify()`, the web,
  React Native, Flutter, and Swift SDKs fill in the device's values
  (`Intl.DateTimeFormat().resolvedOptions().timeZone` / `navigator.language`,
  `TimeZone.current` / `Locale.current`, the platform locale, …) whenever the
  runtime can provide them. Server-side SDKs never guess: on a backend the
  process locale and zone are not the user's.
- **Caller-supplied values always win.** A `traits.timezone` / `traits.locale`
  (or a legacy `time_zone` / `tz`) passed to `identify()` is sent verbatim, and
  the SDK adds no default for that key.
- **No value, no key.** An SDK that cannot obtain a value omits the key rather
  than sending a guess — never a wrong zone. Flutter cannot obtain an IANA name
  without a plugin (`DateTime.timeZoneName` is an abbreviation), so it sends
  `timezone_offset_minutes` (integer minutes east of UTC at identify time, e.g.
  `120` for Berlin in summer) instead of `timezone`. The engine reads it as a fallback: when no IANA
  `timezone` is present it builds a fixed-offset zone from the minutes for
  quiet-hours and send-time evaluation; an IANA name always wins when both
  are supplied.
- Both keys travel **inside `traits`** — never top-level. The server rejects
  unknown top-level fields, so a top-level `timezone` 400s the whole request.
- A partial identify (push-token capture, below) carries no `traits`, so it
  never touches these keys.
- The defaults are environment-dependent, so `wire.json` never pins them:
  conformance harnesses run with device defaults disabled, and the
  `identify_reserved_traits_passthrough` case pins only that caller-supplied
  values are sent verbatim under these key names.
- `app_language` is not a device default. The SDK sends it only after the app
  sets it (below).

### `app_language`

Contract v2. `app_language` is the language the user picked in the product.
It is **not** the device locale: a German speaker can run a phone in English
and pick German in the app. Format: a BCP 47 tag, for example `de` or `pt-BR`.

- **Client API: `setAppLanguage(tag)`** (the name follows the SDK's style).
  The app calls it when the user picks a language, and may call it on every
  launch.
  - The SDK trims surrounding white space and changes `_` to `-`
    (`pt_BR` → `pt-BR`). It does not change the case.
  - **Valid tag:** `^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$` after that change. An
    invalid value (including an empty string) is ignored with a debug log. The
    stored value does not change.
  - The SDK **persists** the value next to its queue. It survives a restart
    and `reset()`: it is an app setting on this device, like the notification
    permission. When a new user picks another language, the app calls
    `setAppLanguage` again.
  - **The same value as the stored one sends nothing**, so a call on every
    launch does not spam identify.
  - **`null` clears the stored value and sends nothing.** The server keeps
    the last value it received.
- **What `setAppLanguage` sends.** With a current user: a partial identify
  `{external_user_id, traits: {app_language}}`. Without a user: an
  [anonymous identify](#anonymous-identify)
  `{anonymous_id, traits: {app_language}}`. While opted out: nothing.
- **Every identify carries it.** Each `identify()` call and each
  [restore identify](#restore-identify-at-start) puts the stored value in
  `traits.app_language`. A caller-supplied `traits.app_language` wins for that
  call. A push-token partial identify carries no `traits`, so it does not
  carry `app_language`.
- **Server SDKs:** no new API. The caller passes `traits.app_language` to
  `identify`.

These flows are executable in the `appLanguage` section of
[`conformance/v2.json`](conformance/v2.json).

### Restore identify at start

Contract v2. Traits that come from the device (`timezone`, `locale`) and
`app_language` change while a user stays signed in. Most apps call
`identify()` only at sign-in, so the server never sees the change. A client
SDK therefore identifies the stored user again at app start.

- **When.** At start (a process start on mobile, a page load on the web),
  when the SDK has a stored user id and the user did not opt out, the SDK
  queues one **restore identify**:

  ```json
  {
    "external_user_id": "user_8842",
    "anonymous_id": "3f2c9a1e-…",
    "traits": { "timezone": "Europe/Berlin", "locale": "de-DE", "app_language": "de" }
  }
  ```

  `anonymous_id` only when the SDK stores a handle. `traits` holds the device
  defaults and the stored `app_language` (the **restore traits**); the key is
  omitted when they are empty. **No `channels`.**
- **Same queue.** It goes through the same ordered, persisted queue as every
  other op. Offline, it waits in the queue.
- **At most one per process start.** A return from the background is not a
  start.
- **The app's own `identify()` wins.** When the app calls `identify()` in the
  same tick as construction (common: identify on session restore), the SDK
  skips the restore identify. That call already carries the restore traits.
  An SDK meets this rule in one of two ways: it queues the restore identify
  only after the start tick (for example after its async storage load, or on
  the next run-loop turn) and skips it when `identify()` ran first; or it
  removes a restore identify that is still unsent when `identify()` is called.
- **24-hour throttle.** The SDK keeps a persisted **restore record**
  `{user, restore traits, delivered_at}`:
  - after a `2xx` on an `identify()` call or a restore identify, it stores
    the user, the restore traits it computed when it built that op, and the
    delivery time;
  - after a `2xx` on a `setAppLanguage` partial identify for the same user,
    it updates only `app_language` in the stored restore traits
    (`delivered_at` does not change).

  At start, the SDK skips the restore identify when the record has the same
  user, the restore traits are equal to the ones it would send now, and
  `delivered_at` is less than 24 hours ago. Otherwise it sends it. `reset()`
  and `optOut()` delete the record. The clock is the wall clock (it must
  survive a restart).
- **React Native** persists the user id by default (AsyncStorage when it is
  installed). With no storage available it keeps the user in memory only and
  logs one debug warning. It never crashes.
- **Limit.** The SDK cannot know a user who signed in before the SDK was
  installed. The app must call `identify()` on session restore.
- **Server SDKs** have no stored user and never send a restore identify.

These flows are executable in the `restoreIdentify` section of
[`conformance/v2.json`](conformance/v2.json).

### Anonymous visitors

Client SDKs (browser, mobile) can record behavior before the app knows who the
user is. Implementing this lane is optional — an SDK that buffers pre-identify
events locally and sends them only after `identify()` has filled in
`external_user_id` stays conformant — but an SDK that implements it follows one
lifecycle:

- **One handle per device / browser profile.** The SDK generates `anonymous_id`
  on first use, persists it next to its queue, and puts it on every event sent
  before `identify()`.
- **`identify()` promotes.** The identify body carries the current handle, so
  the anonymous user is merged into the identified one by the customer's own
  claim — never by inference, and never across two different handles.
- **`reset()` (logout) rotates the handle.** The next person on the same device
  is a new anonymous visitor; nothing they do can attach to the previous user.

These flows are executable in
[`conformance/anonymous.json`](conformance/anonymous.json).

Contract v2 uses the same handle for the [anonymous identify](#anonymous-identify)
(a push token or an app language before `identify()`). Mobile SDKs that keep
buffering pre-identify events locally still create a handle for it, on first
need.

### Push tokens

A push token (FCM registration token, APNs device token, Expo push token) is
just a `push` channel: the token string goes in `address`. APNs device tokens
are sent as lowercase hex. The optional `kind`, `platform`, `push_env`,
`client_app_id` and `provider_project` fields describe the token (see
[Token fields](#token-fields)).

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
  - Before any `identify()` — **contract v2 (anonymous push token lane):**
    send the token now in an [anonymous identify](#anonymous-identify)
    `{anonymous_id, channels: [push]}` (with the opt-out of the previous token
    of the same handle, if any, as above). The token is registered from the
    first launch, so a user who never signs in can still get a push. The next
    `identify()` attaches the token (below), and the server moves the
    handle's push channels to the user when it promotes the handle.
  - Before any `identify()` — **legacy (v1):** buffer the token in memory; the
    next `identify()` attaches it as an opted-in push channel, unless that call
    supplies its own `pushToken` or an explicit push channel. The buffer is
    memory-only — FCM and APNs re-deliver the token on every launch. An SDK
    that implements the anonymous push token lane does not buffer.
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
  - **Contract v2: the pair is `(subject, token, sent_at)`.** The subject is
    the user id, or the anonymous id for a token sent in an anonymous
    identify. Dedup, rotation and opt-out compare against the pair of the
    same subject. `sent_at` is the wall-clock time of the delivery (`2xx`).
  - **Contract v2: re-registration every 7 days.** When `setPushToken` gets
    the same token for the same subject and the pair's `sent_at` is 7 days
    (168 hours) ago or more, the SDK sends the registration again (the same
    body as the first one, without an opt-out entry) and stores the new
    `sent_at`. Apps call `setPushToken` at launch, so a live token reaches the
    server at least once a week; the server keeps `last_registered_at` and can
    see a stale token. The SDK never re-sends a token from the stored pair
    alone: only a token the platform just gave proves that the token is still
    current.
  - **Restore is not conditional on `identify()`.** Apps call `identify(user)`
    in the same launch tick as construction, before the async restore resolves.
    The SDK must still restore the persisted last-sent pair; skipping the
    restore because `identify()` already ran leaves the pair null, so a
    post-restart rotation sends no opt-out (stale tokens accumulate) and the
    same-token dedup is defeated (identify spam every launch). Restoring after
    `identify()` is safe: `setPushToken` only ever opts out / dedups against a
    pair whose user matches the current user, so a pair belonging to a prior
    user is ignored on use. Only `reset()` and `optOut()` invalidate the pair
    (in contract v2, `reset()` replaces it with the pair of the new handle).
  - **Mark on delivery, not on enqueue.** The dedup pair records what was
    *delivered*. If the request carrying a token is dropped (a non-retryable
    `4xx`) or evicted from a full queue before delivery, the SDK clears the
    pair for that (user, token) so the next `setPushToken` re-registers it —
    otherwise a single rejected registration wedges the token opted-out of
    every future attempt. (Retryable failures retain the op and the pair; the
    op is redelivered.) "Delivered" means a `2xx` on the identify: the token
    was durably accepted for processing (see
    [Acceptance vs processing](#acceptance-vs-processing)). A failure the
    server finds only while processing it is dead-lettered server-side and
    surfaced to the app owner; the SDK never learns of it, keeps the pair,
    and does not resend.
  - **`reset()` (logout), legacy (v1):** clears the buffered token and the
    last-sent pair — including the persisted copy; after the next login the
    app calls `setPushToken` again (which re-registers, since the pair was
    forgotten).
  - **`reset()` (logout), contract v2: the token moves to the next visitor.**
    The device keeps its token after a logout, so the SDK keeps it
    registered, but never under the user who left. When the SDK holds a
    last-sent pair, `reset()`:
    1. sends a partial identify that opts the token out under the pair's
       subject (`{external_user_id, channels: [{push, token, opted_in: false}]}`,
       or the same with `anonymous_id` for an anonymous pair);
    2. rotates `anonymous_id` (a new handle);
    3. sends an anonymous identify that opts the token in under the new handle
       (with the token fields it knows), and records the new pair.

    With no last-sent pair (for example while the permission is `denied`), it
    sends nothing and only rotates the handle. While opted out, it sends
    nothing.

**`identify()` attaches an anonymous token (contract v2).** When the last-sent
pair's subject is the current anonymous handle, `identify(user)` attaches that
token as an opted-in push channel (with the token fields it knows) in the same
body that promotes the handle, and records the pair under the user. A token
held while the permission is `denied` is not attached. A token registered under
another user is not attached (see [Known limitations](#known-limitations)).

`identify()` **also rotates.** When an `identify()` call carries an opted-in
push token (via the `pushToken` shortcut or an explicit push channel) that
differs from the last token this SDK sent for that user, it opts the previous
token out in the same body — exactly like `setPushToken`. Passing `pushToken`
to `identify` must not strand the earlier token opted-in. In contract v2 the
same applies to the token of the anonymous handle this `identify()` promotes.

The anonymous lane and the v2 `reset()` are executable in the `anonymousPush`
section of [`conformance/v2.json`](conformance/v2.json). That section
supersedes three legacy `push.json` cases (the in-memory buffer, the opt-out of
a buffered token, and the `reset()` that forgets the token).

### Token fields

A push entry may carry five optional wire fields: `kind`, `platform`,
`push_env`, `client_app_id` and `provider_project`. They tell the server which
provider can send to the token, and let it catch a token that belongs to
another app or project before a send. All five are optional on the wire, so an
SDK built before them keeps working.

| Field | Contract v2 SDK rule |
|---|---|
| `kind` | Always send. The SDK knows the token type from its API (Swift: `apns`; an FCM token: `fcm`; Expo: `expo`; OneSignal: `onesignal_sub`). |
| `platform` | Always send (Flutter in FCM mode adds it too). |
| `push_env` | Always send for `kind: apns` (`production` or `sandbox`, from the build's `aps-environment`; a debug build gets `sandbox` tokens). Never for other kinds. Flutter and React Native read it through a small native helper. |
| `client_app_id` | Send when the SDK can read it: iOS bundle id, Android package name, web origin. It lets the server pick the APNs topic and catch a wrong bundle. |
| `provider_project` | Send when available: Firebase project id (`FirebaseApp.options.projectID`) for `fcm`, EAS project id for `expo`, OneSignal app id for `onesignal_sub`. Never for `apns`. It lets the server catch `SENDER_ID_MISMATCH` and a mix of Expo projects before a send. |

- **SDKs send only what they know.** An SDK that cannot read a value omits the
  key. It never guesses. A value the app passes explicitly to the SDK's API
  wins over a detected one.
- **Only on the opted-in entry.** The opt-out entry of a rotated, reset or
  denied token carries only `channel`, `address` and `opted_in: false`.
- **Legacy (v1) SDKs** sent only what they knew of `kind`, `platform` and
  `push_env` (Swift: `kind: "apns"`, `platform: "ios"`, `push_env` from the
  build; Expo: `kind: "expo"`). That stays valid.
- **Server inference.** When `kind` is missing, the server infers it from the
  token:
  1. `ExponentPushToken[…]` or `ExpoPushToken[…]` → `expo`.
  2. Exactly 64 hex characters (any case) → `apns`.
  3. Anything else → `fcm`.

  Inference never yields `onesignal_sub`. A OneSignal subscription id must be
  sent with an explicit `kind`.
- **Storage.** An explicit `kind` replaces the stored kind. An inferred kind
  never replaces an explicit one. `platform`, `push_env`, `client_app_id` and
  `provider_project` replace the stored value only when sent.
- **Rotation.** The opt-out entry for the old token needs only `channel`,
  `address` and `opted_in: false`. The server matches it by address.
- **Lenient.** These fields never fail a request. The server drops an unknown
  value, and drops the fields on an `email` or `sms` entry. A dropped `kind`
  falls back to inference.
- **Delivery.** The server sends to every recent opted-in device of the user.
  It routes each token by its kind to the provider the app set for that kind.
  A token whose kind has no provider is skipped with a reason; the other
  devices still get the message. An app whose default provider is OneSignal
  keeps sending tokens with an inferred kind through OneSignal; only an
  explicit `kind` moves them.

The [`kindInference`](conformance/push.json) table pins the inference rule.
The `kindCases` flows pin the wire shape for SDKs that send `kind`,
`platform` and `push_env` explicitly. SDKs that do not send them skip
`kindCases`; the original `cases` never use them. The `pushRegistration`
section of [`conformance/v2.json`](conformance/v2.json) pins the contract v2
fields (with injected values) and the 7-day re-registration (with an injected
clock).

Most of these flows are executable in
[`conformance/push.json`](conformance/push.json) — including `reset`, the
empty/whitespace-token case, the `identify(pushToken:)` rotation, and the
restart-then-`identify()` restore cases. The mark-on-delivery clearing is the
one flow not pinned there (the push harness never injects delivery failures);
it is covered by per-SDK unit tests.

### Opt-out

Mobile SDKs expose `optOut()` and `optIn()`. The choice is persisted, survives
a restart, and is kept across `reset()`.

- **While opted out the SDK queues and sends nothing else.** It discards the
  queue and any buffered push token. A token passed to `setPushToken` while
  opted out is dropped, not buffered, so `optIn()` does not send it.
- **`optOut()` tells the server about this device.** When the SDK holds a
  last-sent push token pair, it sends one partial identify that opts that
  token out, under the pair's user (which is not always the current user, for
  example after `identify(userB)` without `reset()`):

  ```json
  {
    "external_user_id": "user_8842",
    "channels": [
      { "channel": "push", "address": "<this device's token>", "opted_in": false }
    ]
  }
  ```

  In contract v2 the pair's subject can be the anonymous handle; the opt-out
  then carries `anonymous_id` in place of `external_user_id`.

  The SDK reads the pair before it discards the queue. When the registration
  was still queued, the server never saw the address; it stores the opt-out as
  an opted-out row, which is harmless. The SDK delivers and retries this
  request like any queued op, also while opted out and after a restart. When a
  request that was in flight while `optOut()` ran then fails, the SDK keeps
  only its push opt-out entries, as for queued requests below. After the
  opt-out requests, the SDK sends nothing else until `optIn()`.
- **Queued push opt-outs survive `optOut()`.** When it discards the queue, the
  SDK keeps the `opted_in: false` push entries of the queued identifies (a
  rotation, a denied permission, an earlier `optOut()` not delivered yet), each
  under its own user, ahead of the new opt-out request. A token retired before
  the opt-out is still retired.
- **`optOut()` forgets the last-sent pair.** After `optIn()`, the next
  `setPushToken` registers the token again. A second `optOut()` while opted
  out is a no-op.
- **Older installs converge.** An SDK that finds a persisted opt-out and a
  last-sent pair at start (an earlier SDK version opted out locally only) sends
  the same opt-out request once and forgets the pair.
- **Scope: this device's push channel only.** Email, SMS, and the user's other
  devices keep their state. `optOut()` does not delete data already sent. See
  [Server effect of a push opt-out](#server-effect-of-a-push-opt-out).

These flows are executable in
[`conformance/push.json`](conformance/push.json). The queued, in-flight and
older-install rules are covered by per-SDK unit tests.

### Push permission and the token

The app reports the OS notification permission through the SDK's permission
API, or the SDK reads it (see
[`push_permission_changed`](#automatic-events)). Besides the event, the report
changes this device's push token on the server:

- **`denied` opts this device's token out.** When the SDK holds a last-sent
  pair for the current user, it sends one partial identify that opts that token
  out, under that user:

  ```json
  {
    "external_user_id": "user_8842",
    "channels": [
      { "channel": "push", "address": "<this device's token>", "opted_in": false }
    ]
  }
  ```

  The SDK forgets the pair and holds the token. With no last-sent pair for the
  current user, it sends nothing. A repeated `denied` sends nothing. In
  contract v2, before `identify()` the current subject is the anonymous
  handle: a pair under the handle is opted out under the handle.
- **While the permission is `denied`, the SDK holds tokens.** A token passed
  to `setPushToken`, or buffered before `identify()`, is held and not sent. The
  newest token replaces a held one.
- **`authorized` or `provisional` opts the token back in.** When the SDK holds
  a token and knows the user, it sends one partial identify that opts the held
  token in (`opted_in: true`, with the token fields it knows), and records the
  pair. A rotation while denied registers only the new token: the old token was
  already opted out. In contract v2, with no user, it opts the held token in
  with an [anonymous identify](#anonymous-identify) under the handle. A held
  token is never attached by `identify()`; only the permission report sends
  it.
- **`not_determined` does not opt a held token in or out.** It ends the hold
  for later tokens: the next `setPushToken` is sent as usual.
- **Persistence.** The SDK stores the last reported permission. It survives a
  restart and `reset()`, because the permission belongs to the device, not the
  user. The held token is kept in memory only. After a restart, the app's next
  `setPushToken` call (most apps call it on every launch) supplies it.
- **Opt-out wins.** While opted out, a permission report sends nothing and
  changes no token. `optOut()` drops a held token.
- **Scope: this device's push token only**, as for `optOut()`. The opt-out
  entry is delivered and retried like any queued op. When `optOut()` discards
  the queue, it keeps this entry (see Opt-out above).

- **Asking for the permission (contract v2).** Swift and React Native expose
  `requestPushAuthorization({provisional})` (the name follows the SDK's style;
  Flutter already has it). It shows the OS prompt (or requests provisional
  authorization on iOS when `provisional` is true), reports the result as
  above, and returns the status.

These flows are executable in [`conformance/push.json`](conformance/push.json)
(the `pushPermission` step) and, for the anonymous handle, in the
`anonymousPush` section of [`conformance/v2.json`](conformance/v2.json).

### Server effect of a push opt-out

The server stores channels per `(user, channel, address)`. A push opt-out
(from `optOut()`, a `denied` permission, or a rotation) sets only that row to
opted out. The user's other devices, email and SMS keep their state.

The server counts a user as reachable while any of the user's channels is
opted in. When the opted-out token was the user's only opted-in channel, the
server marks the whole user suppressed with reason `all_channels_opted_out`,
and the engine sends nothing to that user. When a channel is opted in again
(for example, the token after the permission returns), the server clears the
suppression.

### Known limitations

- **User switch without `reset()`.** If the app calls `identify(userB)` while
  `userA`'s token is still registered — without a `reset()` in between — this
  SDK does not opt `userA`'s token out (an SDK instance only ever retires a
  token for the user it belongs to). The token stays opted-in for `userA`.
  Retiring it needs a product decision (server-side retirement on user switch
  vs. SDK-side) and is tracked separately; apps that hand one device between
  users should call `reset()` on logout.

## Automatic events

Client SDKs send a small set of events on their own, so every app has an
activity signal on day one without extra `track()` calls. These names are
**reserved**. Each one is an ordinary `<event>` on `/v1/events/batch`: the wire
format does not change.

| `event_type` | When the SDK sends it | Own properties | User activity |
|---|---|---|---|
| `app_installed` | First launch of an install | `app_version`, `app_build` | no |
| `app_updated` | A launch where the app version or build differs from the stored one | `app_version`, `app_build`, `previous_version`, `previous_build` | no |
| `app_opened` | Every move to the foreground, including the cold start | `cold_start` (bool) | **yes** |
| `app_backgrounded` | Every move to the background | `foreground_ms` (int) | no |
| `screen_viewed` | The app calls the screen API; automatic only where the framework makes it cheap | `screen_name` | **yes** |
| `push_opened` | The user opens a notification whose data carries `whisperr_message_id` | `whisperr_message_id`, `deep_link` (optional), `action_id` and `cold_start` (contract v2) | **yes** |
| `push_received` | Contract v2. The device receives a push whose data carries `whisperr_message_id` | `whisperr_message_id`, `foreground` (bool), `source` | no |
| `push_permission_changed` | The SDK first learns the notification permission, or learns that it changed | `status`, `previous_status` (optional) | no |

The full catalogue, with types and triggers, is machine-readable in
[`conformance/automatic.json`](conformance/automatic.json) (`reserved`,
`commonProperties`).

### Common properties

Every automatic event also carries these **flat** keys in `properties`:

| Key | Format |
|---|---|
| `app_version` | User-facing version as a string — `CFBundleShortVersionString`, `versionName` |
| `app_build` | Build number as a string — `CFBundleVersion`, `versionCode` |
| `platform` | OS family: `ios` \| `android` \| `web` \| `macos` \| `windows` \| `linux` — always present. Never the framework name: an iPad is `ios`; React Native and Flutter on Android are `android`; Flutter desktop is `macos`, `windows`, or `linux`. |
| `os_name` | The same lowercase family value as `platform` — always present |
| `os_version` | OS version as a string — `18.2`, `15` |
| `sdk_name` | `whisperr-swift` \| `whisperr-flutter` \| `whisperr-react-native` \| `whisperr-web` — always present |
| `sdk_version` | The SDK release version as a string — always present |
| `locale` | BCP 47 tag — `de-DE` (same format as the reserved trait) |
| `timezone` | IANA name — `Europe/Berlin` (same format as the reserved trait) |
| `timezone_offset_minutes` | Integer minutes east of UTC — `120`. Only when the IANA name is unknown; never together with `timezone` |

- **No value, no key.** An SDK that cannot get a value omits the key. It never
  sends a guess. Flutter without an IANA source omits `timezone` and sends
  `timezone_offset_minutes` instead (as it does for the identify trait); it
  never puts an offset or an abbreviation in `timezone`.
- The keys are flat (`os_name`, not `os.name`) and live in `properties`, never
  in `context` and never top-level.
- No device model, device name, advertising ID, or IP address. These can
  fingerprint a person and the engine does not need them.

### SDK rules

- **On by default.** Each SDK has one switch that turns all automatic
  lifecycle events off (the name follows the SDK's style, for example
  `automaticEvents: false`). The switch also stops any automatic screen or push
  capture. Explicit calls to the screen API or the push-open API still send.
- **Install and update come from a stored version.** The SDK stores the last
  app version and build it saw, next to its queue, and compares on each launch:
  - nothing stored, and no other SDK state → `app_installed`;
  - something stored that differs (version *or* build) → `app_updated` with the
    stored values as `previous_version` / `previous_build`;
  - the same → nothing.
  The SDK sends `app_installed` / `app_updated` before that launch's
  `app_opened`, then stores the new values. While the switch is off the SDK
  still keeps the stored values current, so turning it on later does not
  report a false install.
- **An SDK upgrade is not an install.** When the SDK finds state an earlier SDK
  version wrote (a stored user, an anonymous handle, or a queue) but no stored
  app version, it stores the version and sends nothing.
- **`app_opened` on every foreground.** `cold_start` is `true` for the first
  foreground of the process and `false` for a return from the background.
- **`app_backgrounded` carries `foreground_ms`**: whole milliseconds since the
  matching `app_opened`, measured on a monotonic clock. The SDK flushes after it
  queues this event (the existing flush-on-background).
- **`screen_viewed`.** Every mobile SDK exposes a manual screen API that sends
  `screen_viewed` with `screen_name`. Automatic capture is optional and only
  where the framework gives a cheap hook (React Navigation / Expo Router,
  Flutter `NavigatorObserver`). UIKit and SwiftUI have no reliable screen name,
  so Swift capture stays explicit (a SwiftUI view modifier that calls the
  screen API is fine).
- **`push_opened` only for Whisperr messages.** The SDK reads
  `whisperr_message_id` from the notification data and copies `deep_link` when
  the data has one. A notification without `whisperr_message_id` sends nothing.
  The data key for the link is `whisperr_deep_link`; SDKs also accept
  `deep_link`, so payloads built before this key keep working. The event
  property is always `deep_link`. A rich-push image URL rides in
  `whisperr_image_url`.
- **`push_opened` v2 properties.** `action_id` is `default` for a tap on the
  notification body (iOS `UNNotificationDefaultActionIdentifier`, an Android
  content intent), otherwise the identifier of the action button the user
  tapped. `cold_start` is `true` when the open launched the app process (the
  app reads it as the initial notification: `launchOptions`,
  `getInitialMessage`, `getLastNotificationResponseAsync`), and `false` when
  the app was already running.
- **`push_received` (contract v2) records that a Whisperr push reached the
  device.** Only for pushes whose data carries `whisperr_message_id`; a push
  without it sends nothing. `foreground` is `true` when the app was in the
  foreground when the push arrived. `source` names the code path that saw it:
  `foreground` (the in-app foreground handler), `nse` (an iOS Notification
  Service Extension), `android_service` (the Android messaging service),
  `expo_task` (an Expo background task). **Dedupe by message id on this
  device:** the SDK sends one `push_received` per `whisperr_message_id`, even
  when two paths see the same push (an NSE and the foreground handler). Every
  mobile SDK reports foreground receipt; background receipt is optional and
  only where it is cheap. FCM notification messages in the background never
  reach app code, so Android background receipt is unknown for them. The off
  switch stops `push_received`. It follows the identity and opt-out rules of
  every event.
- **`push_permission_changed` reports the notification permission.**
  `status` is `authorized`, `provisional`, `denied`, or `not_determined`
  (iOS ephemeral App Clip permission reports as `authorized`). The SDK stores
  the last status it sent, next to its queue, and sends the event only when it
  has no stored status or the new status differs; `previous_status` carries the
  stored value. Where the platform can read the permission without a prompt
  (iOS `getNotificationSettings`), the SDK reads it on each move to the
  foreground; the off switch stops this read. The app can always report it
  through the SDK's permission API. `reset()` forgets the stored status, so the
  next user on the device gets a fresh report. While the user is opted out the
  SDK sends nothing and keeps the stored status unchanged. The event is the only
  record of the permission: an SDK does not also send it as an identify trait.
  An SDK whose permission API uses other names maps them to these values
  (`granted` → `authorized`, `undetermined` → `not_determined`). The report
  also opts this device's push token out (`denied`) or back in (`authorized`,
  `provisional`); see
  [Push permission and the token](#push-permission-and-the-token).
- **Identity is unchanged.** Automatic events follow the same rules as any
  `track()`: `external_user_id` after `identify()`; before it, the anonymous
  lane or the SDK's local pre-identify buffer. An automatic event never throws
  before `identify()`.
- **Do not double-track.** A manual `track("app_opened")` still works, but it
  duplicates the automatic event. Apps that already track these names turn the
  switch off. SDKs may log a debug warning for a manual `track()` with a
  reserved name while the switch is on.
- **Browser SDKs** may implement the lifecycle events (`platform: "web"`, page
  load as the cold start, `visibilitychange` for foreground and background).
  They are not required to.

### Server rules

- **Accepted for every app without registration.** An app never has to
  register a reserved name. The server stores the event as a known (mapped)
  event even when the app's event registry does not list it. It does not
  validate the properties: unknown extra keys are kept, both `timezone` and
  `timezone_offset_minutes` are accepted, an unknown `platform` value is
  stored as sent (breakdowns group it as `other`), and duplicate
  `app_installed` / `app_updated` events from a reinstall are tolerated.
- **A customer event with the same name still works.** An app may register a
  reserved name (for example a PR agent that adds `app_opened`). The
  registration supplies the label and schema; the code keeps its meaning.
- **Activity.** Only `app_opened`, `screen_viewed`, and `push_opened` (and the
  app's own events) make a user active. `app_installed`, `app_updated`,
  `app_backgrounded`, `push_permission_changed`, and `push_received` describe
  the app or the device, not a use of the app, and never count as activity.
  A push that arrives is not a return to the app.
- **Derived events can never use these names.** They are raw events reported
  by the device.

These flows are executable in
[`conformance/automatic.json`](conformance/automatic.json). The server-side
meaning is in [`contracts/11`](contracts/11-automatic-events.md).

**Conformance harnesses for every other fixture** (`wire.json`,
`behavior.json`, `push.json`, `anonymous.json`, `v2.json`) run the SDK with
automatic events **disabled**. Those fixtures pin exact request sequences, and
an automatic `app_opened` would add requests their steps did not cause. Only
the `automatic.json` harness turns them on.

## Billing fallback events

Contract v2 reserves eleven event names for membership (billing) facts. The
names and properties come from the playbook engine spec §3.8 (membership
slots). The HotCard backend already sends them in this form.

**Sender: the app's backend, never the front end.** Per §3.8, membership facts
come from a billing source (Stripe, RevenueCat) or from the app's backend in
the same normalized form. An app with no billing source connected sends them
from its backend with a server SDK `track()`. Client SDKs do not block these
names in `track()`, but apps must not send them from the device: a client
cannot know the store's view of the membership.

| `event_type` | Meaning | Own properties |
|---|---|---|
| `trial_started` | A free trial starts | `trial_length_days`, `trial_ends_at`, `plan_period` |
| `trial_converted` | The trial converts; the first paid period starts | `plan_period`, `current_period_ends_at` |
| `trial_auto_renew_disabled` | The trial is cancelled | `trial_ends_at`, `store_cancel_reason` |
| `membership_started` | A paid start (never a renewal or a crossgrade) | `plan_period`, `is_resubscribe`, `is_first_ever`, `access_source`, `entitlements`, `current_period_ends_at` |
| `renewal_succeeded` | A paid period renews | `paid_periods_count`, `current_period_ends_at` |
| `auto_renew_disabled` | Cancel pending; access continues | `access_ends_at`, `store_cancel_reason` |
| `auto_renew_enabled` | The cancel is undone | — |
| `membership_ended` | Access ends | `end_reason`, `plan_period`, `paid_periods_count` |
| `billing_issue_started` | A payment failed | `has_access`, `grace_ends_at` |
| `billing_recovered` | The payment issue is resolved | — |
| `refund_granted` | The store granted a refund | — |

**Money properties** on every one of these events, where they apply:
`plan_id`, `price`, `currency`, `transaction_id`, `store`.

| Key | Format |
|---|---|
| `plan_id` | The store or billing plan (product) id |
| `price` | Number in major units — `9.99`, never cents |
| `currency` | ISO 4217, upper case — `EUR` |
| `transaction_id` | The store or billing transaction id |
| `store` | Free string — `app_store`, `play_store`, `stripe` |
| `plan_period` | ISO 8601 duration of one billing period — `P1W`, `P1M`, `P3M`, `P1Y` |
| `trial_length_days` | Integer days |
| `trial_ends_at`, `current_period_ends_at`, `access_ends_at`, `grace_ends_at` | RFC 3339 timestamp with a zone — `2026-11-12T12:00:00Z` |
| `is_resubscribe`, `is_first_ever`, `has_access` | Boolean |
| `entitlements` | Array of entitlement ids |
| `paid_periods_count` | Integer, paid periods so far |

**Closed lists (§3.8).** They have different names so they cannot be mixed up:

| Key | Values |
|---|---|
| `store_cancel_reason` (on `trial_auto_renew_disabled`, `auto_renew_disabled`) | `unsubscribe`, `billing_error`, `developer_initiated`, `price_increase`, `customer_support`, `unknown` |
| `end_reason` (on `membership_ended`) | `voluntary`, `billing`, `price_increase`, `product_unavailable`, `developer_initiated`, `refund`, `other` |
| `access_source` (on `membership_started`) | `self_subscription`, `lifetime`, `family_share`, `promotional`, `sponsored`, `web_other` |

- **No value, no key.** Every property is optional on the wire. The engine
  needs some of them to send for real (for example `trial_ends_at`,
  `access_ends_at`); see the playbook.
- These are names only. They are ordinary `<event>` bodies; the wire does not
  change. Today the server stores them only after the app registers them (the
  MCP registers them). Acceptance without registration is a later server
  change.
- An app with a connected billing source does not need to send them.
- The [`billing_event`](schemas/wire.schema.json) definition in
  `schemas/wire.schema.json` is the machine-readable catalogue. It lists, per
  name, the properties a sender produces. The server keeps unknown extra keys.

## Contract v2 conformance

Contract v2 adds the restore identify, `app_language`, the anonymous identify
and push token lane, the push token fields and re-registration, the version
context keys, `push_received`, and the v2 `push_opened` properties. The legacy
fixtures keep their meaning: an SDK that implements none of v2 still passes
them and stays conformant to v1.

**Where the cases are.**

| Fixture | Section | Feature | SDKs |
|---|---|---|---|
| `v2.json` | `restoreIdentify` | [Restore identify at start](#restore-identify-at-start) | mobile, web |
| `v2.json` | `appLanguage` | [`app_language`](#app_language) | mobile, web |
| `v2.json` | `anonymousPush` | [Anonymous push token lane](#push-tokens) and the v2 `reset()` | mobile |
| `v2.json` | `pushRegistration` | [Token fields](#token-fields), 7-day re-registration | mobile |
| `v2.json` | `versionContext` | [Version context](#version-context), client | mobile, web |
| `v2.json` | `serverVersionContext` | [Version context](#version-context), server | server |
| `automatic.json` | `pushEventsV2` | `push_received`, `push_opened` `action_id` / `cold_start` | mobile |

**How a harness opts in.**

1. Load `v2.json` from the same directory as `wire.json` (as the push,
   anonymous and automatic suites do), or from `WHISPERR_V2_SPEC_PATH`.
2. Run each section the SDK implements and whose `appliesTo` names its kind of
   SDK. Sections are independent: an SDK can ship them one at a time.
3. For each section it runs, skip the legacy cases the section lists in
   `supersedes` (`<file>:<case name>`). Those cases pin v1 behavior that the v2
   feature changes on purpose (for example, the in-memory token buffer). Run
   every other legacy case unchanged.
4. For `pushEventsV2`, run its cases on the `automatic.json` harness with the
   two new steps (`receivePush`, `openPush`), and skip its `supersedes` cases.

**Environment switch.** Every v2 harness can turn the SDK's environment
detection on or off: device default traits (`timezone`, `locale`), the
version context keys, and detected push token fields (`platform`,
`push_env`, `client_app_id`, `provider_project`). The legacy harnesses run
with it **off** (as they already do for the reserved trait defaults), so a v2
SDK adds none of these keys there. A `v2.json` case turns it **on** with a
`device` block and injects the values; a missing key means the runtime cannot
supply it. `$platform`, `$sdk_name` and `$sdk_version` are placeholders for
the SDK's own values.

**Clock.** Restore identify and push re-registration use persisted
wall-clock timestamps. `v2.json` cases move an injected clock with
`advanceClock`. Without a clock step, a whole legacy case runs within one
instant, so the 24-hour throttle and the 7-day re-registration never change a
legacy expectation. (A legacy restart of a stored user within 24 hours, with
the same restore traits, sends no restore identify.)

**Anonymous handle.** On an identify body that carries `external_user_id`,
the v2 harness ignores `anonymous_id` when the expected body does not name it,
because an SDK may hold a handle for its anonymous event lane. A harness for
such an SDK may apply the same rule to the legacy `push.json` cases.

The full harness rules are in the `description` of `v2.json` and of
`pushEventsV2`.

## Delivery contract

SDKs may differ internally, but they must converge on these outcomes:

| Response | Classification | SDK outcome |
|---|---|---|
| `2xx` | ok | Remove the delivered op/batch from the queue. A `2xx` means *durably accepted for processing*, not processed — see [Acceptance vs processing](#acceptance-vs-processing). |
| `401`/`403` | auth | Stop flushing, emit/surface `auth`, retain the op/batch for a later flush. |
| `429`, `5xx`, network/timeout | retry | Retry with bounded backoff; after retries are exhausted, emit/surface `retry_exhausted` and retain the op/batch. |
| other `4xx` | drop | Emit/surface `dropped` and remove the offending op/batch. |

Retries must preserve the same `$message_id` for the same event.

When a `429` or `503` response carries `Retry-After` (delay-seconds or
HTTP-date, RFC 9110 §10.2.3), SDKs MUST wait at least that long before the
next retry of that request, capped at 60 seconds, instead of their computed
backoff. An absent or unparseable value falls back to the backoff. Honoring
`Retry-After` does not reset or extend the retry limit.

Browser SDKs SHOULD flush queued ops when the page is hidden or unloaded
(`visibilitychange` → `hidden`, `pagehide`) using `fetch` with `keepalive`,
staying within the 64 KiB in-flight keepalive quota. Ops MUST remain queued
until a response confirms them (at-least-once); the backend resolves
duplicates by `$message_id`. Ops left queued are delivered on the next load
with their original `occurred_at`, so data arrives late — which is why the
exit flush matters.

### Acceptance vs processing

Ingestion is **accept fast, process asynchronously**. On `track`, `batch`,
and `identify` the server validates only the shape of the request (valid
JSON, known fields, sizes, `snake_case` `event_type`, the `occurred_at`
window, …), durably records it, and answers `202`. Everything that needs
server state — resolving the user, applying traits and channels, evaluating
the event — happens after the response, normally within seconds.

| Endpoint | Success response |
|---|---|
| `POST /v1/events/batch` | `202 {"accepted": N, "rejected": M}` |
| `POST /v1/events/track` | `202 {"event": {"mapping_status": "pending"}, "processing": "queued"}` |
| `POST /v1/identify` | `202 {"processing": "queued"}` |

- **`2xx` means durably accepted, not processed or delivered.** Once an SDK
  sees a `2xx` the server owns the op; the SDK dequeues it and never resends
  it. SDKs MUST classify on the status class, never on an exact status code
  or on response fields beyond those listed here.
- **Batch `rejected`** counts only events that failed request-shape
  validation (unknown field, bad `event_type`, `occurred_at` out of window,
  …); the rest of the batch is accepted. Request-level problems — invalid
  JSON, an unknown top-level field, an empty or oversized `events` array —
  still fail the whole request with `400`.
- **Rejections that need server state happen after the `202`** and are not
  returned to the caller. They are recorded as dead letters the app owner
  sees in the dashboard, and only the offending event or identify is
  affected — never the rest of its batch, and never the SDK's queue:
  - `derived_event_code` — the `event_type` is an event Whisperr computes
    itself and cannot be sent through ingestion (previously `422` on
    `track`, counted in `rejected` on `batch`).
  - `contact_change_requires_server_key` — the request changes an existing
    email or phone with a publishable key (previously a `403`, which also
    failed the whole batch and, because `403` classifies as `auth`, stalled
    the SDK queue).
- **Identify and track are applied in the order they were accepted**, per
  app. Events a visitor sent under `anonymous_id` before `identify()` are
  therefore always promoted by that `identify`, and a track sent after an
  `identify` sees its traits and channels. SDKs keep this guarantee by
  sending `identify` through the same ordered queue as `track` — never
  around it. (This is the order requests are *applied* in; an event's
  place on the user's timeline is still its `occurred_at`.)
- Duplicates are still resolved server-side by `$message_id`.
- Unchanged by async accept: `400` (invalid request), `401`/`403` (missing,
  invalid, or revoked key), `413` (payload too large), and `429` (rate
  limited, with `Retry-After`) are returned synchronously and classified as
  in the table above.

These rules are executable in
[`conformance/behavior.json`](conformance/behavior.json). Add or change behavior
there before changing SDK implementations.
