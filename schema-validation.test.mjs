import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateSchemas } from './validate-schemas.mjs';
import Ajv2020 from 'ajv/dist/2020.js';

const root = dirname(fileURLToPath(import.meta.url));
test('all committed schemas compile and fixtures structurally conform', () => {
  const result = validateSchemas(root);
  assert.deepEqual(result.errors, []);
  assert.equal(result.schemaCount, 17);
  assert.equal(result.fixtureCount, 19);
});

for (const [name, file, mutate] of [
  ['identity enum', 'conformance/connectors/supabase.json', d => { d.manifest.capabilities.identity = 'can_create_any_user'; }],
  ['outcome enum', 'conformance/connectors/supabase.json', d => { d.cases[0].expect.outcome = 'nonsense_not_in_enum'; }],
  ['primitive type', 'conformance/connectors/supabase.json', d => { d.manifest.capabilities.live_stream = 'true'; }],
  ['required property', 'conformance/connectors/supabase.json', d => { delete d.manifest.provider; }],
  ['unknown local reference', 'conformance/connectors/supabase.json', d => { d.$schema = '../../schemas/not-present.json'; }],
  ['unknown remote reference', 'schemas/connector-fixture.schema.json', d => { d.properties.manifest.$ref = 'https://example.invalid/missing.json'; }],
  ['unknown automatic lifecycle step', 'conformance/automatic.json', d => { d.cases[0].steps.push({ sleep: true }); }],
  ['automatic device offset type', 'conformance/automatic.json', d => { d.cases[0].device.timezoneOffsetMinutes = '+02:00'; }],
  ['automatic device with zone and offset', 'conformance/automatic.json', d => { d.cases[0].device.timezoneOffsetMinutes = 120; }],
  ['push permission status outside the reserved enum', 'conformance/automatic.json', d => { d.cases[0].steps.push({ pushPermission: 'granted' }); }],
  ['push opt-out step that is not true', 'conformance/push.json', d => { d.cases[0].steps.push({ optOut: false }); }],
  ['push permission step outside the wire enum', 'conformance/push.json', d => { d.cases[0].steps.push({ pushPermission: 'granted' }); }],
  ['automatic event name not snake_case', 'conformance/automatic.json', d => { d.reserved[0].name = 'AppInstalled'; }],
  ['unreferenced invalid regex', 'schemas/relay.schema.json', d => { d.$defs.payload.propertyNames.not.pattern = '(?i)email'; }],
  ['object setPushToken in legacy push cases', 'conformance/push.json', d => { d.cases[0].steps[1] = { setPushToken: { token: 'fcm_tok_a', kind: 'fcm' } }; }],
  ['unknown push token kind', 'conformance/push.json', d => { d.kindCases[0].steps[1].setPushToken.kind = 'hms'; }],
  ['unknown push_env on the wire', 'conformance/push.json', d => { d.kindCases[0].expectedBodies[1].channels[0].push_env = 'debug'; }],
  ['unknown v2 step', 'conformance/v2.json', d => { d.sections.restoreIdentify.cases[0].steps.push({ sleep: true }); }],
  ['missing v2 section', 'conformance/v2.json', d => { delete d.sections.appLanguage; }],
  ['v2 clock step with a fractional hour', 'conformance/v2.json', d => { d.sections.restoreIdentify.cases[0].steps[1] = { advanceClock: { hours: 0.5 } }; }],
  ['v2 supersedes entry without a fixture file', 'conformance/v2.json', d => { d.sections.anonymousPush.supersedes.push('set_push_token_before_identify_buffers'); }],
  ['v2 context with a literal platform', 'conformance/v2.json', d => { d.sections.versionContext.cases[0].expectedRequests[1].events[0].context.platform = 'ios'; }],
  ['push_received source outside the enum', 'conformance/automatic.json', d => { d.pushEventsV2.cases[0].steps[1].receivePush.source = 'background'; }],
  ['consent_source outside the wire enum', 'conformance/wire.json', d => { d.clientEmailConsent.cases[1].expectedBody.channels[0].consent_source = 'app'; }],
  ['track op in client email consent cases', 'conformance/wire.json', d => { d.clientEmailConsent.cases[0].op = 'track'; }],
  ['v3 event without a session_id context', 'conformance/automatic.json', d => { delete d.signalsV3.sections.sessionsAndCounters.cases[0].expectedEvents[0].context; }],
  ['v3 launch with a url and an app version', 'conformance/automatic.json', d => { d.signalsV3.sections.launchSource.cases[0].steps[0].launch.url = 'https://a.example/'; }],
  ['v3 trackError kind outside the enum', 'conformance/automatic.json', d => { d.signalsV3.sections.errors.cases[0].steps[1].trackError.kind = 'js'; }],
  ['v3 fingerprint vector that is not hex', 'conformance/automatic.json', d => { d.signalsV3.fingerprintVectors[0].fingerprint = 'CartLoadError'; }],
  ['legacy pushOpened step in v2 automatic cases', 'conformance/automatic.json', d => { d.pushEventsV2.cases[0].steps.push({ pushOpened: { whisperr_message_id: 'm' } }); }],
  ['unknown manifest event key', 'conformance/connectors/shopify.json', d => { d.manifest.events[0].selected = true; }],
  ['manifest event code not snake_case', 'conformance/connectors/shopify.json', d => { d.manifest.events[0].code = 'OrderPaid'; }],
  ['manifest event signal with a colon', 'conformance/connectors/woocommerce.json', d => { d.manifest.events[0].signal = 'woocommerce:payment_complete'; }],
  ['channel verified_by without a verified opt-in', 'conformance/connectors/shopify.json', d => { d.cases.find(c => c.expect.channel?.verified_by).expect.channel.verified = false; }],
  ['channel verified but not stored', 'conformance/connectors/shopify.json', d => { d.cases.find(c => c.expect.channel).expect.channel = { stored: false, verified: true }; }],
  ['consent source outside the enum', 'conformance/connectors/woocommerce_consent_sources.json', d => { d.cases[1].given.inbound.data.source = 'newsletter_pro'; }],
  ['consent surface outside the enum', 'conformance/connectors/woocommerce_consent_sources.json', d => { d.cases[1].given.inbound.data.surface = 'popup'; }],
  ['consent captured_at that is not a UTC time', 'conformance/connectors/woocommerce_consent_sources.json', d => { d.cases[3].given.inbound.data.captured_at = '2025-03-01 09:00'; }],
  ['consent source rejection code outside the taxonomy', 'conformance/connectors/woocommerce_consent_sources.json', d => { d.cases[6].expect.rejection_code = 'bad_request'; }],
  ['consent source outcome outside the enum', 'conformance/connectors/woocommerce_consent_sources.json', d => { d.cases[0].expect.outcome = 'ignored'; }],
  ['consent evidence without the delivery placeholder', 'conformance/connectors/woocommerce_consent_sources.json', d => { d.cases[1].expect.consent[0].evidence_ref = 'woocommerce:mailpoet'; }],
  ['consent source case without inbound or setups', 'conformance/connectors/woocommerce_consent_sources.json', d => { delete d.cases[1].given.inbound; }],
]) {
  test(`validator rejects ${name}`, () => {
    const temp = mkdtempSync(join(tmpdir(), 'whisperr-schema-'));
    try {
      for (const folder of ['schemas', 'conformance']) cpSync(join(root, folder), join(temp, folder), { recursive: true });
      const path = join(temp, file);
      const data = JSON.parse(readFileSync(path, 'utf8')); mutate(data);
      writeFileSync(path, JSON.stringify(data));
      let rejected = false;
      try { rejected = validateSchemas(temp).errors.length > 0; } catch { rejected = true; }
      assert.ok(rejected, 'invalid input escaped schema compilation/validation');
    } finally { rmSync(temp, { recursive: true, force: true }); }
  });
}

// The cross-field rules live in validate.py (JSON Schema cannot express them),
// so these run the whole validator on a mutated copy of the checkout.
function runValidator(file, mutate) {
  const temp = mkdtempSync(join(tmpdir(), 'whisperr-spec-'));
  try {
    for (const folder of ['schemas', 'conformance']) cpSync(join(root, folder), join(temp, folder), { recursive: true });
    for (const name of ['validate.py', 'validate-schemas.mjs', 'package.json']) cpSync(join(root, name), join(temp, name));
    symlinkSync(join(root, 'node_modules'), join(temp, 'node_modules'), 'dir');
    if (file) {
      const path = join(temp, file);
      const data = JSON.parse(readFileSync(path, 'utf8')); mutate(data);
      writeFileSync(path, JSON.stringify(data));
    }
    const run = spawnSync('python3', [join(temp, 'validate.py')], { encoding: 'utf8' });
    return { status: run.status, output: `${run.stdout}${run.stderr}` };
  } finally { rmSync(temp, { recursive: true, force: true }); }
}

const caseNamed = (d, name) => d.cases.find(c => c.name === name);
test('cross-field validator accepts the committed checkout', () => {
  const { status, output } = runValidator();
  assert.equal(status, 0, output);
});

for (const [name, file, mutate, message] of [
  ['an occurrence key its template cannot produce', 'conformance/connectors/shopify.json',
    d => { caseNamed(d, 'checkout_updated_is_keyed_by_cart_contents').expect.envelope.correlation.occurrence_key = 'shopify:checkout_updated:3301'; }, 'matches none of'],
  ['a WooCommerce occurrence key without the site', 'conformance/connectors/woocommerce.json',
    d => { caseNamed(d, 'checkout_never_waits_on_whisperr').expect.envelope.correlation.occurrence_key = 'woocommerce:woocommerce_payment_complete:4471:991'; }, 'matches none of'],
  ['an already ingested occurrence its templates cannot produce', 'conformance/connectors/woocommerce.json',
    d => { caseNamed(d, 'occurrence_key_is_scoped_to_the_site').given.state.already_ingested_occurrences = ['con_woo:woocommerce_payment_complete:4471:991']; }, 'matches none of'],
  ['a template with another provider prefix', 'conformance/connectors/shopify.json',
    d => { d.manifest.events.find(e => e.signal === 'checkouts/started').occurrence_key_template = 'checkout:{checkout_id}'; }, "must start with 'shopify:'"],
  ['an undeclared event code', 'conformance/connectors/shopify.json',
    d => { caseNamed(d, 'checkout_completed_needs_completed_at').expect.envelope.event.code = 'checkout_finished'; }, 'not declared in manifest.events'],
  ['a property outside the allowlist', 'conformance/connectors/shopify.json',
    d => { caseNamed(d, 'order_paid_carries_minimized_purchase_facts').expect.envelope.event.properties.discount_code = 'ADA10'; }, "property 'discount_code'"],
  ['a live order carrying a history-only property', 'conformance/connectors/woocommerce.json',
    d => { caseNamed(d, 'checkout_never_waits_on_whisperr').expect.envelope.event.properties = { order_id: '4471', status: 'processing' }; }, "property 'status'"],
  ['a cart contents digest that does not match the line items', 'conformance/connectors/shopify.json',
    d => { caseNamed(d, 'checkout_updated_is_keyed_by_cart_contents').given.inbound.total_price = '180.00'; }, 'cart contents digest'],
  ['a refund case that omits the order read-back scope', 'conformance/connectors/shopify.json',
    d => { caseNamed(d, 'refund_counts_only_successful_refund_transactions').requires_scopes = ['read_orders']; }, "requires ['read_customers']"],
  ['an ignored fulfillment case that omits the topic scopes', 'conformance/connectors/shopify.json',
    d => { caseNamed(d, 'late_fulfillment_update_is_not_a_new_shipment').requires_scopes = ['read_fulfillments']; }, "delivery requires ['read_customers', 'read_orders']"],
  ['an event that needs an unrequested scope', 'conformance/connectors/shopify.json',
    d => { d.manifest.events[0].requires_scopes.push('read_all_orders'); }, "requires scope 'read_all_orders'"],
  ['a signal declared twice', 'conformance/connectors/woocommerce.json',
    d => { d.manifest.events.push({ ...d.manifest.events[0] }); }, 'declared twice'],
  ['a historical event without history', 'conformance/connectors/shopify.json',
    d => { d.manifest.events[0].historical = true; }, 'capabilities.history is not true'],
  ['a historical event that counts as activity', 'conformance/connectors/woocommerce.json',
    d => { d.manifest.events.find(e => e.historical).counts_as_activity = true; }, 'history never counts as activity'],
  ['an activity event outside commerce', 'conformance/connectors/stripe.json',
    d => { d.manifest.events = [{ signal: 'invoice/paid', code: 'invoice_paid', properties: [], counts_as_activity: true }]; }, 'only commerce shopper actions'],
  ['an unattested third-party opt-in that is recorded', 'conformance/connectors/woocommerce_consent_sources.json',
    d => { d.cases[0].expect = { outcome: 'completed', consent: [] }; }, 'is superseded'],
  ['a third-party opt-in recorded as explicit_user_action', 'conformance/connectors/woocommerce_consent_sources.json',
    d => { d.cases[1].expect.consent[0].basis = 'explicit_user_action'; }, "basis must be 'imported_record'"],
  ['a third-party opt-in whose evidence omits the attestation', 'conformance/connectors/woocommerce_consent_sources.json',
    d => { d.cases[1].expect.consent[0].evidence_ref = 'woocommerce:{delivery_id}:mailpoet'; }, 'names its attestation'],
  ['a backfill whose evidence has the wrong time', 'conformance/connectors/woocommerce_consent_sources.json',
    d => { d.cases[3].expect.consent[0].evidence_ref = 'woocommerce:{delivery_id}:mailpoet:{attestation_id}:backfill:unknown:{confirmed_at}'; }, ':backfill:20250301T090000Z:'],
  ['a backfill from the plugin checkbox that is accepted', 'conformance/connectors/woocommerce_consent_sources.json',
    d => { d.cases[7].expect = { outcome: 'completed', consent: [] }; }, 'must be rejected'],
  ['a rejection that breaks no wire rule', 'conformance/connectors/woocommerce_consent_sources.json',
    d => { delete d.cases[7].given.inbound.data.backfill; }, 'breaks no wire rule'],
  ['a store opt-in that does not verify the address', 'conformance/connectors/woocommerce_consent_sources.json',
    d => { d.cases[1].expect.channel = { stored: true, opted_in: true, verified: false }; }, 'verified_by store_opt_in'],
  ['a purchase that verifies an address', 'conformance/connectors/woocommerce_consent_sources.json',
    d => { d.cases[13].expect.channel = { stored: true, opted_in: true, verified: true, verified_by: 'store_opt_in' }; }, 'only a consent opts in or verifies'],
  ['an opt-out that opts the address in', 'conformance/connectors/woocommerce_consent_sources.json',
    d => { d.cases[9].expect.channel = { stored: true, opted_in: true }; }, 'only by a recorded opt-in'],
  ['consent sources for a non-commerce provider', 'conformance/connectors/woocommerce_consent_sources.json',
    d => { d.provider = 'stripe'; }, 'belong to a commerce connector'],
]) {
  test(`cross-field validator rejects ${name}`, () => {
    const { status, output } = runValidator(file, mutate);
    assert.notEqual(status, 0, 'invalid input passed validate.py');
    assert.ok(output.includes(message), output);
  });
}

test('relay address guard uses portable case-insensitive spelling without rejecting legitimate names', () => {
  const schema = JSON.parse(readFileSync(join(root, 'schemas/relay.schema.json'), 'utf8'));
  const ajv = new Ajv2020({ strict: false });
  ajv.addSchema(schema);
  const validate = ajv.getSchema(`${schema.$id}#/$defs/payload`);
  const payload = { relay_version: '2.0.0', message_id: 'msg', intervention_id: 'iv', customer_user_id: 'user', channel: 'email', content: { rendered: { text: 'Hello' } }, idempotency_key: 'key', expires_at: '2026-08-31T00:00:00Z' };
  assert.ok(validate(payload), ajv.errorsText(validate.errors));
  const guard = new RegExp(schema.$defs.payload.propertyNames.not.pattern, 'u');
  for (const word of ['address', 'email', 'phone', 'msisdn', 'push_token', 'recipient', 'to_addr']) {
    for (const spelling of [word, word.toUpperCase(), word[0].toUpperCase() + word.slice(1)]) {
      assert.ok(guard.test(spelling));
      assert.equal(validate({ ...payload, [spelling]: 'forbidden' }), false);
    }
  }
  for (const key of Object.keys(payload)) assert.equal(guard.test(key), false);
});

// The server rule for a push channel that arrives without kind (SPEC.md,
// "Token kind"). Kept here so the table in push.json and the prose agree.
function inferPushKind(address) {
  if (/^Expo(nent)?PushToken\[.+\]$/u.test(address)) return 'expo';
  if (/^[0-9a-fA-F]{64}$/u.test(address)) return 'apns';
  return 'fcm';
}

test('push kind inference table follows the documented rule', () => {
  const push = JSON.parse(readFileSync(join(root, 'conformance/push.json'), 'utf8'));
  assert.ok(push.kindInference.length > 0);
  const seen = new Set();
  for (const c of push.kindInference) {
    assert.equal(inferPushKind(c.address), c.expectedKind, c.name);
    seen.add(c.expectedKind);
  }
  for (const kind of ['fcm', 'apns', 'expo']) assert.ok(seen.has(kind), `no inference case yields ${kind}`);
  // Inference never yields onesignal_sub: a OneSignal subscription id must be sent with an explicit kind.
  assert.ok(!seen.has('onesignal_sub'));
});

test('legacy push cases keep the string-only setPushToken step', () => {
  const push = JSON.parse(readFileSync(join(root, 'conformance/push.json'), 'utf8'));
  for (const c of push.cases) {
    for (const step of c.steps) {
      if ('setPushToken' in step) assert.equal(typeof step.setPushToken, 'string', c.name);
    }
    for (const body of c.expectedBodies) {
      for (const channel of body.channels ?? []) {
        for (const key of ['kind', 'platform', 'push_env']) assert.ok(!(key in channel), `${c.name} pins ${key}`);
      }
    }
  }
});

// Contract v2: the expected requests in v2.json are real wire bodies once the
// harness placeholders are replaced, so a fixture cannot pin a body the server
// would reject (for example an email channel on an anonymous identify).
function wireValidators() {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  for (const name of ['push.schema.json', 'wire.schema.json']) ajv.addSchema(JSON.parse(readFileSync(join(root, 'schemas', name), 'utf8')));
  const base = 'https://raw.githubusercontent.com/WhisperrAI/whisperr-spec/main/schemas/wire.schema.json#/$defs/';
  return { ajv, identify: ajv.getSchema(`${base}identify_body`), event: ajv.getSchema(`${base}event`), billing: ajv.getSchema(`${base}billing_event`) };
}
const PLACEHOLDERS = { $platform: 'ios', $sdk_name: 'whisperr-swift', $sdk_version: '2.0.0' };
function substitute(value) {
  if (typeof value === 'string') {
    if (value in PLACEHOLDERS) return PLACEHOLDERS[value];
    if (/^\$anon_[a-z0-9]+$/u.test(value)) return `3f2c9a1e-${value.slice(6).padEnd(4, '0')}-4b1d-9e2f-7a6b5c4d3e2f`;
    return value;
  }
  if (Array.isArray(value)) return value.map(substitute);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v)]));
  return value;
}

test('v2 expected requests are valid wire bodies after placeholder substitution', () => {
  const v2 = JSON.parse(readFileSync(join(root, 'conformance/v2.json'), 'utf8'));
  const { ajv, identify, event } = wireValidators();
  let bodies = 0;
  for (const [section, { cases }] of Object.entries(v2.sections)) {
    for (const c of cases) {
      for (const request of c.expectedRequests) {
        if (request.endpoint === '/v1/identify') {
          bodies++;
          assert.ok(identify(substitute(request.body)), `${section}/${c.name}: ${ajv.errorsText(identify.errors)}`);
        } else {
          for (const e of request.events) {
            // Automatic events are compared without identity fields; give them one so the wire shape check applies.
            const identity = 'external_user_id' in e || 'anonymous_id' in e ? {} : { external_user_id: 'user_1' };
            const sent = substitute({ ...identity, ...e, occurred_at: '2026-10-12T12:00:00.000Z', context: { $message_id: 'm1', ...(e.context ?? {}) } });
            assert.ok(event(sent), `${section}/${c.name}: ${ajv.errorsText(event.errors)}`);
          }
        }
      }
    }
  }
  assert.ok(bodies > 0);
});

test('v2 expected bodies never put locale in context and anonymous identifies carry only traits and push', () => {
  const v2 = JSON.parse(readFileSync(join(root, 'conformance/v2.json'), 'utf8'));
  for (const { cases } of Object.values(v2.sections)) {
    for (const c of cases) {
      for (const request of c.expectedRequests) {
        for (const e of request.events ?? []) assert.ok(!('locale' in (e.context ?? {})), c.name);
        const body = request.body;
        if (body && !('external_user_id' in body)) {
          assert.deepEqual(Object.keys(body).filter(k => !['anonymous_id', 'traits', 'channels'].includes(k)), [], c.name);
          for (const ch of body.channels ?? []) assert.equal(ch.channel, 'push', c.name);
        }
      }
    }
  }
});

test('the wire identify schema rejects what an anonymous identify may not carry', () => {
  const { identify } = wireValidators();
  const anon = { anonymous_id: '3f2c9a1e-0000-4b1d-9e2f-7a6b5c4d3e2f' };
  assert.ok(identify({ ...anon, traits: { app_language: 'de' } }));
  assert.ok(identify({ ...anon, channels: [{ channel: 'push', address: 'fcm_tok_a', opted_in: true, client_app_id: 'com.example.app', provider_project: 'example-project' }] }));
  assert.equal(identify({ ...anon, channels: [{ channel: 'email', address: 'ada@example.com', opted_in: true }] }), false);
  assert.equal(identify({ ...anon, channels: [{ channel: 'sms', address: '+15551234567' }] }), false);
  assert.equal(identify({ ...anon, traits: {}, preferred_channel: 'push' }), false);
  assert.equal(identify({ traits: { plan: 'pro' } }), false, 'neither external_user_id nor anonymous_id');
  assert.equal(identify({ ...anon, traits: { app_language: 'pt_BR' } }), false, 'the SDK sends app_language with a hyphen');
  assert.ok(identify({ external_user_id: 'user_1', channels: [{ channel: 'email', address: 'ada@example.com' }] }));
});

test('billing fallback names follow the playbook engine spec 3.8', () => {
  const { billing } = wireValidators();
  const money = { plan_id: 'pro_monthly', price: 9.99, currency: 'EUR', transaction_id: 't_1', store: 'app_store' };
  const ok = [
    { event_type: 'trial_started', properties: { ...money, trial_length_days: 7, trial_ends_at: '2026-10-19T12:00:00Z', plan_period: 'P1M' } },
    { event_type: 'trial_converted', properties: { plan_period: 'P1Y', current_period_ends_at: '2027-10-19T12:00:00.000Z' } },
    { event_type: 'trial_auto_renew_disabled', properties: { trial_ends_at: '2026-10-19T12:00:00+04:00', store_cancel_reason: 'unsubscribe' } },
    { event_type: 'membership_started', properties: { ...money, plan_period: 'P1M', is_resubscribe: false, is_first_ever: true, access_source: 'self_subscription', entitlements: ['pro'], current_period_ends_at: '2026-11-12T12:00:00Z' } },
    { event_type: 'renewal_succeeded', properties: { ...money, paid_periods_count: 3, current_period_ends_at: '2026-11-12T12:00:00Z' } },
    { event_type: 'auto_renew_disabled', properties: { access_ends_at: '2026-11-12T12:00:00Z', store_cancel_reason: 'price_increase' } },
    { event_type: 'auto_renew_enabled', properties: {} },
    { event_type: 'membership_ended', properties: { end_reason: 'refund', plan_period: 'P1M', paid_periods_count: 2 } },
    { event_type: 'billing_issue_started', properties: { has_access: true, grace_ends_at: '2026-10-28T12:00:00Z' } },
    { event_type: 'billing_recovered', properties: { ...money } },
    { event_type: 'refund_granted', properties: { ...money } },
  ];
  for (const event of ok) assert.ok(billing(event), `${event.event_type}: ${JSON.stringify(billing.errors)}`);
  const bad = [
    ['dropped name', { event_type: 'subscription_renewed', properties: {} }],
    ['dropped name', { event_type: 'payment_failed', properties: {} }],
    ['renamed product_id', { event_type: 'renewal_succeeded', properties: { product_id: 'pro_monthly' } }],
    ['renamed period', { event_type: 'membership_ended', properties: { period: 'P1M' } }],
    ['prop of another event', { event_type: 'trial_started', properties: { end_reason: 'voluntary' } }],
    ['store_cancel_reason outside the list', { event_type: 'auto_renew_disabled', properties: { store_cancel_reason: 'too_expensive' } }],
    ['end_reason outside the list', { event_type: 'membership_ended', properties: { end_reason: 'cancelled' } }],
    ['access_source outside the list', { event_type: 'membership_started', properties: { access_source: 'gift' } }],
    ['lower-case currency', { event_type: 'refund_granted', properties: { currency: 'eur' } }],
    ['price as a string', { event_type: 'refund_granted', properties: { price: '9.99' } }],
    ['empty plan_period', { event_type: 'trial_converted', properties: { plan_period: 'P' } }],
    ['timestamp without a zone', { event_type: 'renewal_succeeded', properties: { current_period_ends_at: '2026-11-12T12:00:00' } }],
  ];
  for (const [why, event] of bad) assert.equal(billing(event), false, why);
});

test('every superseded legacy case exists', () => {
  const load = name => JSON.parse(readFileSync(join(root, 'conformance', name), 'utf8'));
  const v2 = load('v2.json');
  const automatic = load('automatic.json');
  const refs = [...Object.values(v2.sections).flatMap(s => s.supersedes), ...automatic.pushEventsV2.supersedes];
  assert.ok(refs.length > 0);
  for (const ref of refs) {
    const [file, name] = ref.split(':');
    assert.ok(load(file).cases.some(c => c.name === name), ref);
  }
});

test('every v2 permission report expects its push_permission_changed event', () => {
  // SPEC.md: the off switch stops only the automatic read; an explicit report
  // through the permission API always sends the event, also in v2.json, whose
  // harness compares every request.
  const v2 = JSON.parse(readFileSync(join(root, 'conformance/v2.json'), 'utf8'));
  const automatic = JSON.parse(readFileSync(join(root, 'conformance/automatic.json'), 'utf8'));
  const reserved = new Set(automatic.reserved.map(r => r.name));
  for (const { cases } of Object.values(v2.sections)) {
    for (const c of cases) {
      const reports = c.steps.filter(s => 'pushPermission' in s).length;
      const events = c.expectedRequests.flatMap(r => r.events ?? []);
      const sent = events.filter(e => e.event_type === 'push_permission_changed');
      if (reports === 0) assert.equal(sent.length, 0, c.name);
      else assert.ok(sent.length > 0, `${c.name} reports a permission but expects no push_permission_changed`);
      for (const e of events) {
        if (!reserved.has(e.event_type)) continue;
        assert.ok(!('external_user_id' in e) && !('anonymous_id' in e), `${c.name}: automatic events are compared without identity`);
      }
    }
  }
});
