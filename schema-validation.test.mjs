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
  assert.equal(result.schemaCount, 13);
  assert.equal(result.fixtureCount, 15);
});

for (const [name, file, mutate] of [
  ['identity enum', 'conformance/connectors/supabase.json', d => { d.manifest.capabilities.identity = 'can_create_any_user'; }],
  ['outcome enum', 'conformance/connectors/supabase.json', d => { d.cases[0].expect.outcome = 'nonsense_not_in_enum'; }],
  ['primitive type', 'conformance/connectors/supabase.json', d => { d.manifest.capabilities.live_stream = 'true'; }],
  ['required property', 'conformance/connectors/supabase.json', d => { delete d.manifest.provider; }],
  ['unknown local reference', 'conformance/connectors/supabase.json', d => { d.$schema = '../../schemas/not-present.json'; }],
  ['unknown remote reference', 'schemas/connector-fixture.schema.json', d => { d.properties.manifest.$ref = 'https://example.invalid/missing.json'; }],
  ['unreferenced invalid regex', 'schemas/relay.schema.json', d => { d.$defs.payload.propertyNames.not.pattern = '(?i)email'; }],
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
