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
for f in ("conformance/wire.json", "conformance/behavior.json", "conformance/push.json", "conformance/anonymous.json",
          "conformance/automatic.json", "conformance/v2.json"):
    if f not in docs: err(f, "SDK fixture missing — 2.0.0 must not remove it")

# ---------------------------------------------------------------- 3b. automatic events match their catalogue
# The JSON Schema pins the shapes. These checks tie every expected event to the
# reserved catalogue in the same file, so a case cannot drift from the names
# and property types the server and the SDKs read from that catalogue.
auto = docs.get("conformance/automatic.json", {})
f = "conformance/automatic.json"
common = auto.get("commonProperties", {})
reserved = {}
for r in auto.get("reserved", []):
    if r["name"] in reserved: err(f, f"reserved event {r['name']!r} is listed twice")
    reserved[r["name"]] = r
    for key in set(r.get("properties", {})) & set(common):
        if r["properties"][key]["type"] != common[key]["type"]:
            err(f, f"{r['name']}.{key} type differs from the common property of the same name")
PY_TYPES = {"string": str, "integer": int, "boolean": bool}
def check_value(where, key, spec, value):
    if "placeholder" in spec:
        # The harness cannot control this value (it is the SDK's own), so the
        # fixture must carry the token, never a literal.
        if value != spec["placeholder"]:
            err(f, f"{where}: {key} must be the placeholder {spec['placeholder']!r}, got {value!r}")
        return
    want = PY_TYPES[spec["type"]]
    # bool is a subclass of int in Python; an integer property must not take a bool.
    if not isinstance(value, want) or (want is int and isinstance(value, bool)):
        err(f, f"{where}: {key} must be {spec['type']}, got {value!r}")
    elif "enum" in spec and value not in spec["enum"]:
        err(f, f"{where}: {key} must be one of {spec['enum']}, got {value!r}")
for c in auto.get("cases", []) + auto.get("pushEventsV2", {}).get("cases", []):
    for i, e in enumerate(c.get("expectedEvents", [])):
        where = f"case {c['name']!r} event {i + 1}"
        r = reserved.get(e["event_type"])
        if r is None:
            err(f, f"{where}: {e['event_type']!r} is not a reserved automatic event"); continue
        props = e["properties"]
        allowed = {**common, **r["properties"]}
        for key, value in props.items():
            if key not in allowed: err(f, f"{where}: {key!r} is not a property of {e['event_type']}")
            else: check_value(where, key, allowed[key], value)
        for key, spec in allowed.items():
            if spec.get("required") and key not in props:
                err(f, f"{where}: {e['event_type']} must carry {key!r}")
        if "timezone" in props and "timezone_offset_minutes" in props:
            err(f, f"{where}: timezone_offset_minutes is only a fallback; never send it with timezone")
        for key, spec in allowed.items():
            # Legacy cases run on mobile harnesses.
            if "mobile" in spec.get("requiredIn", []) and key not in props:
                err(f, f"{where}: {e['event_type']} must carry {key!r} on mobile")

# ---------------------------------------------------------------- 3b-bis. signals v3 cases
# The same catalogue check, plus: requiredIn signalsV3 keys, the v3
# placeholders, track() events, and the fingerprint vectors.
import hashlib, re
v3 = auto.get("signalsV3", {})
V3_PLACEHOLDER = {
    "session_id": re.compile(r"^\$session_[a-z]$"),
    "crashed_session_id": re.compile(r"^\$session_[a-z]$"),
    "fingerprint": re.compile(r"^\$fp_[a-z]$"),
    "error_kind": re.compile(r"^\$error_kind$"),
    "detected_by": re.compile(r"^\$fatal_detected_by$"),
}
for vec in v3.get("fingerprintVectors", []):
    want = hashlib.sha256("\n".join([vec["errorName"]] + vec["frames"][:3]).encode()).hexdigest()[:16]
    if vec["fingerprint"] != want:
        err(f, f"fingerprint vector {vec['errorName']!r}: {vec['fingerprint']} != {want}")
legacy_case_names = {c["name"] for c in auto.get("cases", [])}
for sec_name, sec in v3.get("sections", {}).items():
    kinds = set(sec["appliesTo"])
    for c in sec["cases"]:
        if c["name"] in legacy_case_names:
            err(f, f"signalsV3 case {c['name']!r} reuses a legacy case name")
        tracked = {st["track"] for st in c["steps"] if "track" in st}
        web = kinds == {"web"}
        for st in c["steps"]:
            launch = st.get("launch")
            if launch is not None and web != ("url" in launch):
                err(f, f"case {c['name']!r}: a web launch has url, a mobile launch has appVersion")
        for i, e in enumerate(c["expectedEvents"]):
            where = f"signalsV3.{sec_name} case {c['name']!r} event {i + 1}"
            if e["event_type"] in tracked and e["event_type"] not in reserved:
                if e["properties"] != {}:
                    err(f, f"{where}: a track() event is compared with properties {{}}")
                continue
            r = reserved.get(e["event_type"])
            if r is None:
                err(f, f"{where}: {e['event_type']!r} is neither reserved nor tracked by a step"); continue
            props = e["properties"]
            allowed = {**common, **r["properties"]}
            for key, value in props.items():
                if key not in allowed:
                    err(f, f"{where}: {key!r} is not a property of {e['event_type']}"); continue
                pattern = V3_PLACEHOLDER.get(key)
                if isinstance(value, str) and value.startswith("$") and "placeholder" not in allowed[key]:
                    if not (pattern and pattern.match(value)):
                        err(f, f"{where}: {key} has unknown placeholder {value!r}")
                    continue
                check_value(where, key, allowed[key], value)
            for key, spec in allowed.items():
                need = spec.get("required") or "signalsV3" in spec.get("requiredIn", []) \
                    or ("mobile" in spec.get("requiredIn", []) and "mobile" in kinds)
                if need and key not in props:
                    err(f, f"{where}: {e['event_type']} must carry {key!r}")
            if web and "cold_start" in props:
                err(f, f"{where}: a browser SDK omits cold_start")
            if "session_id" in props and props["session_id"] != e["context"]["session_id"]:
                err(f, f"{where}: session_id must equal context.session_id")

# ---------------------------------------------------------------- 3a. client email consent cases
# Client SDKs run clientEmailConsent instead of the cases it supersedes, so a
# superseded name must exist in cases, and a client case name must not shadow
# one (an SDK keyed by name would run the wrong expectation).
wire = docs.get("conformance/wire.json", {})
client = wire.get("clientEmailConsent")
if client:
    f = "conformance/wire.json"
    names = {c["name"] for c in wire.get("cases", [])}
    for name in client.get("supersedes", []):
        if name not in names: err(f, f"clientEmailConsent supersedes unknown case {name!r}")
    for c in client.get("cases", []):
        if c["name"] in names: err(f, f"clientEmailConsent case {c['name']!r} reuses a cases name")
        for ch in c.get("expectedBody", {}).get("channels", []):
            if "consent_source" in ch and (ch.get("channel") != "email" or ch.get("opted_in") is not True):
                err(f, f"{c['name']}: consent_source goes only on an email channel with opted_in: true")

# ---------------------------------------------------------------- 3c. contract v2 sections
# A v2 section may supersede legacy cases. Each entry must name a legacy case
# that exists, so an SDK never skips a case by a stale or misspelled name.
def legacy_names(fixture):
    return {c["name"] for c in docs.get(f"conformance/{fixture}", {}).get("cases", [])}
v2 = docs.get("conformance/v2.json", {})
v2_sections = [("conformance/v2.json", n, sec) for n, sec in v2.get("sections", {}).items()]
if "pushEventsV2" in auto:
    v2_sections.append(("conformance/automatic.json", "pushEventsV2", auto["pushEventsV2"]))
seen_names = {}
for where, name, sec in v2_sections:
    for ref in sec.get("supersedes", []):
        fixture, case = ref.split(":", 1)
        if case not in legacy_names(fixture):
            err(where, f"section {name!r} supersedes {ref!r}, which is not a legacy case")
    for c in sec.get("cases", []):
        key = (where, c["name"])
        if key in seen_names:
            err(where, f"case {c['name']!r} appears in {seen_names[key]!r} and {name!r}")
        seen_names[key] = name
for name, sec in v2.get("sections", {}).items():
    for c in sec.get("cases", []):
        # Automatic events in v2.json (push_permission_changed) follow the catalogue.
        f = "conformance/v2.json"  # check_value reports against f
        for request in c.get("expectedRequests", []):
            for e in request.get("events", []):
                r = reserved.get(e["event_type"])
                if r is None: continue
                where = f"v2 case {c['name']!r} {e['event_type']}"
                allowed = {**common, **r["properties"]}
                for key, value in e["properties"].items():
                    if key not in allowed: err("conformance/v2.json", f"{where}: {key!r} is not a property of it")
                    else: check_value(where, key, allowed[key], value)
                for key, spec in allowed.items():
                    if spec.get("required") and key not in e["properties"]:
                        err("conformance/v2.json", f"{where}: must carry {key!r}")
        steps = c.get("steps", [])
        uses_clock = any("advanceClock" in st for st in steps)
        # A device step without a device block would turn detection on halfway.
        if any("setDevice" in st for st in steps) and "device" not in c:
            err("conformance/v2.json", f"case {c['name']!r} uses setDevice without a device block")
        if "server" in sec.get("appliesTo", []) and ("device" in c or uses_clock):
            err("conformance/v2.json", f"case {c['name']!r}: server cases have no device and no clock")

# ---------------------------------------------------------------- 4. connector fixtures
LAUNCH = {"supabase","clerk","auth0","stripe","revenuecat","shopify","woocommerce",
          "segment","google_analytics","mixpanel","amplitude","custom_code"}
BOOL_CAPS = ("live_stream","history","catalog","delivery")
seen = set()
FAMILY = {}

def schema_name(d):
    return os.path.basename(str(d.get("$schema", "")).split("#")[0])

# A connector suite may carry companion fixtures next to its connector fixture
# (consent sources, 4h). Only connector fixtures declare a manifest.
CONNECTOR_SCHEMA, CONSENT_SOURCE_SCHEMA = "connector-fixture.schema.json", "consent-source-fixture.schema.json"
for f, d in sorted(docs.items()):
    if f.startswith("conformance/connectors/") and schema_name(d) not in (CONNECTOR_SCHEMA, CONSENT_SOURCE_SCHEMA):
        err(f, f"connector suite files use {CONNECTOR_SCHEMA} or {CONSENT_SOURCE_SCHEMA}, not {schema_name(d)!r}")

PLACEHOLDER = re.compile(r"\{([A-Za-z][A-Za-z0-9_]*)\}")
def template_regex(template):
    # A placeholder is one key segment: provider topics and hooks (orders/paid,
    # whisperr/cart_updated) carry no colon, so a segment never spans one.
    parts, last = [], 0
    for m in PLACEHOLDER.finditer(template):
        parts.append(re.escape(template[last:m.start()])); parts.append(r"[^:]+"); last = m.end()
    parts.append(re.escape(template[last:]))
    return re.compile("^" + "".join(parts) + "$")

for f, d in sorted(docs.items()):
    if not f.startswith("conformance/connectors/") or schema_name(d) != CONNECTOR_SCHEMA: continue
    prov = d.get("provider"); seen.add(prov)
    FAMILY[prov] = d.get("manifest", {}).get("family")
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

    # 4g. THE EVENT CONTRACT (contracts/02, manifest.events)
    # Templates name their provider; each signal is declared once; a declared
    # event needs only requested scopes; a case's expected envelope uses a
    # declared code, only that code's allowlisted properties, and an occurrence
    # key its template can produce.
    events = man.get("events") or []
    default_tpl = man.get("correlation", {}).get("occurrence_key_template")
    for t in [default_tpl] + [e.get("occurrence_key_template") for e in events]:
        if t is not None and not t.startswith(f"{prov}:"):
            err(f, f"occurrence key template {t!r} must start with '{prov}:' (keys are per app, across providers)")
    by_code, signals = {}, set()
    for e in events:
        if e["signal"] in signals: err(f, f"events: signal {e['signal']!r} is declared twice (one signal means one code)")
        signals.add(e["signal"])
        by_code.setdefault(e["code"], []).append(e)
        for sc in e.get("requires_scopes", []):
            if sc not in requested:
                err(f, f"events: {e['signal']!r} requires scope {sc!r} that auth.scopes never requests")
        if e.get("historical") and caps.get("history") is not True:
            err(f, f"events: {e['signal']!r} is historical but capabilities.history is not true")
        if e.get("counts_as_activity"):
            if man.get("family") != "commerce":
                err(f, f"events: {e['signal']!r} counts as activity, but only commerce shopper actions may (contracts/11)")
            if e.get("historical"):
                err(f, f"events: {e['signal']!r} is historical; history never counts as activity")
    def templates_for(code):
        chosen = by_code.get(code) if code else None
        pool = chosen if chosen else [None] + events
        out = []
        for e in pool:
            t = default_tpl if e is None or "occurrence_key_template" not in e else e["occurrence_key_template"]
            if t is not None and t not in out: out.append(t)
        return out
    for c in cases:
        env = c.get("expect", {}).get("envelope") or {}
        code = env.get("event", {}).get("code")
        if events and code and code not in by_code:
            err(f, f"case {c['name']!r}: event code {code!r} is not declared in manifest.events")
        props = env.get("event", {}).get("properties")
        if code in by_code and props is not None:
            allowed = {p for e in by_code[code] for p in e["properties"]}
            for extra in sorted(set(props) - allowed):
                err(f, f"case {c['name']!r}: property {extra!r} is outside {code}'s allowlist")
        keys = [(env.get("correlation") or {}).get("occurrence_key"), code]
        checks = [keys] if keys[0] is not None else []
        state = c.get("given", {}).get("state") or {}
        checks += [(k, None) for k in state.get("already_ingested_occurrences", [])]
        for key, kcode in checks:
            tpls = templates_for(kcode)
            if tpls and not any(template_regex(t).match(key) for t in tpls):
                err(f, f"case {c['name']!r}: occurrence key {key!r} matches none of {tpls}")

# ---------------------------------------------------------------- 4h. store consent source fixtures
# contracts/04, Store consent sources. The schema pins the vocabulary; these
# checks pin the rules between fields: what the runtime must refuse, what an
# owner attestation changes, the basis of each assertion, the evidence_ref
# layout, and that only a recorded opt-in makes an address sendable.
CHECKBOX, CONSENT_HOOK = "whisperr_checkbox", "whisperr/marketing_consent"
for f, d in sorted(docs.items()):
    if not f.startswith("conformance/connectors/") or schema_name(d) != CONSENT_SOURCE_SCHEMA: continue
    prov = d.get("provider")
    if FAMILY.get(prov) != "commerce":
        err(f, f"consent sources belong to a commerce connector fixture; {prov!r} has none")
    names = [c["name"] for c in d.get("cases", [])]
    for n in sorted({n for n in names if names.count(n) > 1}):
        err(f, f"case {n!r} appears twice")
    for c in d.get("cases", []):
        where, given, exp = f"case {c['name']!r}", c["given"], c["expect"]
        out, consent, ch = exp["outcome"], exp.get("consent"), exp.get("channel")
        if (out == "rejected") != ("rejection_code" in exp):
            err(f, f"{where}: rejection_code goes with outcome rejected, and only with it")
        if out == "rejected" and (consent or ch):
            err(f, f"{where}: a rejected delivery records nothing")
        if out == "superseded" and (consent or (ch or {}).get("stored")):
            err(f, f"{where}: a superseded consent records nothing")
        if "setups" in given and (out != "rejected" or exp.get("attestations") != 0):
            err(f, f"{where}: refused setups are rejected and record no attestation")
        inbound = given.get("inbound") or {}
        if inbound.get("hook") != CONSENT_HOOK:
            if inbound and ch and (ch.get("verified") or ch.get("opted_in")):
                err(f, f"{where}: only a consent opts in or verifies an address (contracts/04: never inferred)")
            if inbound and consent:
                err(f, f"{where}: only {CONSENT_HOOK} carries consent")
            continue
        data = inbound["data"]
        source, subscribed = data["source"], data["state"] == "subscribed"
        third, backfill = source != CHECKBOX, data.get("backfill") is True
        broken = [why for bad, why in (
            (backfill and not (third and subscribed), "only a third-party opt-in may be a backfill"),
            ("captured_at" in data and data["captured_at"] is None and not backfill, "only a backfill may have no time"),
            (third and "attestation_id" not in data and given.get("attested") is not True, "a third-party consent names its attestation"),
        ) if bad]
        if broken and out != "rejected":
            err(f, f"{where}: must be rejected ({'; '.join(broken)})")
        if not broken and out == "rejected":
            err(f, f"{where}: rejected, but breaks no wire rule")
        if out == "rejected": continue
        if subscribed and third and given.get("attested") is not True and out != "superseded":
            err(f, f"{where}: a third-party opt-in without the owner's confirmed attestation is superseded")
        for a in consent or []:
            want = "opted_in" if subscribed else "opted_out"
            if a["status"] != want: err(f, f"{where}: a {data['state']} consent asserts {want}")
            basis = "imported_record" if subscribed and (third or data["surface"] == "store_sync") else "explicit_user_action"
            if a["basis"] != basis: err(f, f"{where}: basis must be {basis!r}")
            ref = a["evidence_ref"]
            prefix = f"{prov}:{{delivery_id}}:{source}"
            if not ref.startswith(prefix): err(f, f"{where}: evidence_ref must start with {prefix!r}")
            if subscribed and third and not ref.startswith(prefix + ":{attestation_id}"):
                err(f, f"{where}: a third-party opt-in's evidence names its attestation")
            if data.get("source_detail") and f":{data['source_detail']}" not in ref:
                err(f, f"{where}: evidence_ref must carry the source_detail")
            if backfill:
                at = "unknown" if data.get("captured_at") is None else re.sub(r"[-:]|\.\d+", "", data["captured_at"])
                if not ref.endswith(f":backfill:{at}:{{confirmed_at}}"):
                    err(f, f"{where}: a backfill's evidence ends :backfill:{at}:{{confirmed_at}}")
            elif ":backfill:" in ref:
                err(f, f"{where}: only a backfill's evidence says backfill")
        opted_in = out == "completed" and any(a["status"] == "opted_in" for a in consent or [])
        if opted_in and (ch or {}).get("verified_by") != "store_opt_in":
            err(f, f"{where}: a recorded store opt-in stores the address opted in and verified_by store_opt_in")
        if not opted_in and ch and (ch.get("opted_in") or ch.get("verified")):
            err(f, f"{where}: an address is opted in or verified only by a recorded opt-in")

missing = LAUNCH - seen
if missing: err("conformance/connectors", f"no fixture file for launch connector(s): {sorted(missing)}")
extra = seen - LAUNCH
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

suite = [d for f, d in docs.items() if f.startswith("conformance/connectors/")]
ncases = sum(len(d.get("cases", [])) for d in suite if schema_name(d) == CONNECTOR_SCHEMA)
nconsent = sum(len(d.get("cases", [])) for d in suite if schema_name(d) == CONSENT_SOURCE_SCHEMA)
print(f"spec OK — {len(docs)} documents, {len(seen & LAUNCH)} launch connectors, {ncases} connector cases, "
      f"{nconsent} consent source cases (structural checks only)")
