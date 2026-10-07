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
    `onesignal_sub`. The token type. See [Token kind](#token-kind).
  - `platform` (string, optional, `push` only) — `ios` | `android` | `web` |
    `macos` | `windows` | `linux`.
  - `push_env` (string, optional, `push` only) — `production` | `sandbox`. The
    APNs environment of the token.

Convenience shortcuts in the SDK APIs (`email` / `phone` / `pushToken`) expand to
opted-in `email` / `sms` / `push` channels respectively.

### Reserved trait keys

`traits` is free-form, but two keys are **reserved**: the engine reads them to
decide *when* and *in which language* to reach the user.

| Key | Format | Used for |
|---|---|---|
| `timezone` | IANA tz database name — `Europe/Berlin`, `America/Sao_Paulo` | Quiet hours and send timing. Absent → the engine evaluates them in UTC (a 3 am send for everyone outside UTC). The engine also accepts the legacy aliases `time_zone` / `tz`, checked in that order; SDKs send `timezone`. |
| `locale` | BCP 47 language tag — `de-DE`, `pt-BR`, `zh-Hans-CN` | Message language. |

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

### Push tokens

A push token (FCM registration token, APNs device token, Expo push token) is
just a `push` channel: the token string goes in `address`. APNs device tokens
are sent as lowercase hex. The optional `kind`, `platform` and `push_env`
fields describe the token (see [Token kind](#token-kind)).

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
    op is redelivered.) "Delivered" means a `2xx` on the identify: the token
    was durably accepted for processing (see
    [Acceptance vs processing](#acceptance-vs-processing)). A failure the
    server finds only while processing it is dead-lettered server-side and
    surfaced to the app owner; the SDK never learns of it, keeps the pair,
    and does not resend.
  - `reset()` (logout) clears the buffered token and the last-sent pair —
    including the persisted copy; after the next login the app calls
    `setPushToken` again (which re-registers, since the pair was forgotten).

`identify()` **also rotates.** When an `identify()` call carries an opted-in
push token (via the `pushToken` shortcut or an explicit push channel) that
differs from the last token this SDK sent for that user, it opts the previous
token out in the same body — exactly like `setPushToken`. Passing `pushToken`
to `identify` must not strand the earlier token opted-in.

### Token kind

A push entry may carry three optional fields: `kind`, `platform` and
`push_env`. They tell the server which provider can send to the token. All
three are optional, so an SDK built before them keeps working.

- **SDKs send only what they know.** Swift sends `kind: "apns"`,
  `platform: "ios"`, and `push_env` from the build (a debug build gets
  `sandbox` tokens). An Expo app sends `kind: "expo"`. An SDK that does not know
  a value omits the key. It never guesses.
- **Server inference.** When `kind` is missing, the server infers it from the
  token:
  1. `ExponentPushToken[…]` or `ExpoPushToken[…]` → `expo`.
  2. Exactly 64 hex characters (any case) → `apns`.
  3. Anything else → `fcm`.

  Inference never yields `onesignal_sub`. A OneSignal subscription id must be
  sent with an explicit `kind`.
- **Storage.** An explicit `kind` replaces the stored kind. An inferred kind
  never replaces an explicit one. `platform` and `push_env` replace the stored
  value only when sent.
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
The `kindCases` flows pin the wire shape for SDKs that send these fields.
SDKs that do not send them skip `kindCases`; the original `cases` never use
them.

Most of these flows are executable in
[`conformance/push.json`](conformance/push.json) — including `reset`, the
empty/whitespace-token case, the `identify(pushToken:)` rotation, and the
restart-then-`identify()` restore cases. The mark-on-delivery clearing is the
one flow not pinned there (the push harness never injects delivery failures);
it is covered by per-SDK unit tests.

### Opt-out

Mobile SDKs expose `optOut()` and `optIn()`. The choice is persisted, survives
a restart, and is kept across `reset()`.

- **While opted out the SDK queues and sends nothing.** It discards the queue
  and any buffered push token.
- **`optOut()` tells the server about this device.** When a user is known and
  the SDK holds a last-sent push token for that user, it sends one partial
  identify that opts that token out:

  ```json
  {
    "external_user_id": "user_8842",
    "channels": [
      { "channel": "push", "address": "<this device's token>", "opted_in": false }
    ]
  }
  ```

  The SDK reads the token before it discards the queue. It delivers and
  retries this request like any queued op, also while opted out. After it,
  the SDK sends nothing until `optIn()`.
- **`optOut()` forgets the last-sent pair.** After `optIn()`, the next
  `setPushToken` registers the token again.
- **Scope: this device's push channel only.** Email, SMS, and the user's other
  devices keep their state. `optOut()` does not delete data already sent.

These flows are executable in
[`conformance/push.json`](conformance/push.json).

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
| `push_opened` | The user opens a notification whose data carries `whisperr_message_id` | `whisperr_message_id`, `deep_link` (optional) | **yes** |
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
  (`granted` → `authorized`, `undetermined` → `not_determined`).
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
  `app_backgrounded`, and `push_permission_changed` describe the app or the
  device, not a use of the app, and never count as activity.
- **Derived events can never use these names.** They are raw events reported
  by the device.

These flows are executable in
[`conformance/automatic.json`](conformance/automatic.json). The server-side
meaning is in [`contracts/11`](contracts/11-automatic-events.md).

**Conformance harnesses for every other fixture** (`wire.json`,
`behavior.json`, `push.json`, `anonymous.json`) run the SDK with automatic
events **disabled**. Those fixtures pin exact request sequences, and an
automatic `app_opened` would add requests their steps did not cause. Only the
`automatic.json` harness turns them on.

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
