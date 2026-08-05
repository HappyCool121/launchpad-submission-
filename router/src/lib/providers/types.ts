import type { ProviderId, RouterModelId, RuntimeMode, ThinkingLevel } from '../types.js';

export interface NormalizedUsage {
  input_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  output_tokens: number;
}

export interface ProviderMessage {
  role: string;
  content?: unknown;
  toolCallId?: unknown;
  toolName?: unknown;
  timestamp?: unknown;
}

export interface ProviderToolCall {
  id: string;
  name: string;
  function: { name: string; arguments: string };
  arguments: Record<string, unknown>;
}

export interface ProviderAssistant {
  content: string;
  reasoning_content?: string;
  tool_calls: ProviderToolCall[];
  toolCalls: ProviderToolCall[];
}

export interface ProviderRequest {
  model: RouterModelId;
  thinkingLevel: ThinkingLevel;
  messages: ProviderMessage[];
  tools?: unknown[];
  systemPrompt: string;
  maxOutputTokens: number;
  abortSignal?: AbortSignal;
}

export interface ProviderAgentResult {
  assistant: ProviderAssistant;
  usage: NormalizedUsage;
}

/** Provider execution seam. Product catalog metadata is owned by modelRegistry.ts. */
export interface ProviderAdapter {
  id: ProviderId;
  configured(): boolean;
  thinkingParameters(level: ThinkingLevel): Record<string, unknown>;
  runtimeMode(requested: 'auto' | RuntimeMode | undefined): RuntimeMode;
  normalizeUsage(usage: unknown): NormalizedUsage;
  streamChat(request: ProviderRequest, writeEvent: (event: unknown) => void): Promise<NormalizedUsage>;
  completeAgent(request: ProviderRequest): Promise<ProviderAgentResult>;
  streamAgent(request: ProviderRequest, writeEvent: (event: unknown) => void): Promise<ProviderAgentResult>;
}
