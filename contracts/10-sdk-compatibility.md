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
  `app_backgrounded`, `screen_viewed`, `push_opened`) — ordinary track events an SDK sends on
  its own ([`SPEC.md`](../SPEC.md) → Automatic events; executable in
  `conformance/automatic.json`; server meaning in [11](11-automatic-events.md)). An SDK that
  sends none of them stays conformant, and older SDK releases are unaffected.

The first two are `context` keys, and `context` is already free-form in v1; `anonymous_id` is an
optional top-level field the server accepts alongside `external_user_id` — so adding any of them
is a *minor* version bump, not a breaking one.

## Breaking-change policy

`envelope_version` is semver. Removing or renaming a field, or adding a required one, is a
**major** bump and requires: a contract PR, coordinator approval, a declared migration window in
which both versions are accepted, and notification to every SDK maintainer before the old version
is retired. No SDK is ever broken by a server deploy.

## Invariants

1. `wire.json`, `behavior.json`, and `push.json` pass unchanged against a 2.0.0 server.
2. No SDK release is required for the launch.
3. A v1 `identify` produces `customer_declared` consent assertions, never inferred ones.
4. A v1 event with no `$mode` is `live`.
5. Adding a `context` key is never a breaking change.
