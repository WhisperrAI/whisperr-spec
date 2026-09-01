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
| `event_type` | `event.code` | identical `snake_case` rule |
| `occurred_at` | `time.occurred_at` | identical RFC3339-ms-Z rule and ±window |
| — | `time.received_at` | server-assigned |
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
| browser/mobile before `identify()` — buffered anonymous events | `anonymous_capable` |

The customer's own SDK asserting their own user id is authoritative by definition. Anonymous
buffering promotes only through the SDK's existing `identify()` backfill, which is the explicit
verified transition [03](03-identity-authority.md) requires.

## What 2.0.0 adds, optionally

Nothing below is required. An SDK that implements none of it stays fully conformant.

- `context.$mode: "test"` — lets an SDK submit isolated validation events directly, useful for
  the X20 executor playbook. Absent means `live`.
- `context.$occurrence_key` — lets an SDK correlate an event it emits with the same occurrence
  arriving from a provider webhook. Absent means no correlation, which is the safe default.

Both are `context` keys, and `context` is already free-form in v1 — so adding them is a *minor*
version bump, not a breaking one.

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
