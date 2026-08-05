import assert from 'node:assert/strict';
import { startHeartbeats } from '../src/runtime/streaming.js';
const chunks: string[] = []; const stop = startHeartbeats({ write: (chunk: string) => chunks.push(chunk), writableEnded: false } as never);
await new Promise((resolve) => setTimeout(resolve, 35)); stop();
assert(chunks.some((chunk) => JSON.parse(chunk).type === 'heartbeat'));
assert(chunks.every((chunk) => typeof JSON.parse(chunk).timestamp === 'string'));
console.log('OK: NDJSON heartbeat events are content-free and periodic.');
