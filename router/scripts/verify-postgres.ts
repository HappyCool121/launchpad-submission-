import '../src/lib/env.js';
import { closePostgres, getPostgresPool, verifyPostgres } from '../src/runtime/postgres.js';
await verifyPostgres();
const inaccessible = await getPostgresPool().query(`select has_schema_privilege(current_user,'auth','usage') as allowed`);
if (inaccessible.rows[0]?.allowed) throw new Error('Runtime role must not have auth schema access.');
await closePostgres(); console.log('OK: restricted PostgreSQL runtime role and router schema are available.');
