# whisperr-spec

The single source of truth for the Whisperr **ingestion wire contract** shared by
every Whisperr SDK.

- [`SPEC.md`](SPEC.md) — the human-readable contract (endpoints, event/identify
  shapes, auth, idempotency).
- [`conformance/wire.json`](conformance/wire.json) — canonical input→output cases.
  Each SDK runs a conformance test that builds each case with its native API and
  asserts the serialized body matches. This is what catches wire drift (e.g. an
  SDK sending a channel under `type` instead of `channel`) before it ships.

SDK conformance tests load this file from
`https://raw.githubusercontent.com/WhisperrAI/whisperr-spec/main/conformance/wire.json`
(override with the `WHISPERR_SPEC_PATH` env var to test against a local checkout).

When the contract changes: update `SPEC.md` + `wire.json` here first, then update
the SDKs until their conformance tests pass again.
