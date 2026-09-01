import Ajv2020 from 'ajv/dist/2020.js';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function jsonFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? jsonFiles(path) : entry.name.endsWith('.json') ? [path] : [];
  }).sort();
}

export function validateSchemas(root) {
  // All references resolve from this checkout. No loadSchema callback means a
  // missing external reference fails closed, never downloads another contract.
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const schemas = new Map(jsonFiles(join(root, 'schemas')).map(path => [resolve(path), JSON.parse(readFileSync(path, 'utf8'))]));
  for (const [path, schema] of schemas) {
    if (!schema.$id) throw new Error(`${path}: schema must declare $id`);
    ajv.addSchema(schema);
  }
  for (const [path, schema] of schemas) {
    // Compile exported $defs too, including ones no fixture references yet.
    ajv.getSchema(schema.$id);
    for (const name of Object.keys(schema.$defs ?? {})) {
      ajv.getSchema(`${schema.$id}#/$defs/${name.replaceAll('~', '~0').replaceAll('/', '~1')}`);
    }
    function checkRegex(node) {
      if (!node || typeof node !== 'object') return;
      if (typeof node.pattern === 'string') new RegExp(node.pattern, 'u');
      for (const pattern of Object.keys(node.patternProperties ?? {})) new RegExp(pattern, 'u');
      for (const value of Object.values(node)) checkRegex(value);
    }
    try { checkRegex(schema); } catch (error) { throw new Error(`${path}: ${error.message}`); }
  }
  const errors = [];
  const fixtures = jsonFiles(join(root, 'conformance'));
  for (const path of fixtures) {
    const fixture = JSON.parse(readFileSync(path, 'utf8'));
    const reference = fixture.$schema;
    if (typeof reference !== 'string') { errors.push(`${path}: missing $schema`); continue; }
    const [relativePath, fragment] = reference.split('#');
    const schema = schemas.get(resolve(dirname(path), relativePath));
    if (!schema) { errors.push(`${path}: $schema must name a checked-in local schema`); continue; }
    const validate = ajv.getSchema(schema.$id + (fragment ? `#${fragment}` : ''));
    if (!validate) { errors.push(`${path}: unresolved schema ${reference}`); continue; }
    if (!validate(fixture)) errors.push(`${path}: ${ajv.errorsText(validate.errors, { separator: '; ' })}`);
  }
  return { errors, schemaCount: schemas.size, fixtureCount: fixtures.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = validateSchemas(resolve(process.argv[2] ?? dirname(fileURLToPath(import.meta.url))));
    if (result.errors.length) throw new Error(result.errors.join('\n'));
    console.log(`Schema validation OK: ${result.schemaCount} compiled schemas, ${result.fixtureCount} validated fixture files (structural conformance only).`);
  } catch (error) {
    console.error(`Schema validation FAILED: ${error.message}`);
    process.exitCode = 1;
  }
}
