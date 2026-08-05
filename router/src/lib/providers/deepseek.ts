import { createOpenAI } from '@ai-sdk/openai';
import { streamText } from 'ai';
import OpenAI from 'openai';
import type { ProviderAdapter, ProviderAgentResult, ProviderAssistant, ProviderMessage, ProviderRequest, ProviderToolCall } from './types.js';
import { getRuntimeConfig } from '../../runtime/config.js';

const apiKey = process.env.DEEPSEEK_API_KEY ?? '';
const baseURL = process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com';
const sdk = createOpenAI({ baseURL, apiKey, name: 'deepseek' });
const client = new OpenAI({ baseURL: `${baseURL.replace(/\/+$/, '')}/v1`, apiKey: apiKey || 'missing' });

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

function normalizeUsage(value: unknown) {
  const usage = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const prompt = count(usage.promptTokens ?? usage.prompt_tokens);
  const cacheRead = Math.min(prompt, count(usage.promptCacheHitTokens ?? usage.prompt_cache_hit_tokens));
  return {
    input_tokens: prompt - cacheRead,
    cache_read_tokens: cacheRead,
    cache_write_tokens: count(usage.cacheWriteTokens ?? usage.cache_write_tokens),
    output_tokens: count(usage.completionTokens ?? usage.completion_tokens),
  };
}

function thinkingParameters(level: ProviderRequest['thinkingLevel']): Record<string, unknown> {
  const thinking = level === 'none' ? { type: 'disabled' } : { type: 'enabled' };
  return level === 'none' ? { thinking } : { thinking, reasoning_effort: level === 'high' ? 'max' : 'high' };
}

function chatModel(model: string, thinkingLevel: ProviderRequest['thinkingLevel']) {
  const thinking = thinkingLevel === 'none' ? { type: 'disabled' as const } : { type: 'enabled' as const };
  const settings: Record<string, unknown> = { thinking, extraBody: { thinking } };
  if (thinkingLevel !== 'none') {
    const reasoningEffort = thinkingLevel === 'high' ? 'max' : 'high';
    settings.reasoningEffort = reasoningEffort;
    settings.reasoning_effort = reasoningEffort;
    settings.extraBody = { thinking, reasoning_effort: reasoningEffort };
  }
  return (sdk as unknown as (id: string, options?: Record<string, unknown>) => ReturnType<typeof sdk>)(model, settings);
}

function stringifyContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.flatMap((block): string[] => {
    if (!block || typeof block !== 'object') return [];
    const value = block as Record<string, unknown>;
    if (value.type === 'text' && typeof value.text === 'string') return [value.text];
    if (value.type === 'image') return ['(image omitted)'];
    return [];
  }).join('\n');
}

function contentBlocks(content: unknown): Record<string, unknown>[] {
  if (!Array.isArray(content)) return [];
  return content.filter((block): block is Record<string, unknown> => Boolean(block) && typeof block === 'object');
}

function assistantText(content: unknown): string {
  return contentBlocks(content).flatMap((block): string[] =>
    block.type === 'text' && typeof block.text === 'string' ? [block.text] : [],
  ).join('');
}

function assistantReasoning(content: unknown): string | undefined {
  const blocks = contentBlocks(content).flatMap((block): string[] =>
    block.type === 'thinking' &&
    typeof block.thinking === 'string' &&
    (block.thinkingSignature === undefined || block.thinkingSignature === 'reasoning_content')
      ? [block.thinking]
      : [],
  );
  return blocks.length > 0 ? blocks.join('\n') : undefined;
}

function toolCallSignature(name: string, args: unknown): string {
  return JSON.stringify({ name, arguments: args ?? {} });
}

function toChatMessages(messages: ProviderMessage[]) {
  return messages.filter((message) => message.role === 'user' || message.role === 'assistant')
    .map((message) => ({ role: message.role as 'user' | 'assistant', content: stringifyContent(message.content) }));
}

function parseArguments(value: string): Record<string, unknown> {
  try {
    const result = JSON.parse(value || '{}');
    return result && typeof result === 'object' && !Array.isArray(result) ? result as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

/** Serialize Pi/AdRouter context without losing DeepSeek thinking-mode state. */
export function serializeDeepSeekAgentMessages(
  request: ProviderRequest,
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const output: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [{ role: 'system', content: request.systemPrompt }];
  const knownToolCalls = new Map<string, string>();
  const knownToolResults = new Map<string, string>();
  for (const message of request.messages) {
    const content = stringifyContent(message.content);
    if (message.role === 'system' && content) output.push({ role: 'system', content });
    if (message.role === 'user') output.push({ role: 'user', content });
    if (message.role === 'toolResult' && typeof message.toolCallId === 'string') {
      const id = message.toolCallId;
      if (!id) throw new Error('invalid_tool_context: tool result is missing a tool call ID.');
      const resultContent = content || '(no tool output)';
      const existingResult = knownToolResults.get(id);
      if (existingResult !== undefined) {
        if (existingResult !== resultContent) {
          throw new Error(`invalid_tool_context: conflicting tool results reuse tool call ID ${id}.`);
        }
        continue;
      }
      knownToolResults.set(id, resultContent);
      output.push({ role: 'tool', tool_call_id: id, content: resultContent });
    }
    if (message.role === 'assistant') {
      const text = assistantText(message.content);
      const reasoning = assistantReasoning(message.content);
      const tool_calls = contentBlocks(message.content).flatMap((value): OpenAI.Chat.Completions.ChatCompletionMessageToolCall[] => {
        if (value.type !== 'toolCall' || typeof value.id !== 'string' || typeof value.name !== 'string') return [];
        if (!value.id || !value.name) throw new Error('invalid_tool_context: tool call is missing an ID or name.');
        const signature = toolCallSignature(value.name, value.arguments);
        const existingCall = knownToolCalls.get(value.id);
        if (existingCall !== undefined) {
          if (existingCall !== signature) {
            throw new Error(`invalid_tool_context: conflicting tool calls reuse tool call ID ${value.id}.`);
          }
          return [];
        }
        knownToolCalls.set(value.id, signature);
        return [{ id: value.id, type: 'function', function: { name: value.name, arguments: JSON.stringify(value.arguments ?? {}) } }];
      });
      if (text || reasoning !== undefined || tool_calls.length) {
        const assistantMessage: OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam & {
          reasoning_content?: string;
        } = {
          role: 'assistant',
          content: text || '',
          ...(request.thinkingLevel === 'none' ? {} : { reasoning_content: reasoning ?? '' }),
          ...(tool_calls.length ? { tool_calls } : {}),
        };
        output.push(assistantMessage);
      }
    }
  }
  return output;
}

function toTools(tools: unknown[] | undefined): OpenAI.Chat.Completions.ChatCompletionTool[] | undefined {
  if (!tools?.length) return undefined;
  return tools.flatMap((item): OpenAI.Chat.Completions.ChatCompletionTool[] => {
    if (!item || typeof item !== 'object') return [];
    const tool = item as Record<string, unknown>;
    if (typeof tool.name !== 'string' || !tool.name) return [];
    return [{ type: 'function', function: { name: tool.name, description: typeof tool.description === 'string' ? tool.description : undefined, parameters: tool.parameters && typeof tool.parameters === 'object' ? tool.parameters as Record<string, unknown> : { type: 'object', properties: {} } } }];
  });
}

function assistant(message: OpenAI.Chat.Completions.ChatCompletionMessage): ProviderAssistant {
  const toolCalls = (message.tool_calls ?? []).map((tool): ProviderToolCall => ({ id: tool.id, name: tool.function.name, function: { name: tool.function.name, arguments: tool.function.arguments }, arguments: parseArguments(tool.function.arguments) }));
  const reasoning = (message as unknown as Record<string, unknown>).reasoning_content;
  return { content: typeof message.content === 'string' ? message.content : '', reasoning_content: typeof reasoning === 'string' && reasoning ? reasoning : undefined, tool_calls: toolCalls, toolCalls };
}

export const deepseekProvider: ProviderAdapter = {
  id: 'deepseek',
  configured: () => Boolean(apiKey),
  thinkingParameters,
  runtimeMode: (requested) => {
    const config = getRuntimeConfig();
    if (requested === 'mock') return 'mock';
    if (config.serviceMode && config.environment === 'local' && requested !== 'live') return 'mock';
    return requested !== 'live' && !apiKey ? 'mock' : 'live';
  },
  normalizeUsage,
  async streamChat(request, writeEvent) {
    const result = streamText({ model: chatModel(request.model, request.thinkingLevel), system: request.systemPrompt, messages: toChatMessages(request.messages), maxTokens: request.maxOutputTokens, abortSignal: request.abortSignal });
    for await (const delta of result.textStream) writeEvent({ type: 'text', content: delta });
    return normalizeUsage(await result.usage);
  },
  async completeAgent(request): Promise<ProviderAgentResult> {
    const completion = await client.chat.completions.create({ model: request.model, messages: serializeDeepSeekAgentMessages(request), tools: toTools(request.tools), max_tokens: request.maxOutputTokens, ...thinkingParameters(request.thinkingLevel) }, { signal: request.abortSignal });
    return { assistant: assistant(completion.choices[0]?.message ?? { role: 'assistant', content: null }), usage: normalizeUsage(completion.usage) };
  },
  async streamAgent(request, writeEvent): Promise<ProviderAgentResult> {
    const completion = await client.chat.completions.create({ model: request.model, messages: serializeDeepSeekAgentMessages(request), tools: toTools(request.tools), max_tokens: request.maxOutputTokens, stream: true, stream_options: { include_usage: true }, ...thinkingParameters(request.thinkingLevel) } as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming, { signal: request.abortSignal });
    let content = ''; let reasoning = ''; let usage = normalizeUsage(undefined);
    const toolCalls = new Map<number, { id: string; name: string; arguments: string }>();
    for await (const chunk of completion) {
      if (chunk.usage) usage = normalizeUsage(chunk.usage);
      const delta = chunk.choices[0]?.delta as unknown as Record<string, unknown> | undefined;
      if (!delta) continue;
      if (typeof delta.content === 'string' && delta.content) { content += delta.content; writeEvent({ type: 'text', content: delta.content, delta: delta.content }); }
      if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) { reasoning += delta.reasoning_content; writeEvent({ type: 'thinking', content: delta.reasoning_content, delta: delta.reasoning_content }); }
      for (const item of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
        if (!item || typeof item !== 'object') continue;
        const tool = item as Record<string, unknown>; const index = typeof tool.index === 'number' ? tool.index : 0;
        const current = toolCalls.get(index) ?? { id: '', name: '', arguments: '' };
        if (typeof tool.id === 'string') current.id = tool.id;
        const fn = tool.function && typeof tool.function === 'object' ? tool.function as Record<string, unknown> : undefined;
        if (typeof fn?.name === 'string') current.name += fn.name;
        if (typeof fn?.arguments === 'string') current.arguments += fn.arguments;
        toolCalls.set(index, current);
      }
    }
    const calls = [...toolCalls.values()].filter((tool) => tool.id && tool.name).map((tool): ProviderToolCall => ({ id: tool.id, name: tool.name, function: { name: tool.name, arguments: tool.arguments }, arguments: parseArguments(tool.arguments) }));
    return { assistant: { content, reasoning_content: reasoning || undefined, tool_calls: calls, toolCalls: calls }, usage };
  },
};
