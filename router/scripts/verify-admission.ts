import assert from 'node:assert/strict';
import { CANONICAL_MODEL_REGISTRY } from '../src/lib/modelRegistry.js';
import { requireAdmission } from '../src/runtime/admission.js';
import { resetRuntimeConfigForTests } from '../src/runtime/config.js';

type Result = { status?: number; next: boolean; code?: string; details?: Record<string, number> };
function invoke(body: unknown) { return new Promise<Result>((resolve) => { const state: Result = { next: false }; const req = { body, once() {} } as never; const res = { locals: {}, status(code: number) { state.status = code; return this; }, json(payload: { code?: string; details?: Record<string, number> }) { state.code = payload.code; state.details = payload.details; resolve(state); } } as never; void requireAdmission(req, res, () => { state.next = true; resolve(state); }); }); }

for (const descriptor of CANONICAL_MODEL_REGISTRY) {
  assert.equal((await invoke({ model: descriptor.id, max_output_tokens: descriptor.max_output_tokens })).next, true, descriptor.id);
  const rejected = await invoke({ model: descriptor.id, max_output_tokens: descriptor.max_output_tokens + 1 });
  assert.equal(rejected.status, 400, descriptor.id);
  assert.equal(rejected.code, 'output_limit_exceeded', descriptor.id);
  assert.deepEqual(rejected.details, {
    context_window: descriptor.context_window,
    max_input_tokens: descriptor.max_input_tokens,
    max_output_tokens: descriptor.max_output_tokens,
    allowed_output_tokens: descriptor.max_output_tokens,
    requested_output_tokens: descriptor.max_output_tokens + 1,
  });
  assert.equal((await invoke({ model: descriptor.id })).next, true, `${descriptor.id} default`);
}

const invalid = await invoke({ model: 'not-a-model', max_output_tokens: 999_999 });
assert.equal(invalid.code, 'invalid_model');

process.env.ROUTER_MAX_OUTPUT_TOKENS = '1000';
process.env.ROUTER_DEFAULT_OUTPUT_TOKENS = '1000';
resetRuntimeConfigForTests();
assert.equal((await invoke({ model: 'deepseek-v4-flash', max_output_tokens: 1000 })).next, true);
assert.equal((await invoke({ model: 'deepseek-v4-flash', max_output_tokens: 1001 })).code, 'output_limit_exceeded');
delete process.env.ROUTER_MAX_OUTPUT_TOKENS;
delete process.env.ROUTER_DEFAULT_OUTPUT_TOKENS;
resetRuntimeConfigForTests();

console.log('OK: all selected-model output boundaries, the 4096 default, and tighter platform caps are enforced before provider execution.');
