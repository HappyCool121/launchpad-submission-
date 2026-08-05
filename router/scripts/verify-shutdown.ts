import assert from 'node:assert/strict';
import { activeRequestCount, beginDraining, isDraining, isReady, markBootCompleted, releaseReservation, trackReservation } from '../src/runtime/state.js';
markBootCompleted(); assert.equal(isReady(), true); trackReservation('one'); assert.equal(activeRequestCount(), 1); beginDraining(); assert.equal(isDraining(), true); assert.equal(isReady(), false); releaseReservation('one'); assert.equal(activeRequestCount(), 0);
console.log('OK: draining immediately removes readiness and tracks unresolved work.');
