import OpenAI from 'openai';
import type {
  NormalizedUsage,
  ProviderAdapter,
  ProviderAgentResult,
  ProviderAssistant,
  ProviderMessage,
  ProviderRequest,
  ProviderToolCall,
} from './types.js';
import type { ProviderId, RouterModelId, RuntimeMode, ThinkingLevel } from '../types.js';
import { getRuntimeConfig } from '../../runtime/config.js';

type ProviderConnection = { apiKey?: string; baseURL: string; enabled: boolean };
export type SystemMessageStrategy = 'preserve' | 'merge';

export interface OpenAICompatibleProviderSpec {
  id: Extract<ProviderId, 'mimo' | 'agnes'>;
  connection(): ProviderConnection;
  thinkingParameters(model: RouterModelId, level: ThinkingLevel): Record<string, unknown>;
  maxTokensParameter: 'max_tokens' | 'max_completion_tokens';
  systemMessageStrategy?: SystemMessageStrategy;
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

export function normalizeOpenAICompatibleUsage(value: unknown): NormalizedUsage {
  const usage = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const details = usage.prompt_tokens_details && typeof usage.prompt_tokens_details === 'object'
    ? usage.prompt_tokens_details as Record<string, unknown> : {};
  const prompt = count(usage.promptTokens ?? usage.prompt_tokens);
  const cacheRead = Math.min(prompt, count(
    usage.promptCacheHitTokens
    ?? usage.prompt_cache_hit_tokens
    ?? usage.cache_read_input_tokens
    ?? details.cached_tokens,
  ));
  return {
    input_tokens: prompt - cacheRead,
    cache_read_tokens: cacheRead,
    cache_write_tokens: count(usage.cacheWriteTokens ?? usage.cache_write_tokens ?? usage.cache_creation_input_tokens),
    output_tokens: count(usage.completionTokens ?? usage.completion_tokens),
  };
}

function stringifyContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.flatMap((block): string[] => {
    if (!block || typeof block !== 'object') return [];
    const value = block as Record<string, unknown>;
    if (value.type === 'text' && typeof value.text === 'string') return [value.text];
    // Multimodal requests are intentionally outside the initial AdRouter contract.
    if (value.type === 'image' || value.type === 'image_url') return ['(image omitted)'];
    return [];
  }).join('\n');
}

function contentBlocks(content: unknown): Record<string, unknown>[] {
  if (!Array.isArray(content)) return [];
  return content.filter((block): block is Record<string, unknown> => Boolean(block) && typeof block === 'object');
}

function assistantText(content: unknown): string {
  if (typeof content === 'string') return content;
  return contentBlocks(content).flatMap((block): string[] =>
    block.type === 'text' && typeof block.text === 'string' ? [block.text] : [],
  ).join('');
}

function assistantReasoning(content: unknown): string | undefined {
  const blocks = contentBlocks(content).flatMap((block): string[] =>
    block.type === 'thinking' && typeof block.thinking === 'string' ? [block.thinking] : [],
  );
  return blocks.length ? blocks.join('\n') : undefined;
}

function parseArguments(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function toolCallSignature(name: string, args: unknown): string {
  return JSON.stringify({ name, arguments: args ?? {} });
}

/** Serialize agent history while preserving reasoning required by thinking tool turns. */
export function serializeOpenAICompatibleAgentMessages(
  request: ProviderRequest,
  systemMessageStrategy: SystemMessageStrategy = 'preserve',
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const output: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
  if (systemMessageStrategy === 'preserve') {
    output.push({ role: 'system', content: request.systemPrompt });
  } else {
    const systemMessages = [
      request.systemPrompt,
      ...request.messages.flatMap((message) => message.role === 'system' ? [stringifyContent(message.content)] : []),
    ].filter((content) => content.trim().length > 0);
    if (systemMessages.length) output.push({ role: 'system', content: systemMessages.join('\n\n') });
  }
  const knownToolCalls = new Map<string, string>();
  const knownToolResults = new Map<string, string>();
  for (const message of request.messages) {
    const rawMessage = message as unknown as Record<string, unknown>;
    const content = stringifyContent(message.content);
    if (message.role === 'system') {
      if (systemMessageStrategy === 'preserve' && content) output.push({ role: 'system', content });
      continue;
    }
    if (message.role === 'user') output.push({ role: 'user', content });
    if ((message.role === 'tool' || message.role === 'toolResult') && typeof (message.toolCallId ?? rawMessage.tool_call_id) === 'string') {
      const id = String(message.toolCallId ?? rawMessage.tool_call_id);
      if (!id) throw new Error('invalid_tool_context: tool result is missing a tool call ID.');
      const resultContent = content || '(no tool output)';
      const existing = knownToolResults.get(id);
      if (existing !== undefined) {
        if (existing !== resultContent) throw new Error(`invalid_tool_context: conflicting tool results reuse tool call ID ${id}.`);
        continue;
      }
      knownToolResults.set(id, resultContent);
      output.push({ role: 'tool', tool_call_id: id, content: resultContent });
    }
    if (message.role !== 'assistant') continue;
    const text = assistantText(message.content);
    const reasoning = assistantReasoning(message.content)
      ?? (typeof rawMessage.reasoning_content === 'string' ? rawMessage.reasoning_content : undefined);
    const tool_calls = contentBlocks(message.content).flatMap((value): OpenAI.Chat.Completions.ChatCompletionMessageToolCall[] => {
      if (value.type !== 'toolCall' || typeof value.id !== 'string' || typeof value.name !== 'string') return [];
      if (!value.id || !value.name) throw new Error('invalid_tool_context: tool call is missing an ID or name.');
      const signature = toolCallSignature(value.name, value.arguments);
      const existing = knownToolCalls.get(value.id);
      if (existing !== undefined) {
        if (existing !== signature) throw new Error(`invalid_tool_context: conflicting tool calls reuse tool call ID ${value.id}.`);
        return [];
      }
      knownToolCalls.set(value.id, signature);
      return [{ id: value.id, type: 'function', function: { name: value.name, arguments: JSON.stringify(value.arguments ?? {}) } }];
    });
    if (!text && reasoning === undefined && !tool_calls.length) continue;
    const assistantMessage: OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam & { reasoning_content?: string } = {
      role: 'assistant',
      content: text || '',
      ...(request.thinkingLevel === 'none' ? {} : { reasoning_content: reasoning ?? '' }),
      ...(tool_calls.length ? { tool_calls } : {}),
    };
    output.push(assistantMessage);
  }
  return output;
}

function toTools(tools: unknown[] | undefined): OpenAI.Chat.Completions.ChatCompletionTool[] | undefined {
  if (!tools?.length) return undefined;
  return tools.flatMap((item): OpenAI.Chat.Completions.ChatCompletionTool[] => {
    if (!item || typeof item !== 'object') return [];
    const tool = item as Record<string, unknown>;
    if (typeof tool.name !== 'string' || !tool.name) return [];
    return [{
      type: 'function',
      function: {
        name: tool.name,
        description: typeof tool.description === 'string' ? tool.description : undefined,
        parameters: tool.parameters && typeof tool.parameters === 'object'
          ? tool.parameters as Record<string, unknown> : { type: 'object', properties: {} },
      },
    }];
  });
}

function assistant(message: OpenAI.Chat.Completions.ChatCompletionMessage): ProviderAssistant {
  const toolCalls = (message.tool_calls ?? []).map((tool): ProviderToolCall => ({
    id: tool.id,
    name: tool.function.name,
    function: { name: tool.function.name, arguments: tool.function.arguments },
    arguments: parseArguments(tool.function.arguments),
  }));
  const reasoning = (message as unknown as Record<string, unknown>).reasoning_content;
  return {
    content: typeof message.content === 'string' ? message.content : '',
    reasoning_content: typeof reasoning === 'string' && reasoning ? reasoning : undefined,
    tool_calls: toolCalls,
    toolCalls,
  };
}

function client(connection: ProviderConnection): OpenAI {
  return new OpenAI({ baseURL: connection.baseURL, apiKey: connection.apiKey || 'missing' });
}

function requestBody(spec: OpenAICompatibleProviderSpec, request: ProviderRequest): Record<string, unknown> {
  return {
    model: request.model,
    messages: serializeOpenAICompatibleAgentMessages(request, spec.systemMessageStrategy),
    tools: toTools(request.tools),
    [spec.maxTokensParameter]: request.maxOutputTokens,
    ...spec.thinkingParameters(request.model, request.thinkingLevel),
  };
}

async function streamCompletion(
  spec: OpenAICompatibleProviderSpec,
  request: ProviderRequest,
  writeEvent: (event: unknown) => void,
): Promise<ProviderAgentResult> {
  const completion = await client(spec.connection()).chat.completions.create({
    ...requestBody(spec, request),
    stream: true,
    stream_options: { include_usage: true },
  } as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming, { signal: request.abortSignal });
  let content = '';
  let reasoning = '';
  let usage = normalizeOpenAICompatibleUsage(undefined);
  const toolCalls = new Map<number, { id: string; name: string; arguments: string }>();
  for await (const chunk of completion) {
    if (chunk.usage) usage = normalizeOpenAICompatibleUsage(chunk.usage);
    const delta = chunk.choices[0]?.delta as unknown as Record<string, unknown> | undefined;
    if (!delta) continue;
    if (typeof delta.content === 'string' && delta.content) {
      content += delta.content;
      writeEvent({ type: 'text', content: delta.content, delta: delta.content });
    }
    const reasoningDelta = typeof delta.reasoning_content === 'string' ? delta.reasoning_content
      : typeof delta.reasoning === 'string' ? delta.reasoning : '';
    if (reasoningDelta) {
      reasoning += reasoningDelta;
      writeEvent({ type: 'thinking', content: reasoningDelta, delta: reasoningDelta });
    }
    for (const item of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
      if (!item || typeof item !== 'object') continue;
      const tool = item as Record<string, unknown>;
      const index = typeof tool.index === 'number' ? tool.index : 0;
      const current = toolCalls.get(index) ?? { id: '', name: '', arguments: '' };
      if (typeof tool.id === 'string') current.id = tool.id;
      const fn = tool.function && typeof tool.function === 'object' ? tool.function as Record<string, unknown> : undefined;
      if (typeof fn?.name === 'string') current.name += fn.name;
      if (typeof fn?.arguments === 'string') current.arguments += fn.arguments;
      toolCalls.set(index, current);
    }
  }
  const calls = [...toolCalls.values()].filter((tool) => tool.id && tool.name).map((tool): ProviderToolCall => ({
    id: tool.id,
    name: tool.name,
    function: { name: tool.name, arguments: tool.arguments },
    arguments: parseArguments(tool.arguments),
  }));
  return { assistant: { content, reasoning_content: reasoning || undefined, tool_calls: calls, toolCalls: calls }, usage };
}

export function createOpenAICompatibleProvider(spec: OpenAICompatibleProviderSpec): ProviderAdapter {
  const configured = () => {
    const connection = spec.connection();
    return connection.enabled && Boolean(connection.apiKey?.trim());
  };
  const runtimeMode = (requested: 'auto' | RuntimeMode | undefined): RuntimeMode => {
    const config = getRuntimeConfig();
    if (config.launchpadMode) {
      if (requested === 'mock') {
        throw new Error('mock_mode_not_available: LaunchPad mode requires live Agnes execution.');
      }
      return 'live';
    }
    if (requested === 'mock') return 'mock';
    if (config.serviceMode && config.environment === 'local' && requested !== 'live') return 'mock';
    return requested !== 'live' && !configured() ? 'mock' : 'live';
  };
  return {
    id: spec.id,
    configured,
    thinkingParameters: (level) => spec.thinkingParameters('', level),
    runtimeMode,
    normalizeUsage: normalizeOpenAICompatibleUsage,
    async streamChat(request, writeEvent) {
      const result = await streamCompletion(spec, { ...request, tools: undefined }, writeEvent);
      return result.usage;
    },
    async completeAgent(request) {
      const completion = await client(spec.connection()).chat.completions.create({
        ...requestBody(spec, request),
        stream: false,
      } as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming, { signal: request.abortSignal });
      return {
        assistant: assistant(completion.choices[0]?.message ?? { role: 'assistant', content: null }),
        usage: normalizeOpenAICompatibleUsage(completion.usage),
      };
    },
    streamAgent: (request, writeEvent) => streamCompletion(spec, request, writeEvent),
  };
}
