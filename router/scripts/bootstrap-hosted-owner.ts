import '../src/lib/env.js';
import { getRuntimeConfig } from '../src/runtime/config.js';
import { closePostgres, getPostgresPool } from '../src/runtime/postgres.js';

const userId = process.argv[2];
if (!userId || !/^[0-9a-f-]{36}$/i.test(userId)) throw new Error('Usage: npm run bootstrap:owner -- <supabase-user-uuid>');
const config = getRuntimeConfig();
if (!config.serviceMode || !config.hosted) throw new Error('bootstrap:owner is only valid in staging or production service mode.');
const client = await getPostgresPool().connect();
try {
  await client.query('begin');
  const result = await client.query(`update router.beta_users set role='owner',status='active',is_developer=true,activated_at=coalesce(activated_at,now()),
    daily_limit_microusd=2000000,monthly_limit_microusd=10000000,max_concurrency=2,flash_enabled=true,pro_enabled=true
    where user_id=$1 returning user_id,status,role,is_developer,is_advertiser`, [userId]);
  if (!result.rows[0]) throw new Error('User must sign in and register before owner bootstrap.');
  await client.query('commit');
  console.log(JSON.stringify(result.rows[0]));
} catch (error) {
  await client.query('rollback');
  throw error;
} finally {
  client.release();
  await closePostgres();
}
