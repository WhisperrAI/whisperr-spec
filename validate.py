#!/usr/bin/env python3
"""whisperr-spec validator.

Runs JSON Schema compilation/validation first, then checks the cross-field
invariants that the JSON Schemas cannot express on their own — most importantly the
capability-honesty rule from contracts/02: a connector may not declare a capability its
fixtures do not demonstrate.

Run:  python3 validate.py
"""
import glob, json, os, re, sys, subprocess

os.chdir(os.path.dirname(os.path.abspath(__file__)))
try:
    schema_result = subprocess.run(["node", "validate-schemas.mjs"], check=False)
except OSError:
    sys.exit("Schema validation requires Node.js and npm ci; it cannot be skipped.")
if schema_result.returncode:
    sys.exit(schema_result.returncode)

ERRORS = []
DEBT = []
def err(where, msg): ERRORS.append(f"{where}: {msg}")

# ---------------------------------------------------------------- 1. everything parses
docs = {}
for f in sorted(glob.glob("conformance/**/*.json", recursive=True) + glob.glob("schemas/*.json")):
    try:
        docs[f] = json.load(open(f))
    except Exception as e:
        err(f, f"invalid JSON — {e}")
if ERRORS:
    print("\n".join(ERRORS)); sys.exit(1)

# ---------------------------------------------------------------- 2. $schema targets exist
for f, d in docs.items():
    if f.startswith("schemas/"): continue
    ref = d.get("$schema")
    if not ref: err(f, "missing $schema"); continue
    target = os.path.normpath(os.path.join(os.path.dirname(f), ref))
    if not os.path.exists(target): err(f, f"$schema points at a missing file: {ref}")

# ---------------------------------------------------------------- 3. SDK fixtures untouched by 2.0.0
for f in ("conformance/wire.json", "conformance/behavior.json", "conformance/push.json"):
    if f not in docs: err(f, "SDK fixture missing — 2.0.0 must not remove it")

# ---------------------------------------------------------------- 4. connector fixtures
LAUNCH = {"supabase","clerk","auth0","stripe","shopify","woocommerce",
          "segment","google_analytics","mixpanel","amplitude","custom_code"}
DEFERRED = {"revenuecat"}  # Explicit product decision; keep fixtures, do not gate launch.
BOOL_CAPS = ("live_stream","history","catalog","delivery")
seen = set()

for f, d in sorted(docs.items()):
    if not f.startswith("conformance/connectors/"): continue
    prov = d.get("provider"); seen.add(prov)
    man, cases = d.get("manifest", {}), d.get("cases", [])
    if man.get("provider") != prov:
        err(f, f"manifest.provider {man.get('provider')!r} != provider {prov!r}")

    # 4a. lifecycle: all four are required true by the launch gate (PROGRAM.md §8)
    life = man.get("lifecycle", {})
    for k in ("disconnect","revocation","recovery","replay"):
        if life.get(k) is not True:
            err(f, f"lifecycle.{k} must be true — the launch gate requires it of every connector")

    # 4b. kill switch names this provider and only this provider
    if man.get("kill_switch") != f"provider.{prov}":
        err(f, f"kill_switch must be 'provider.{prov}', got {man.get('kill_switch')!r}")

    # 4c. THE CAPABILITY-HONESTY RULE (contracts/02, program rule 4)
    caps = man.get("capabilities", {})
    demonstrated = {cap for c in cases for cap in c.get("demonstrates_capabilities", [])}
    for cap in BOOL_CAPS:
        if caps.get(cap) is True and cap not in demonstrated:
            err(f, f"declares capabilities.{cap}=true but NO case demonstrates it "
                   f"(contracts/02 rule 4 — a capability without evidence may not ship)")
        if caps.get(cap) is False and cap in demonstrated:
            err(f, f"declares capabilities.{cap}=false but a case claims to demonstrate it")
    ident = caps.get("identity")
    if ident and ident != "none" and "identity" not in demonstrated:
        err(f, f"declares capabilities.identity={ident!r} but no case demonstrates it")

    # 4c-bis. THE SCOPE-HONESTY RULE — a case may not need a scope the manifest never asks for.
    # Capability honesty alone is not enough: a connector can carry a demonstrating case for a
    # capability while its authorization request cannot actually deliver it. That gap is invisible
    # until an install fails in production.
    requested = {s["scope"] for s in man.get("auth", {}).get("scopes", [])}
    if requested:
        for c in cases:
            for sc in c.get("requires_scopes", []):
                if sc not in requested:
                    err(f, f"case {c['name']!r} requires scope {sc!r} that auth.scopes never "
                           f"requests (contracts/02 — finalize scopes against real API calls)")
    never = set(man.get("auth", {}).get("never_requests", []))
    for sc in requested & never:
        err(f, f"scope {sc!r} is both requested and listed in never_requests")

    # 4c-quater. GRANTED vs JUSTIFIED, both directions.
    # `scopes` is what the connector needs and justifies; `granted_scopes` is what the registered
    # provider app actually carries. Under-grant is an install failure waiting to happen;
    # over-grant is a least-privilege violation and a PROGRAM.md §7 human-review escalation.
    granted = set(man.get("auth", {}).get("granted_scopes", []))
    _dl = man.get("auth", {}).get("scope_deltas", {})
    PENDING = {x["scope"] for x in _dl.get("pending_grant", [])}
    ACCEPTED = {x["scope"] for x in _dl.get("overgranted", [])}
    for x in _dl.get("pending_grant", []):
        DEBT.append((prov, f"pending grant (closed by {x['closed_by']})", x["scope"]))
    for x in _dl.get("overgranted", []):
        DEBT.append((prov, f"over-granted ({x['action']} / {x['owner']})", x["scope"]))
    if granted:
        for sc in man.get("auth", {}).get("scopes", []):
            if sc.get("required") and sc["scope"] not in granted and sc["scope"] not in PENDING:
                err(f, f"scope {sc['scope']!r} is REQUIRED but the registered app does not grant "
                       f"it and it is not tracked in scope_deltas.pending_grant — installs will "
                       f"fail. Amend the provider app, drop the requirement, or track it.")
        for x in sorted(granted - requested - ACCEPTED):
            err(f, f"registered app grants {x!r} with no entry in auth.scopes and none in "
                   f"scope_deltas.overgranted — over-permissioned. Justify it, trim the provider "
                   f"app, or track it. Ambiguous provider permission scope is a §7 carve-out.")

    # 4c-ter. a registered OAuth callback must be carried verbatim, and status is not approval
    oauth = man.get("auth", {}).get("oauth")
    if man.get("auth", {}).get("mode") == "oauth" and not oauth:
        err(f, "auth.mode is oauth but no auth.oauth block records the registered callback")
    if oauth:
        modes = [c["install_mode"] for c in oauth.get("clients", [])]
        if len(modes) != len(set(modes)):
            err(f, "auth.oauth.clients has duplicate install_mode entries")
        envs = {c.get("environment") for c in oauth.get("clients", [])}
        extra_envs = envs - {None} - set(man.get("environments", []))
        if extra_envs:
            err(f, f"OAuth clients target undeclared environments {sorted(extra_envs)}")
        if oauth.get("registration_status") == "not_registered":
            if oauth.get("clients"):
                err(f, "registration_status is not_registered but OAuth clients are listed")
        elif not oauth.get("clients"):
            err(f, "a registered OAuth app must list at least one client in auth.oauth.clients")
        elif None not in envs:
            missing = set(man.get("environments", [])) - envs
            if missing:
                err(f, f"no OAuth client covers environment(s) {sorted(missing)} — a connection "
                       f"in that environment has no client_id to authorize with")
    if oauth and oauth.get("registration_status") == "approved":
        err(f, "registration_status 'approved' requires provider review evidence — registration "
               "is not approval; a coordinator sets this, not a worker")

    # 4d. history-only connectors may never reach live coverage
    if caps.get("history") is True and caps.get("live_stream") is False:
        for c in cases:
            if c.get("expect", {}).get("coverage", {}).get("state") == "live":
                err(f, f"case {c['name']!r}: history-only connector must never reach 'live' coverage")

    # 4e. every case proves something, and negatives are marked
    for c in cases:
        if not c.get("proves","").strip():
            err(f, f"case {c.get('name')!r} proves nothing — it does not belong in the suite")
        if "expect" not in c or "outcome" not in c["expect"]:
            err(f, f"case {c.get('name')!r} has no expect.outcome")

    # 4f. every connector carries a consent-never-inferred negative
    if man.get("family") in ("auth","billing","commerce"):
        if not any("consent" in c["name"] for c in cases):
            err(f, "auth/billing/commerce connectors must carry a consent-never-inferred negative (contracts/04)")

missing = LAUNCH - seen
if missing: err("conformance/connectors", f"no fixture file for launch connector(s): {sorted(missing)}")
extra = seen - LAUNCH - DEFERRED
if extra: err("conformance/connectors", f"fixture for a non-launch connector: {sorted(extra)}")

# ---------------------------------------------------------------- 5. relay payload cannot carry an address
relay = docs.get("schemas/relay.schema.json", {})
payload = relay.get("$defs", {}).get("payload", {})
if payload.get("additionalProperties") is not False:
    err("schemas/relay.schema.json", "payload must set additionalProperties:false")
guard = payload.get("propertyNames", {}).get("not", {}).get("pattern", "")
for word in ("address", "email", "phone", "push_token"):
    if not all(re.search(guard, spelling) for spelling in (word, word.upper(), word.title())):
        err("schemas/relay.schema.json", f"payload propertyNames guard must forbid {word!r} (contracts/07)")

# ---------------------------------------------------------------- report
if ERRORS:
    print(f"spec validation FAILED ({len(ERRORS)} problem(s)):")
    print("\n".join(f"  - {e}" for e in ERRORS)); sys.exit(1)

if DEBT:
    print("tracked scope debt — acknowledged, not failures:")
    for prov, kind, sc in sorted(DEBT):
        print(f"  ! {prov:<12} {sc:<22} {kind}")
    print()

ncases = sum(len(d.get("cases", [])) for f, d in docs.items() if f.startswith("conformance/connectors/"))
print(f"spec OK — {len(docs)} documents, {len(seen & LAUNCH)} launch connectors, {len(seen & DEFERRED)} deferred, {ncases} connector cases (structural checks only)")
