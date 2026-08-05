import assert from 'node:assert/strict';
import { defaultModel, listModels, resolveModel } from '../src/lib/modelRegistry.js';
import { agnesProvider } from '../src/lib/providers/agnes.js';
import { getRuntimeConfig, resetRuntimeConfigForTests } from '../src/runtime/config.js';

const keys = [
  'LAUNCHPAD_SUBMISSION',
  'ROUTER_RUNTIME_PROFILE',
  'ADROUTER_ENV',
  'ADROUTER_API_KEY',
  'AGNES_ENABLED',
  'AGNES_API_KEY',
  'AGNES_BASE_URL',
] as const;
const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));

function reset(): void {
  for (const key of keys) delete process.env[key];
  process.env.LAUNCHPAD_SUBMISSION = 'true';
  process.env.ROUTER_RUNTIME_PROFILE = 'demo';
  process.env.ADROUTER_ENV = 'local';
  resetRuntimeConfigForTests();
}

try {
  reset();
  assert.throws(() => getRuntimeConfig(), /ADROUTER_API_KEY is required/);

  reset();
  process.env.ADROUTER_API_KEY = 'offline-router-fixture';
  assert.throws(() => getRuntimeConfig(), /live AGNES_API_KEY is required/);

  reset();
  process.env.ADROUTER_API_KEY = 'offline-router-fixture';
  process.env.AGNES_ENABLED = 'true';
  process.env.AGNES_API_KEY = 'offline-agnes-fixture';
  process.env.AGNES_BASE_URL = 'http://127.0.0.1:1/v1';
  const config = getRuntimeConfig();
  assert.equal(config.launchpadMode, true);
  assert.equal(config.serviceMode, false);
  assert.equal(defaultModel(), 'agnes-2.5-flash');
  assert.deepEqual(listModels().map((model) => model.id), [
    'agnes-2.0-flash',
    'agnes-2.5-flash',
    'agnes-2.5-pro',
    'agnes-2.5-pro-alpha',
  ]);
  assert.equal(resolveModel('deepseek-v4-flash'), undefined);
  assert.equal(agnesProvider.runtimeMode('auto'), 'live');
  assert.equal(agnesProvider.runtimeMode('live'), 'live');
  assert.throws(() => agnesProvider.runtimeMode('mock'), /mock_mode_not_available/);

  console.log('OK: LaunchPad is live-only, Agnes-only, credential-gated, and defaults to agnes-2.5-flash.');
} finally {
  for (const key of keys) {
    const value = original[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetRuntimeConfigForTests();
}
