import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateSchemas } from './validate-schemas.mjs';
import Ajv2020 from 'ajv/dist/2020.js';

const root = dirname(fileURLToPath(import.meta.url));
test('all committed schemas compile and fixtures structurally conform', () => {
  const result = validateSchemas(root);
  assert.deepEqual(result.errors, []);
  assert.equal(result.schemaCount, 15);
  assert.equal(result.fixtureCount, 17);
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
  ['automatic event name not snake_case', 'conformance/automatic.json', d => { d.reserved[0].name = 'AppInstalled'; }],
  ['unreferenced invalid regex', 'schemas/relay.schema.json', d => { d.$defs.payload.propertyNames.not.pattern = '(?i)email'; }],
  ['object setPushToken in legacy push cases', 'conformance/push.json', d => { d.cases[0].steps[1] = { setPushToken: { token: 'fcm_tok_a', kind: 'fcm' } }; }],
  ['unknown push token kind', 'conformance/push.json', d => { d.kindCases[0].steps[1].setPushToken.kind = 'hms'; }],
  ['unknown push_env on the wire', 'conformance/push.json', d => { d.kindCases[0].expectedBodies[1].channels[0].push_env = 'debug'; }],
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
