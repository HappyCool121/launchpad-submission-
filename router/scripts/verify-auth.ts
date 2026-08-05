import assert from 'node:assert/strict';
import type { NextFunction, Request, Response } from 'express';
import { requireRouterAuth } from '../src/lib/profile.js';
import { browserIdentityFromClaims, requireDeveloper, requireRole, type Principal } from '../src/runtime/auth.js';

const googleIdentity = browserIdentityFromClaims({
  sub: '11111111-1111-1111-1111-111111111111',
  role: 'authenticated',
  email: ' Google@Example.Test ',
  app_metadata: { provider: 'google' },
});
assert.deepEqual(googleIdentity, {
  userId: '11111111-1111-1111-1111-111111111111',
  email: 'google@example.test',
  provider: 'google',
});
assert.throws(() => browserIdentityFromClaims({
  sub: '22222222-2222-2222-2222-222222222222',
  role: 'authenticated',
  email: 'github@example.test',
  app_metadata: { provider: 'github' },
}), /not an authenticated non-anonymous user token/);

let status = 0;
let body: unknown;
const response = {
  status(code: number) { status = code; return this; },
  json(value: unknown) { body = value; return this; },
} as unknown as Response;
requireRouterAuth({ headers: { authorization: 'Bearer adr_live_retired' } } as Request, response, (() => {
  throw new Error('retired shared credentials must not reach the route');
}) as NextFunction);
assert.equal(status, 404);
assert.deepEqual(body, { error: 'Not found.', code: 'route_not_available' });
status = 0;
body = undefined;
let nextCalled = false;
const developerResponse = {
  locals: { principal: { status: 'active', isDeveloper: false } as Principal },
  status(code: number) { status = code; return this; },
  json(value: unknown) { body = value; return this; },
} as unknown as Response;
requireDeveloper({} as Request, developerResponse, (() => { nextCalled = true; }) as NextFunction);
assert.equal(nextCalled, false);
assert.equal(status, 403);
assert.deepEqual(body, { error: 'Developer access is not enabled for this account.', code: 'developer_required' });
(developerResponse.locals.principal as Principal).isDeveloper = true;
requireDeveloper({} as Request, developerResponse, (() => { nextCalled = true; }) as NextFunction);
assert.equal(nextCalled, true);
status = 0;
body = undefined;
nextCalled = false;
const ownerResponse = {
  locals: { principal: { role: 'operator', status: 'active' } as Principal },
  status(code: number) { status = code; return this; },
  json(value: unknown) { body = value; return this; },
} as unknown as Response;
requireRole('owner')({} as Request, ownerResponse, (() => { nextCalled = true; }) as NextFunction);
assert.equal(nextCalled, false);
assert.equal(status, 403);
assert.deepEqual(body, { error: 'forbidden', code: 'operator_required' });
(ownerResponse.locals.principal as Principal).role = 'owner';
requireRole('owner')({} as Request, ownerResponse, (() => { nextCalled = true; }) as NextFunction);
assert.equal(nextCalled, true);
console.log('OK: the retired hosted shared-credential entry point is unavailable before authentication.');
console.log('OK: browser identity accepts Google and rejects GitHub OAuth claims.');
console.log('OK: developer entitlement is an independent stable execution gate.');
console.log('OK: owner-only middleware rejects active operators and accepts active owners.');
