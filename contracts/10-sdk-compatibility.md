# 10 — SDK compatibility rules

**The headline: 2.0.0 requires no SDK release.** Ten SDKs hand-implement the v1 ingestion
contract (`@whisperr/web`, `@whisperr/react`, `@whisperr/next`, `@whisperr/react-native`,
`whisperr-flutter`, `whisperr-swift`, `@whisperr/node`, `Whisperr` for .NET, `whisperr` for
Python, `whisperr/php`). Requiring a coordinated release across all ten would put the SDK fleet on
the launch critical path. It is not, and it must not be.

## The v1 wire format is unchanged

[`SPEC.md`](../SPEC.md) remains authoritative for SDKs. `conformance/wire.json`,
`conformance/behavior.json`, and `conformance/push.json` are **unchanged by 2.0.0** and still gate
every SDK. The endpoints `/v1/events/track`, `/v1/events/batch`, and `/v1/identify` keep their
exact bodies, headers, and semantics.

The v1 format becomes the **`sdk` source profile** inside 2.0.0. The server maps it into the
canonical envelope on ingest.

## Mapping — v1 wire → canonical envelope

| v1 field | envelope field | note |
|---|---|---|
| `external_user_id` | `subject.customer_stable_id` | the customer's own id |
| `anonymous_id` | `subject.source_subject_id`, `authority: anonymous_capable` | the SDK's device handle; `customer_stable_id` is set when `identify` promotes it |
| `event_type` | `event.code` | identical `snake_case` rule |
| `occurred_at` | `time.occurred_at` | identical RFC3339-ms-Z rule and ±window |
| — | `time.accepted_at` | server-assigned when the request is durably accepted (the `2xx`) |
| — | `time.received_at` | server-assigned when the event is processed |
| `properties` | `event.properties` | filtered by the registered `payload_schema` |
| `context.$message_id` | `correlation.idempotency_key` | already stable across retries per `SPEC.md` |
| `X-API-Key` / `Bearer` | `origin.connection_id` | resolved from the ingestion key |
| — | `origin.source_kind` | `"sdk"` |
| — | `mode` | `"live"`, unless the key is a test-mode key |
| `identify.traits` | approved traits only | allowlist per [03](03-identity-authority.md) |
| `identify.channels[]` | consent assertions, `basis: customer_declared` | see [04](04-consent-assertion.md) |
| `identify.channels[].address` | stored **encrypted**, delivery modes only | [07](07-delivery-relay.md) |

Two mappings deserve emphasis:

- **`$message_id` → `idempotency_key`.** `SPEC.md` already requires it to be stable across
  retries of the same event, which is exactly the property the envelope needs. No SDK change.
- **`channels[].opted_in` → `customer_declared` consent.** The customer supplying a channel *is*
  an assertion, not an inference ([04](04-consent-assertion.md)). This keeps existing SDK
  behavior valid while the "never inferred" rule still bites on webhook-observed addresses.

## Identity authority of the SDK source

| situation | mode |
|---|---|
| explicit `external_user_id` (all backend SDKs; browser after `identify()`) | `authoritative` |
| browser/mobile before `identify()` — events sent under `anonymous_id` | `anonymous_capable` |

The customer's own SDK asserting their own user id is authoritative by definition. An anonymous
handle promotes only when the SDK's `identify()` carries it as `anonymous_id` — that call is the
explicit verified transition [03](03-identity-authority.md) requires; the server never infers the
link. An SDK that still buffers pre-identify events locally and sends them only after `identify()`
has filled in `external_user_id` never creates an anonymous handle and stays conformant.

## What 2.0.0 adds, optionally

Nothing below is required. An SDK that implements none of it stays fully conformant.

- `context.$mode: "test"` — lets an SDK submit isolated validation events directly, useful for
  the X20 executor playbook. Absent means `live`.
- `context.$occurrence_key` — lets an SDK correlate an event it emits with the same occurrence
  arriving from a provider webhook. Absent means no correlation, which is the safe default.
- `anonymous_id` on `track` and `identify` — lets a client SDK send pre-identify events right away
  under a device handle and have `identify()` promote them ([`SPEC.md`](../SPEC.md) → Anonymous
  visitors; executable in `conformance/anonymous.json`). An SDK that keeps buffering locally is
  unaffected.

- The reserved automatic events (`app_installed`, `app_updated`, `app_opened`,
  `app_backgrounded`, `screen_viewed`, `push_opened`, `push_permission_changed`, `push_received`) — ordinary track events an SDK sends on
  its own ([`SPEC.md`](../SPEC.md) → Automatic events; executable in
  `conformance/automatic.json`; server meaning in [11](11-automatic-events.md)). An SDK that
  sends none of them stays conformant, and older SDK releases are unaffected.

- **SDK contract v2** ([`SPEC.md`](../SPEC.md) → Contract v2 conformance; executable in
  `conformance/v2.json` and `automatic.json` → `pushEventsV2`): the restore identify at start,
  the reserved trait `app_language`, the anonymous identify (`anonymous_id` without
  `external_user_id`; traits and push channels only), the push channel fields `client_app_id`
  and `provider_project`, the 7-day push re-registration, the version keys in `context`, and
  `push_received`. Each feature is an opt-in section; an SDK that implements none of it stays
  conformant to v1.

- **Signals v3** ([`SPEC.md`](../SPEC.md) → Engagement signals; executable in
  `automatic.json` → `signalsV3`), client SDKs only. A v3 client SDK **must** send
  `context.session_id` on every event, `launch_source` on every `app_opened`, and the per-visit
  counters on every `app_backgrounded`. It adds the reserved `app_error` (uncaught errors and the
  public `trackError(error, {screen?, kind?})`, at most one per fingerprint and 20 per session,
  turned off by `captureErrors: false`) and, on mobile, `app_crashed` (unclean-shutdown flag,
  upgraded by a recorded fatal; never in a debug build). All of it is new keys in free-form
  `context` / `properties` plus two new reserved names, so it is a *minor* SDK bump. **Release
  order:** this spec, then the server that reserves `app_error` and `app_crashed` (an older server
  treats them as unregistered codes), then SDK releases. An SDK that implements none of it stays
  conformant.

The first two are `context` keys, and `context` is already free-form in v1; `anonymous_id` is an
optional top-level field the server accepts alongside `external_user_id` — so adding any of them
is a *minor* version bump, not a breaking one.

Contract v2 is also additive for the server: v1 bodies keep their meaning. But a server older than
v2 rejects an anonymous identify (`external_user_id` missing) and the unknown fields
`client_app_id` / `provider_project` with `400`. **Release order:** this spec, then the server,
then SDK releases. No SDK may release a v2 identify shape before the server that accepts it is
live.

## Breaking-change policy

`envelope_version` is semver. Removing or renaming a field, or adding a required one, is a
**major** bump and requires: a contract PR, coordinator approval, a declared migration window in
which both versions are accepted, and notification to every SDK maintainer before the old version
is retired. No SDK is ever broken by a server deploy.

## Invariants

1. `wire.json`, `behavior.json`, and `push.json` pass unchanged against a 2.0.0 server. A v2 SDK
   still passes every legacy case that no v2 section it runs lists in `supersedes`.
2. No SDK release is required for the launch.
3. A v1 `identify` produces `customer_declared` consent assertions, never inferred ones.
4. A v1 event with no `$mode` is `live`.
5. Adding a `context` key is never a breaking change.
