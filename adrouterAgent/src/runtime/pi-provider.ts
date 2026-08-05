import {
  type Api,
  type AssistantMessage,
  type Context,
  createAssistantMessageEventStream,
  createProvider,
  type Model,
  type Provider,
  type SimpleStreamOptions,
  type StreamFunction,
} from '@earendil-works/pi-ai';
import type {
  RouterModelDescriptor,
  RuntimeMode,
  Settlement,
  ThinkingLevel,
} from '../shared/contracts';
import { containsSponsorKey, now, removeSponsorData, safeRecord } from '../shared/security';
import {
  type ContextBudgetEstimate,
  contextOverflowMessage,
  estimateProviderContextBudget,
} from './context-budget';
import { type AdRouterClient, RouterHttpError } from './router-client';

const zeroUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export interface AdRouterPiProviderOptions {
  client: AdRouterClient;
  model: RouterModelDescriptor;
  thinkingLevel: ThinkingLevel;
  runtimeMode: RuntimeMode;
  projectDisplayName: string;
  adsEnabled: boolean;
  onSponsor: (sponsor: unknown) => void;
  onSettlement: (settlement: Settlement) => void;
  onContextOverflow?: (estimate: ContextBudgetEstimate) => void;
  compactForInputLimit?: (context: Context, signal?: AbortSignal) => Promise<Context | null>;
  onSafeRetry?: () => void;
}

export interface AdRouterPiProvider {
  provider: Provider;
  model: Model<Api>;
  stream: StreamFunction<Api, SimpleStreamOptions>;
}

const clonePartial = (message: AssistantMessage): AssistantMessage => ({
  ...message,
  content: structuredClone(message.content),
  usage: structuredClone(message.usage),
});

const initialMessage = (model: Model<Api>): AssistantMessage => ({
  role: 'assistant',
  content: [],
  api: model.api,
  provider: model.provider,
  model: model.id,
  usage: structuredClone(zeroUsage),
  stopReason: 'stop',
  timestamp: Date.now(),
});

const asError = (model: Model<Api>, error: unknown, aborted = false): AssistantMessage => ({
  ...initialMessage(model),
  stopReason: aborted ? 'aborted' : 'error',
  errorMessage: error instanceof Error ? error.message : String(error),
});

export const sanitizeToolCallArguments = (argumentsValue: Record<string, unknown>) => {
  const sanitized = safeRecord(removeSponsorData(argumentsValue));
  if (containsSponsorKey(sanitized)) {
    throw new Error('Router tool arguments contained sponsor data.');
  }
  return sanitized;
};

export const createAdRouterPiProvider = (
  options: AdRouterPiProviderOptions
): AdRouterPiProvider => {
  const model: Model<Api> = {
    id: options.model.id,
    name: options.model.displayName,
    api: 'adrouter',
    provider: 'adrouter',
    baseUrl: 'adrouter://local',
    reasoning: options.model.thinkingLevels.some((level) => level !== 'none'),
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: options.model.contextWindow,
    maxTokens: options.model.maxOutputTokens,
  };

  const stream: StreamFunction<Api, SimpleStreamOptions> = (
    requestedModel,
    context,
    streamOptions
  ) => {
    const output = createAssistantMessageEventStream();
    queueMicrotask(async () => {
      const partial = initialMessage(requestedModel);
      let started = false;
      let sawToolCall = false;

      const budget = estimateProviderContextBudget(context, options.model);
      if (budget.tokens > budget.maxInputTokens) {
        options.onContextOverflow?.(budget);
        const failed = asError(requestedModel, contextOverflowMessage(budget));
        output.push({ type: 'error', reason: 'error', error: failed });
        output.end(failed);
        return;
      }

      const start = (): void => {
        if (!started) {
          started = true;
          output.push({ type: 'start', partial: clonePartial(partial) });
        }
      };
      const text = (delta: string): void => {
        start();
        let index = partial.content.findIndex((block) => block.type === 'text');
        if (index < 0) {
          index = partial.content.length;
          partial.content.push({ type: 'text', text: '' });
          output.push({ type: 'text_start', contentIndex: index, partial: clonePartial(partial) });
        }
        const block = partial.content[index];
        if (block?.type === 'text') {
          block.text += delta;
        }
        output.push({
          type: 'text_delta',
          contentIndex: index,
          delta,
          partial: clonePartial(partial),
        });
      };
      const thinking = (delta: string): void => {
        start();
        let index = partial.content.findIndex((block) => block.type === 'thinking');
        if (index < 0) {
          index = partial.content.length;
          partial.content.push({ type: 'thinking', thinking: '' });
          output.push({
            type: 'thinking_start',
            contentIndex: index,
            partial: clonePartial(partial),
          });
        }
        const block = partial.content[index];
        if (block?.type === 'thinking') {
          block.thinking += delta;
        }
        output.push({
          type: 'thinking_delta',
          contentIndex: index,
          delta,
          partial: clonePartial(partial),
        });
      };

      let activeContext = context;
      let attempt = 0;
      while (true) {
        let consumed = false;
        try {
          for await (const event of options.client.turn(
            {
              model: requestedModel.id,
              thinkingLevel: options.thinkingLevel,
              runtimeMode: options.runtimeMode,
              messages: activeContext.messages,
              tools: activeContext.tools ?? [],
              systemPrompt: activeContext.systemPrompt,
              projectDisplayName: options.projectDisplayName,
              adsEnabled: options.adsEnabled,
            },
            streamOptions?.signal
          )) {
            consumed = true;
            if (streamOptions?.signal?.aborted) {
              const aborted = asError(requestedModel, 'Request was cancelled.', true);
              output.push({ type: 'error', reason: 'aborted', error: aborted });
              output.end(aborted);
              return;
            }
            switch (event.type) {
              case 'ad':
                options.onSponsor(event.ad);
                break;
              case 'text':
                text(event.delta);
                break;
              case 'thinking':
                thinking(event.delta);
                break;
              case 'tool_call': {
                start();
                sawToolCall = true;
                const index = partial.content.length;
                let argumentsWithoutSponsorData: Record<string, unknown>;
                try {
                  argumentsWithoutSponsorData = sanitizeToolCallArguments(event.arguments);
                } catch (_error) {
                  const failed = asError(
                    requestedModel,
                    'Router tool arguments contained sponsor data.'
                  );
                  output.push({ type: 'error', reason: 'error', error: failed });
                  output.end(failed);
                  return;
                }
                const toolCall = {
                  type: 'toolCall' as const,
                  id: event.id,
                  name: event.name,
                  arguments: argumentsWithoutSponsorData,
                };
                partial.content.push(toolCall);
                output.push({
                  type: 'toolcall_start',
                  contentIndex: index,
                  partial: clonePartial(partial),
                });
                output.push({
                  type: 'toolcall_end',
                  contentIndex: index,
                  toolCall,
                  partial: clonePartial(partial),
                });
                break;
              }
              case 'settlement':
                partial.usage = {
                  input: event.input_tokens,
                  output: event.output_tokens,
                  cacheRead: event.cache_read,
                  cacheWrite: event.cache_write,
                  totalTokens: event.total_tokens,
                  cost: {
                    input: 0,
                    output: 0,
                    cacheRead: 0,
                    cacheWrite: 0,
                    total: event.cost,
                  },
                };
                options.onSettlement({
                  routerTurnId: event.turn_id,
                  cost: event.cost,
                  subsidy: event.subsidy,
                  paid: event.paid,
                  cacheRead: event.cache_read,
                  cacheWrite: event.cache_write,
                  inputTokens: event.input_tokens,
                  outputTokens: event.output_tokens,
                  totalTokens: event.total_tokens,
                  inferencePurpose: event.purpose,
                  sponsor: null,
                  timestamp: now(),
                });
                break;
              case 'done': {
                start();
                const reason = sawToolCall ? ('toolUse' as const) : ('stop' as const);
                const completed: AssistantMessage = {
                  ...partial,
                  stopReason: reason,
                  timestamp: Date.now(),
                };
                output.push({ type: 'done', reason, message: completed });
                output.end(completed);
                return;
              }
              case 'error': {
                const failed = asError(requestedModel, event.message);
                output.push({ type: 'error', reason: 'error', error: failed });
                output.end(failed);
                return;
              }
            }
          }

          start();
          const reason = sawToolCall ? ('toolUse' as const) : ('stop' as const);
          const completed: AssistantMessage = {
            ...partial,
            stopReason: reason,
            timestamp: Date.now(),
          };
          output.push({ type: 'done', reason, message: completed });
          output.end(completed);
          return;
        } catch (error) {
          const compactor = options.compactForInputLimit;
          const mayRetry =
            attempt === 0 &&
            !consumed &&
            error instanceof RouterHttpError &&
            error.code === 'input_limit_exceeded' &&
            !streamOptions?.signal?.aborted &&
            compactor;
          if (mayRetry) {
            const compacted = await compactor(activeContext, streamOptions?.signal);
            if (compacted) {
              activeContext = compacted;
              attempt += 1;
              options.onSafeRetry?.();
              continue;
            }
          }
          const aborted = streamOptions?.signal?.aborted;
          const message = asError(requestedModel, error, aborted);
          output.push({ type: 'error', reason: aborted ? 'aborted' : 'error', error: message });
          output.end(message);
          return;
        }
      }
    });
    return output;
  };

  const provider = createProvider({
    id: 'adrouter',
    name: 'AdRouter',
    auth: {
      apiKey: {
        name: 'AdRouter runtime token',
        resolve: async () => ({ auth: {} }),
      },
    },
    models: [model],
    api: { stream, streamSimple: stream },
  });

  return { provider, model, stream };
};
