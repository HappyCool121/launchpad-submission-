import { getRuntimeConfig } from '../../runtime/config.js';
import { createOpenAICompatibleProvider } from './openai-compatible.js';

export const mimoProvider = createOpenAICompatibleProvider({
  id: 'mimo',
  connection: () => {
    const config = getRuntimeConfig();
    return { apiKey: config.mimoApiKey, baseURL: config.mimoBaseUrl, enabled: config.mimoEnabled };
  },
  thinkingParameters: (_model, level) => ({ thinking: { type: level === 'none' ? 'disabled' : 'enabled' } }),
  maxTokensParameter: 'max_completion_tokens',
});
