import assert from 'node:assert/strict';
import { logEvent } from '../src/runtime/logging.js';
let line = ''; const original = console.log; console.log = (value?: unknown) => { line = String(value); };
logEvent('test', { outcome: 'ok', prompt: 'forbidden prompt', api_key: 'forbidden key', access_token: 'forbidden token', token_count: 10, latency_ms: 3 }); console.log = original;
const parsed = JSON.parse(line) as Record<string, unknown>; assert.equal(parsed.outcome, 'ok'); assert.equal(parsed.latency_ms, 3); assert(!line.includes('forbidden'));
original('OK: structured logs reject prohibited content and credential fields.');
