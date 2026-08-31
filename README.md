# whisperr-spec

The single source of truth for the Whisperr integration contracts and for SDK ingestion
behavior.

## Integration contracts — `2.0.0-rc4`

[`contracts/`](contracts) holds the contracts the Whisperr Integration Program is built
against: the canonical event envelope, source connection manifests, identity authority modes,
consent assertions, registration revisions, catalog projection, the delivery relay,
coverage/health states, the error and quarantine taxonomy, and the SDK compatibility rules.
Start at [`contracts/00-overview.md`](contracts/00-overview.md).

[`conformance/connectors/`](conformance/connectors) holds one fixture file per planned connector
(Supabase, Clerk, Auth0, Stripe, RevenueCat, Shopify, WooCommerce, Segment, GA, Mixpanel,
Amplitude, and custom code via MCP / PR agent / CLI). `python3 validate.py` first
compiles every JSON Schema (including exported definitions) with Ajv and validates
every fixture against its declared schema, resolving references only from this
checkout. It then checks supplemental cross-field consistency, including whether
each declared capability has a corresponding fixture assertion. An assertion is
not evidence that its described behavior has executed successfully.

Local validation requires Node.js 22+, Python 3, and the pinned npm dependencies:

```sh
npm ci
npm test
python3 validate.py
```

CI runs the same checks. The validator regression suite deliberately introduces
invalid enums, types, references, required fields, and regular expressions and
requires them to fail. Multi-delivery scenarios use `given.inbound.sequence`.

RevenueCat is explicitly deferred; its fixture remains as future work and is not
a release blocker. The validator checks fixture structure and internal consistency,
not whether a real provider installation or runtime test has passed. Executable
connector tests and installation evidence are separate requirements.

**2.0.0 requires no SDK release.** The v1 wire contract below is unchanged and still gates every
SDK; see [`contracts/10-sdk-compatibility.md`](contracts/10-sdk-compatibility.md).

## SDK ingestion contract — v1

- [`SPEC.md`](SPEC.md) — the human-readable contract: endpoints, payload shapes,
  auth, idempotency, retry/drop rules.
- [`conformance/wire.json`](conformance/wire.json) — canonical input→output
  serialization cases. SDK tests build each case with the native API and assert
  the outgoing body.
- [`conformance/behavior.json`](conformance/behavior.json) — canonical delivery
  semantics for auth failures, transient retry exhaustion, permanent client
  errors, queue retention, and stable retry ids.
- [`conformance/push.json`](conformance/push.json) — canonical push-token
  capture flows (`setPushToken` / `identify(pushToken:)`: partial re-identify,
  rotation opt-out, dedup across restart-then-reidentify, buffer-until-identify,
  empty-token no-op, and `reset` re-registration) for the SDKs that expose them.
- [`schemas/`](schemas) — JSON Schemas for the conformance fixtures.

SDK tests default to the published fixtures:

- `https://raw.githubusercontent.com/WhisperrAI/whisperr-spec/main/conformance/wire.json`
- `https://raw.githubusercontent.com/WhisperrAI/whisperr-spec/main/conformance/behavior.json`

For local development, set `WHISPERR_SPEC_PATH=/path/to/conformance/wire.json`.
Behavior tests will load `behavior.json` from the same directory. Set
`WHISPERR_BEHAVIOR_SPEC_PATH` only when you need to override that explicitly.

When the contract changes: update `SPEC.md` and the fixture here first, then
update SDKs until their conformance tests pass again.

## Changing a frozen contract

While the Integration Program runs, `whisperr-spec` is coordinator-owned. A change to a frozen
contract requires a dedicated contract PR, coordinator approval, updated fixtures, and
notification to every affected in-flight worker. Workers open contract PRs; they do not commit
here directly. See [`contracts/00-overview.md`](contracts/00-overview.md) for the semver rules.
