import '../src/lib/env.js';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { getRuntimeConfig } from '../src/runtime/config.js';
import { closePostgres, getPostgresPool, verifyPostgres } from '../src/runtime/postgres.js';
import { createTestInstallationKey, nonceRetry, signedFetch } from './platform-auth-test-client.js';

await verifyPostgres();
const testEmail = process.env.ADROUTER_TEST_OWNER_EMAIL;
const testPassword = process.env.ADROUTER_TEST_OWNER_PASSWORD;
if (!testEmail || !testPassword) throw new Error('ADROUTER_TEST_OWNER_EMAIL and ADROUTER_TEST_OWNER_PASSWORD are required.');
const status = spawnSync('npx', ['supabase', '--workdir', process.env.ADROUTER_SUPABASE_WORKDIR ?? '..', 'status', '-o', 'json'], { cwd: process.cwd(), encoding: 'utf8' });
if (status.status !== 0) throw new Error('Local Supabase is not running.');
const statusValues = JSON.parse(status.stdout) as Record<string, string>;
const config = getRuntimeConfig();
const signInResponse = await fetch(`${config.supabaseUrl}/auth/v1/token?grant_type=password`, {
  method: 'POST', headers: { apikey: statusValues.ANON_KEY, 'content-type': 'application/json' },
  body: JSON.stringify({ email: testEmail, password: testPassword }),
});
const signIn = await signInResponse.json() as { access_token?: string };
if (!signIn.access_token) throw new Error('Local owner sign-in failed.');
const browserToken = signIn.access_token;
const owner = await getPostgresPool().query<{ user_id: string }>(`select user_id from router.beta_users where role='owner' and status='active' order by activated_at limit 1`);
if (!owner.rows[0]) throw new Error('A local active owner is required.');
await getPostgresPool().query(`update router.platform_settings set traffic_mode='owner_only' where singleton=true`);
await getPostgresPool().query(`update router.client_policies set enabled=true,minimum_version='0.0.0',enforcement_mode='observe',update_url=null where client_kind='cli'`);

const port = 18788;
const apiOrigin = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
  cwd: process.cwd(), env: { ...process.env, PORT: String(port), ROUTER_API_ORIGIN: apiOrigin, ROUTER_WEB_APP_ORIGIN: 'http://localhost:5173' }, stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = '';
child.stdout.on('data', (chunk) => { logs += String(chunk); });
child.stderr.on('data', (chunk) => { logs += String(chunk); });
let installationId = '';
try {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try { if ((await fetch(`${apiOrigin}/health/ready`)).ok) break; } catch { /* booting */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  for (const path of ['/v1/turn', '/v1/account/credentials', '/v1/account/credentials/retired/rotate']) {
    const unavailable = await fetch(`${apiOrigin}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(unavailable.status, 404, `${path} must be unavailable before authentication`);
    assert.deepEqual(await unavailable.json(), { error: 'Not found.', code: 'route_not_available' });
  }
  const retiredClient = await fetch(`${apiOrigin}/v1/device/authorizations`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_kind: 'opencode', client_version: '0.82.0', display_name: 'Unsupported client',
      public_key_jwk: { kty: 'OKP', crv: 'Ed25519', x: 'UlKbZgyQvgYp9JgM5TjARwtU5ClgVOi2lTGtJo5Y1d4' },
      requested_scopes: ['agent:turn'], storage_class: 'file_protected',
    }),
  });
  assert.equal(retiredClient.status, 403);
  assert.equal(((await retiredClient.json()) as { code?: string }).code, 'client_not_allowed');

  const abandonedKey = await createTestInstallationKey();
  const abandonedBody = JSON.stringify({ client_kind: 'cli', client_version: '0.82.0', display_name: 'Abandoned protocol test',
    public_key_jwk: abandonedKey.publicJwk, requested_scopes: ['agent:turn', 'profile:read'], storage_class: 'file_protected' });
  const abandonedInitiation = await nonceRetry({ url: `${apiOrigin}/v1/device/authorizations`, method: 'POST', body: abandonedBody, key: abandonedKey });
  assert.equal(abandonedInitiation.response.status, 201, await abandonedInitiation.response.clone().text());
  const abandonedDevice = await abandonedInitiation.response.json() as { device_code: string; user_code: string };
  const cancelBody = JSON.stringify({ device_code: abandonedDevice.device_code, client_kind: 'cli' });
  const wrongKeyCancel = await signedFetch({ url: `${apiOrigin}/v1/device/authorizations/cancel`, method: 'POST', body: cancelBody, key: await createTestInstallationKey() });
  assert.equal(wrongKeyCancel.response.status, 401);
  const cancelled = await nonceRetry({ url: `${apiOrigin}/v1/device/authorizations/cancel`, method: 'POST', body: cancelBody, key: abandonedKey });
  assert.equal(cancelled.response.status, 204, await cancelled.response.clone().text());
  assert.equal(cancelled.response.headers.get('cache-control'), 'no-store');
  const cancelledAgain = await fetch(`${apiOrigin}/v1/device/authorizations/cancel`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: cancelBody,
  });
  assert.equal(cancelledAgain.status, 204);
  const abandonedResolve = await fetch(`${apiOrigin}/v1/account/device-authorizations/resolve`, {
    method: 'POST', headers: { authorization: `Bearer ${browserToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ user_code: abandonedDevice.user_code }),
  });
  assert.equal(abandonedResolve.status, 404);

  const key = await createTestInstallationKey();
  const initiationBody = JSON.stringify({ client_kind: 'cli', client_version: '0.82.0', display_name: 'Local protocol test',
    public_key_jwk: key.publicJwk, requested_scopes: ['agent:turn', 'profile:read'], storage_class: 'file_protected' });
  const initiation = await nonceRetry({ url: `${apiOrigin}/v1/device/authorizations`, method: 'POST', body: initiationBody, key });
  assert.equal(initiation.response.status, 201, await initiation.response.clone().text());
  assert.equal(initiation.response.headers.get('cache-control'), 'no-store');
  const device = await initiation.response.json() as { device_code: string; user_code: string };

  const resolved = await fetch(`${apiOrigin}/v1/account/device-authorizations/resolve`, {
    method: 'POST', headers: { authorization: `Bearer ${browserToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ user_code: device.user_code }),
  });
  assert.equal(resolved.status, 200, await resolved.clone().text());
  const authorization = await resolved.json() as { authorization_id: string; attested: boolean };
  assert.equal(authorization.attested, false);
  const approved = await fetch(`${apiOrigin}/v1/account/device-authorizations/${authorization.authorization_id}/approve`, { method: 'POST', headers: { authorization: `Bearer ${browserToken}` } });
  assert.equal(approved.status, 200, await approved.text());

  const deviceGrantBody = JSON.stringify({ grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: device.device_code, client_kind: 'cli' });
  const redeemed = await nonceRetry({ url: `${apiOrigin}/v1/oauth/token`, method: 'POST', body: deviceGrantBody, key });
  assert.equal(redeemed.response.status, 200, await redeemed.response.clone().text());
  assert.equal(redeemed.response.headers.get('cache-control'), 'no-store');
  const tokens = await redeemed.response.json() as { access_token: string; refresh_token: string; installation_id: string };
  installationId = tokens.installation_id;

  const profile = await nonceRetry({ url: `${apiOrigin}/v1/profile`, accessToken: tokens.access_token, key });
  assert.equal(profile.response.status, 200, await profile.response.clone().text());
  const profileBody = await profile.response.json() as { installation?: { id: string; attested: boolean; scopes: string[] } };
  assert.equal(profileBody.installation?.id, installationId); assert.equal(profileBody.installation?.attested, false);

  const bodylessChallenge = await signedFetch({ url: `${apiOrigin}/v1/profile`, accessToken: tokens.access_token, key });
  const bodylessNonce = bodylessChallenge.response.headers.get('dpop-nonce');
  assert.equal(bodylessChallenge.response.status, 401);
  assert(bodylessNonce);
  const malformedBodyBinding = await signedFetch({
    url: `${apiOrigin}/v1/profile`, accessToken: tokens.access_token, key, nonce: bodylessNonce,
    headers: { 'content-digest': 'malformed' },
  });
  assert.equal(malformedBodyBinding.response.status, 401);

  const turnBody = JSON.stringify({ model: 'deepseek-v4-flash', runtime_mode: 'mock', max_output_tokens: 64,
    context: { messages: [{ role: 'user', content: 'deterministic local protocol check' }] }, metadata: { ads_enabled: false } });
  const reservationsBefore = await getPostgresPool().query<{ count: string }>('select count(*)::text count from router.reservations where installation_id=$1', [installationId]);
  await getPostgresPool().query(`update router.client_policies set minimum_version='99.0.0',enforcement_mode='enforce' where client_kind='cli'`);
  const belowMinimum = await nonceRetry({ url: `${apiOrigin}/v1/agent/turn`, method: 'POST', body: turnBody, accessToken: tokens.access_token, key });
  assert.equal(belowMinimum.response.status, 426);
  const reservationsAfterPolicyFailure = await getPostgresPool().query<{ count: string }>('select count(*)::text count from router.reservations where installation_id=$1', [installationId]);
  assert.equal(reservationsAfterPolicyFailure.rows[0]?.count, reservationsBefore.rows[0]?.count);
  await getPostgresPool().query(`update router.client_policies set minimum_version='0.0.0',enforcement_mode='observe' where client_kind='cli'`);
  const turn = await nonceRetry({ url: `${apiOrigin}/v1/agent/turn`, method: 'POST', body: turnBody, accessToken: tokens.access_token, key });
  const turnText = await turn.response.text();
  assert.equal(turn.response.status, 200, turnText);
  assert(turnText.includes('"type":"ad"') && turnText.includes('"type":"settlement"') && turnText.includes('"type":"done"'));
  const replay = await fetch(`${apiOrigin}/v1/agent/turn`, { method: 'POST', headers: {
    authorization: `DPoP ${tokens.access_token}`, dpop: turn.proof, 'content-type': 'application/json',
    'content-digest': `sha-256=:${(await import('node:crypto')).createHash('sha256').update(turnBody).digest('base64')}:`,
  }, body: turnBody });
  assert.equal(replay.status, 401);

  const proofBody = JSON.stringify({ ...JSON.parse(turnBody), max_output_tokens: 65 });
  const tamperChallenge = await signedFetch({ url: `${apiOrigin}/v1/agent/turn`, method: 'POST', body: turnBody, accessToken: tokens.access_token, key });
  const tampered = await signedFetch({ url: `${apiOrigin}/v1/agent/turn`, method: 'POST', body: proofBody, proofBody: turnBody,
    accessToken: tokens.access_token, key, nonce: tamperChallenge.response.headers.get('dpop-nonce') ?? undefined });
  assert.equal(tampered.response.status, 401);
  const reservationsAfterFailures = await getPostgresPool().query<{ count: string }>('select count(*)::text count from router.reservations where installation_id=$1', [installationId]);
  assert.equal(Number(reservationsAfterFailures.rows[0]!.count), Number(reservationsBefore.rows[0]!.count) + 1);

  const refreshBody = JSON.stringify({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, installation_id: installationId });
  const refreshed = await nonceRetry({ url: `${apiOrigin}/v1/oauth/token`, method: 'POST', body: refreshBody, key });
  assert.equal(refreshed.response.status, 200, await refreshed.response.clone().text());
  const rotated = await refreshed.response.json() as { access_token: string };
  const reuse = await nonceRetry({ url: `${apiOrigin}/v1/oauth/token`, method: 'POST', body: refreshBody, key });
  assert.equal(reuse.response.status, 401);
  const revokedFamilyProfile = await nonceRetry({ url: `${apiOrigin}/v1/profile`, accessToken: rotated.access_token, key });
  assert.equal(revokedFamilyProfile.response.status, 401);

  const failedEnrollmentCancel = await nonceRetry({
    url: `${apiOrigin}/v1/device/authorizations/cancel`, method: 'POST',
    body: JSON.stringify({ device_code: device.device_code, client_kind: 'cli' }), key,
  });
  assert.equal(failedEnrollmentCancel.response.status, 204, await failedEnrollmentCancel.response.clone().text());
  const revokedInstallation = await getPostgresPool().query<{ status: string }>('select status from router.client_installations where id=$1', [installationId]);
  assert.equal(revokedInstallation.rows[0]?.status, 'revoked');
  console.log('OK: local production middleware covers enrollment, cancellation, proof binding, admission boundary, replay, tamper, refresh reuse, and revocation.');
} catch (error) {
  console.error(logs); throw error;
} finally {
  await getPostgresPool().query(`update router.client_policies set enabled=true,minimum_version='0.0.0',enforcement_mode='observe',update_url=null where client_kind='cli'`).catch(() => undefined);
  if (installationId) await getPostgresPool().query('select router.revoke_client_installation($1,$2,$3)', [installationId, owner.rows[0].user_id, 'test_cleanup']).catch(() => undefined);
  child.kill('SIGTERM');
  await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 5_000))]);
  await closePostgres();
}
