import '../lib/env.js';
import { markStaleReservations } from '../runtime/admission.js';
import { closePostgres } from '../runtime/postgres.js';
console.log(JSON.stringify({ recovery_required: await markStaleReservations() }));
await closePostgres();
