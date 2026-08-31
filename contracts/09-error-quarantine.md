# 09 — Error and quarantine taxonomy

Schema: [`../schemas/quarantine.schema.json`](../schemas/quarantine.schema.json)

Where a failure goes, and how it gets repaired. The governing invariant:

> **Every acknowledged delivery is `completed`, `retrying`, `quarantined`, or `dead_lettered`.
> Never silently missing.**

## The five dispositions

```text
inbound delivery
   │
   ├─ rejected      — refused BEFORE acknowledge. The provider will retry (or not). Nothing stored.
   │
   └─ acknowledged  — now Whisperr owns it, and it must end in exactly one of:
        ├─ completed
        ├─ retrying       — transient; a bounded schedule is running
        ├─ quarantined    — needs repair; replayable
        ├─ dead_lettered  — retries exhausted or permanently malformed; manually replayable
        └─ suppressed     — deliberately not acted on. NOT a failure.
```

## `rejected` — before acknowledge

| code | when |
|---|---|
| `signature_invalid` | signature verification failed |
| `timestamp_out_of_window` | outside +5 min / −30 days |
| `payload_too_large` | over the per-connector size limit |
| `content_type_invalid` | wrong content type |
| `contract_version_unsupported` | envelope/manifest version this build cannot handle |

Rejection happens **before** anything durable is written, per the F12 order: verify signature and
timestamp → validate size and content type → extract the allowlisted projection → atomically
persist delivery + work item → acknowledge. Nothing before the acknowledge point is retained.

## `quarantined` — after acknowledge, needs repair

| code | meaning | smallest repair action |
|---|---|---|
| `identity_conflict` | two claims disagree ([03](03-identity-authority.md)) | confirm which subject id is correct |
| `unregistered_event_code` | no committed revision defines this code | register it, or map it to an existing code |
| `schema_violation` | payload does not match the registered `payload_schema` | fix the emitter, or widen the schema |
| `mapping_ambiguous` | a provider signal maps to more than one event code | disambiguate the mapping |
| `catalog_reference_invalid` | a referenced item is not in the catalog | resync the catalog |
| `consent_missing_for_required_channel` | an intervention needs a channel with no assertion | collect consent |

Every quarantine entry carries: `class`, `code`, `connection_id`, occurrence references, a
**smallest repair action**, and `replayable: true|false`. Every quarantine has a replay path and a
repair path — a quarantine with no way out is a bug, not a state.

## `retrying` and `dead_lettered`

| code | disposition |
|---|---|
| `transient_provider_error` | retrying |
| `rate_limited` | retrying (honours provider backoff) |
| `downstream_unavailable` | retrying |
| `lease_lost` | retrying (recovered by lease expiry) |
| `retry_exhausted` | dead_lettered |
| `permanently_malformed` | dead_lettered |

Dead-lettered items are manually replayable after repair. They are not deleted.

## `suppressed` — intentional, and not a failure

| code | meaning |
|---|---|
| `test_mode` | `mode: test`; correctly did not reach production ([01](01-event-envelope.md)) |
| `consent_blocked` | consent unknown or opted out ([04](04-consent-assertion.md)) |
| `catalog_uncertain` | offer suppressed on stale or unavailable catalog ([06](06-catalog-projection.md)) |
| `expired` | past `expires_at` ([07](07-delivery-relay.md)) |
| `intervention_paused` | dependent connector degraded ([08](08-coverage-health.md)) |

Suppressions are **counted and visible**. "We correctly did not send this" is an outcome the
customer can see, not an absence they have to infer. This distinction matters: a suppression dashboard
that looks like an error dashboard trains people to ignore both.

## Isolation

Per-source queues, circuit breakers, and rate limits mean one broken connector never stops
another. A connector whose circuit is open is `Needs attention` for its own capabilities and has
**no effect** on any other connection's state or throughput. This is a fixture case for every
connector, not an aspiration.

## Invariants

1. Every acknowledged delivery ends in exactly one disposition. (invariant test under fault injection)
2. Nothing is stored before the acknowledge point for a `rejected` delivery.
3. Every quarantine entry has a smallest repair action and a replay path.
4. A crash after acknowledge is recovered by lease expiry and processed exactly once.
5. One source's open circuit leaves every other source unaffected. (isolation test)
6. Suppressions are counted and visible, and are not reported as errors.
