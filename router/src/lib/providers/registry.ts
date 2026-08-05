import type { ProviderAdapter } from './types.js';
import { deepseekProvider } from './deepseek.js';
import { mimoProvider } from './mimo.js';
import { agnesProvider } from './agnes.js';

/** Qwen remains dormant until a concrete vendor contract is selected. */
const dormant = (id: 'qwen'): ProviderAdapter => ({
  id,
  configured: () => false,
  thinkingParameters: () => ({}),
  runtimeMode: () => 'mock',
  normalizeUsage: () => ({ input_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, output_tokens: 0 }),
  streamChat: async () => { throw new Error(`provider_unavailable: ${id} has no configured vendor contract.`); },
  completeAgent: async () => { throw new Error(`provider_unavailable: ${id} has no configured vendor contract.`); },
  streamAgent: async () => { throw new Error(`provider_unavailable: ${id} has no configured vendor contract.`); },
});

export const dormantProviders: ProviderAdapter[] = [dormant('qwen')];

export const providerRegistry: ProviderAdapter[] = [deepseekProvider, mimoProvider, agnesProvider, ...dormantProviders];

export function getProvider(id: string): ProviderAdapter | undefined {
  return providerRegistry.find((provider) => provider.id === id);
}

/** Test-only seam for proving coordinator behavior across provider implementations. */
export function registerProviderForTests(adapter: ProviderAdapter): void {
  const index = providerRegistry.findIndex((provider) => provider.id === adapter.id);
  if (index >= 0) providerRegistry.splice(index, 1, adapter);
  else providerRegistry.push(adapter);
}
