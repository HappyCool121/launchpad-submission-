import '../src/lib/env.js';
import { markStaleReservations } from '../src/runtime/admission.js';
import { closePostgres } from '../src/runtime/postgres.js';
console.log(JSON.stringify({ recovery_required: await markStaleReservations() }));
await closePostgres();
