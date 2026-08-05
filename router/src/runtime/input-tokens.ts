import { readFileSync } from 'node:fs';
import { Tokenizer } from '@huggingface/tokenizers';
import type { ProviderId } from '../lib/types.js';

type JsonObject = Record<string, unknown>;

const tokenizerJson = JSON.parse(readFileSync(new URL('./deepseek-tokenizer/tokenizer.json', import.meta.url), 'utf8')) as JsonObject;
const tokenizerConfig = JSON.parse(readFileSync(new URL('./deepseek-tokenizer/tokenizer_config.json', import.meta.url), 'utf8')) as JsonObject;
const tokenizer = new Tokenizer(tokenizerJson, tokenizerConfig);

function object(value: unknown): JsonObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined;
}

function content(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value ?? '');
}

function messagesFrom(body: JsonObject): JsonObject[] {
  const context = object(body.context);
  const input = object(body.input);
  const messages = body.messages ?? context?.messages ?? input?.messages;
  return Array.isArray(messages) ? messages.flatMap((message) => object(message) ? [object(message)!] : []) : [];
}

function toolsFrom(body: JsonObject): unknown[] {
  const context = object(body.context);
  const input = object(body.input);
  const tools = context?.tools ?? input?.tools;
  return Array.isArray(tools) ? tools : [];
}

/** Serialize provider-visible context with DeepSeek V3 chat framing tokens. */
export function serializeDeepSeekInput(body: unknown): string {
  const root = object(body) ?? {};
  const context = object(root.context);
  const input = object(root.input);
  const systemParts = [
    typeof context?.systemPrompt === 'string' ? context.systemPrompt : undefined,
    typeof input?.instructions === 'string' ? input.instructions : undefined,
  ].filter((value): value is string => Boolean(value));
  const tools = toolsFrom(root);
  if (tools.length) systemParts.push(`# Available tools\n${JSON.stringify(tools)}`);

  let serialized = `<｜begin▁of▁sentence｜>${systemParts.join('\n\n')}`;
  let toolOutputOpen = false;
  for (const message of messagesFrom(root)) {
    const role = message.role;
    if (role === 'system') {
      serialized += `\n\n${content(message.content)}`;
    } else if (role === 'user') {
      if (toolOutputOpen) { serialized += '<｜tool▁outputs▁end｜>'; toolOutputOpen = false; }
      serialized += `<｜User｜>${content(message.content)}`;
    } else if (role === 'tool' || role === 'toolResult') {
      serialized += toolOutputOpen ? '<｜tool▁output▁begin｜>' : '<｜tool▁outputs▁begin｜><｜tool▁output▁begin｜>';
      serialized += `${JSON.stringify(message)}<｜tool▁output▁end｜>`;
      toolOutputOpen = true;
    } else if (role === 'assistant') {
      if (toolOutputOpen) { serialized += '<｜tool▁outputs▁end｜>'; toolOutputOpen = false; }
      serialized += `<｜Assistant｜>${JSON.stringify(message)}<｜end▁of▁sentence｜>`;
    } else {
      serialized += `\n${JSON.stringify(message)}`;
    }
  }
  if (toolOutputOpen) serialized += '<｜tool▁outputs▁end｜>';
  return `${serialized}<｜Assistant｜>`;
}

export function estimateDeepSeekInputTokens(body: unknown): number {
  return Math.max(1, tokenizer.encode(serializeDeepSeekInput(body)).ids.length);
}

/** Conservative upper bound for providers whose exact tokenizer is not bundled. */
export function estimateOpenAICompatibleInputTokens(body: unknown): number {
  const root = object(body) ?? {};
  const context = object(root.context);
  const input = object(root.input);
  const messages = messagesFrom(root);
  const tools = toolsFrom(root);
  const providerVisible = {
    systemPrompt: context?.systemPrompt ?? input?.instructions,
    messages,
    tools,
  };
  const bytes = Buffer.byteLength(JSON.stringify(providerVisible), 'utf8');
  const framingOverhead = messages.length * 12 + tools.length * 24 + 16;
  return Math.max(1, bytes + framingOverhead);
}

export function estimateProviderInputTokens(body: unknown, provider: ProviderId): number {
  return provider === 'deepseek' ? estimateDeepSeekInputTokens(body) : estimateOpenAICompatibleInputTokens(body);
}
