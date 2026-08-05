import { getRuntimeConfig } from '../../runtime/config.js';
import { createOpenAICompatibleProvider } from './openai-compatible.js';

export const agnesProvider = createOpenAICompatibleProvider({
  id: 'agnes',
  connection: () => {
    const config = getRuntimeConfig();
    return { apiKey: config.agnesApiKey, baseURL: config.agnesBaseUrl, enabled: config.agnesEnabled };
  },
  thinkingParameters: (model, level) => (model === 'agnes-2.0-flash' || model === 'agnes-2.5-flash') && level === 'high'
    ? { chat_template_kwargs: { enable_thinking: true } }
    : {},
  maxTokensParameter: 'max_tokens',
  systemMessageStrategy: 'merge',
});
