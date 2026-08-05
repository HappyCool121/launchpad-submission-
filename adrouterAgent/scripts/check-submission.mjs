import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const env = await readFile(new URL('../.env.example', import.meta.url), 'utf8');
const constants = await readFile(new URL('../src/shared/constants.ts', import.meta.url), 'utf8');
const configuration = await readFile(
  new URL('../src/main/configuration-store.ts', import.meta.url),
  'utf8'
);
const routerClient = await readFile(new URL('../src/runtime/router-client.ts', import.meta.url), 'utf8');
const importedSessions = await readFile(new URL('../src/main/session-service.ts', import.meta.url), 'utf8');

assert.match(env, /^ADROUTER_API_URL=http:\/\/127\.0\.0\.1:8787$/m);
assert.match(env, /^ADROUTER_MODEL_ROUTE=agnes-2\.5-flash$/m);
assert.doesNotMatch(env, /^AGNES_API_KEY=/m);
assert.match(constants, /DEFAULT_ADROUTER_SERVER_URL = 'http:\/\/127\.0\.0\.1:8787'/);
assert.match(configuration, /safeStorage/);
assert.match(configuration, /agnes-2\.5-flash/);
assert.match(routerClient, /\/v1\/agent\/turn/);
assert.match(routerClient, /removeSponsorData/);
assert.match(importedSessions, /let model = 'agnes-2\.5-flash'/);

console.log('OK: Agent loopback default, safe local bearer storage, Agnes default, and sponsor isolation are present.');
