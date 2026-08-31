# Whisperr integration contracts — 2.0.0

Status: **`2.0.0-rc1` — drafted, NOT frozen.** Freezing is George's sign-off (O00 gate).

These contracts are the single source of truth for the Whisperr Integration Program. Every
connector, every executor (MCP, PR agent, CLI, wizard), and every internal service is built
against them. They exist so that no downstream worker has to invent a shape.

## The one-sentence architecture

Many customer systems produce facts; **one** internal event, identity, catalog, consent, and
readiness system consumes them; the executors that write custom instrumentation are *clients
of that system*, not separate integrations.

```text
source → connection (02) → envelope (01) → identity (03) + consent (04)
                                        → coverage (08)
                                        → catalog (06) → message → relay (07)
        registration revisions (05) define which event codes are legal at all
        anything that goes wrong lands in the taxonomy (09)
```

## The contracts

| # | Contract | Answers |
|---|---|---|
| [01](01-event-envelope.md) | Canonical event envelope | What a fact looks like once it is inside Whisperr |
| [02](02-source-connection-manifest.md) | Source connection manifest | What a connector is allowed to claim it can do |
| [03](03-identity-authority.md) | Identity authority modes | Who is allowed to say who a person is |
| [04](04-consent-assertion.md) | Consent assertion | When Whisperr is allowed to send |
| [05](05-registration-revision.md) | Registration revision model | How an event code comes to exist, atomically |
| [06](06-catalog-projection.md) | Catalog projection | What may be offered, and how freshness gates it |
| [07](07-delivery-relay.md) | Delivery relay | The lowest-PII handoff to the customer's sender |
| [08](08-coverage-health.md) | Coverage and health states | What "connected" honestly means |
| [09](09-error-quarantine.md) | Error and quarantine taxonomy | Where a failure goes, and how it is repaired |
| [10](10-sdk-compatibility.md) | SDK compatibility | Why the 10 existing SDKs need no release |

Per-connector fixtures live in [`../conformance/connectors/`](../conformance/connectors/).

## Five rules that outrank everything below

1. **Nothing acknowledged is ever unaccounted for.** Every accepted delivery is `completed`,
   `retrying`, `quarantined`, or `dead_lettered` — never silently missing. (09)
2. **Uncertainty narrows, it never broadens.** Catalog uncertainty suppresses *offers*, not
   messaging. Identity uncertainty quarantines a *link*, not the user. Unknown consent blocks
   *delivery*, not ingestion. (04, 06, 09)
3. **Nothing is inferred.** Consent is asserted or it is unknown. Identity is claimed by an
   authorized source or it is unresolved. There is no fuzzy matching anywhere. (03, 04)
4. **A connector may not claim a capability its fixtures do not demonstrate.** (02, 08)
5. **Test events use the same envelope and a different lane.** They can never create a
   production user, change state, trigger an intervention, generate delivery, or move a
   coverage state past `validated`. (01, 08)

## Versioning and the freeze

`contract_version` is semver and is carried on the wire (`envelope_version`, `manifest_version`).

- **Patch** — clarifying prose, new fixtures for already-specified behavior. No approval needed.
- **Minor** — additive optional fields, new enum members that consumers may ignore. Contract PR
  + coordinator approval.
- **Major** — removals, renames, changed meanings, new *required* fields. Contract PR +
  coordinator approval + a declared migration window + notification to every in-flight worker.

**After the freeze, no downstream worker may modify a frozen contract silently.** A change
requires a dedicated contract PR in this repo, coordinator approval, updated fixtures, and
notification to affected workers. `whisperr-spec` is coordinator-owned for the duration of the
program; workers open contract PRs, they do not commit here.

## Relationship to `SPEC.md`

[`SPEC.md`](../SPEC.md) is the existing, shipped SDK ingestion contract (v1) implemented by ten
SDKs. **2.0.0 does not change it.** The v1 wire format becomes one *profile* inside the 2.0.0
surface; the mapping is specified in [10-sdk-compatibility.md](10-sdk-compatibility.md), and
`wire.json` / `behavior.json` / `push.json` are unchanged and still authoritative for SDKs.
