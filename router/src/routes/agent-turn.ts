// POST /v1/agent/turn — CLI-facing endpoint for AdRouter-backed agents.

import '../lib/env.js';
import { Router } from 'express';
import { z } from 'zod';
import {
  adToCliAds,
  adDisplayStatus,
  createMockResponse,
  DEFAULT_ROUTER_MODEL,
  DEFAULT_INJECTION,
  planAgentRouting,
  resolveRuntimeForModel,
  runAgentTurn,
  safeProviderError,
  safeWriteNdjson,
  streamAgentTurn,
  type RouterMessage,
} from '../lib/agent-routing.js';
import type { RuntimeMode } from '../lib/types.js';
import { requireMachineAgentAuth } from '../lib/profile.js';
import { abortOnResponseClose, markEventRecoveryRequired, recordQueuedImpression, settleEvent } from '../lib/persistence.js';
import { admissionFrom, handleProviderFailure, rejectHostedExecutionControls, releasePreGeneration, requireAdmission, settleAdmission } from '../runtime/admission.js';
import { requireNotDraining } from '../runtime/auth.js';
import { getRuntimeConfig } from '../runtime/config.js';

export const agentTurnRouter = Router();


const MessageSchema = z
  .object({
    role: z.enum(['system', 'user', 'assistant', 'toolResult']),
    content: z.unknown().optional(),
  })
  .passthrough();

const ContextSchema = z
  .object({
    systemPrompt: z.string().optional(),
    messages: z.array(MessageSchema),
    tools: z.array(z.unknown()).optional(),
  })
  .passthrough()
  .transform((context) => {
    const messages = context.systemPrompt
      ? [{ role: 'system' as const, content: context.systemPrompt }, ...context.messages]
      : context.messages;
    return { ...context, messages };
  });

const BodySchema = z.object({
  model: z.string().default(DEFAULT_ROUTER_MODEL),
  thinking_level: z.enum(['none', 'medium', 'high']).optional(),
  runtime_mode: z.enum(['auto', 'mock', 'live']).optional(),
  context: ContextSchema,
  metadata: z
    .object({
      client: z.string().optional(),
      workspace: z.string().optional(),
      ad_mode: z.string().optional(),
      min_ad_tier: z.union([z.string(), z.number()]).optional(),
      ads_enabled: z.boolean().optional(),
    })
    .optional(),
  max_output_tokens: z.number().int().positive().optional(),
});

agentTurnRouter.post('/v1/agent/turn', requireMachineAgentAuth, requireNotDraining, rejectHostedExecutionControls, requireAdmission, async (req, res) => {

  const parsed = BodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid body', details: parsed.error.flatten() });
    await releasePreGeneration(res); return;
  }

  let runtimeMode: RuntimeMode;
  try {
    const runtime = resolveRuntimeForModel(parsed.data.model, getRuntimeConfig().hosted ? 'live' : parsed.data.runtime_mode ?? 'auto');
    runtimeMode = runtime.runtimeMode;
    if (runtimeMode === 'live' && !runtime.configured) {
      res.status(409).json({ error: `Live API mode is not configured for ${runtime.provider}.` });
      await releasePreGeneration(res); return;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = message.startsWith('mock_mode_not_available:') ? 'mock_mode_not_available' : 'invalid_model';
    res.status(400).json({ error: message, code });
    await releasePreGeneration(res); return;
  }

  let plan;
  try {
    plan = await planAgentRouting({
      messages: parsed.data.context.messages as RouterMessage[],
      model: parsed.data.model,
      thinkingLevel: parsed.data.thinking_level,
      runtimeMode,
      adsEnabled: parsed.data.metadata?.ads_enabled,
      client: parsed.data.metadata?.client ?? 'adrouter-cli',
      reservationId: admissionFrom(res)?.reservationId,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: message, ...(message.startsWith('unsupported_thinking_level:') ? { code: 'unsupported_thinking_level' } : {}) });
    await releasePreGeneration(res); return;
  }

  const adPayload = plan.runtimeMode === 'mock' ? createMockResponse(plan).ad : plan.ad;
  const wantsJson = req.accepts(['application/x-ndjson', 'json']) === 'json';
  if (wantsJson) {
    const finalizeResponse = abortOnResponseClose(res, plan.ad.turn_id);
    try {
      const admission = admissionFrom(res);
      const result = await runAgentTurn(plan, parsed.data.context.tools, { maxOutputTokens: res.locals.maxOutputTokens as number, abortSignal: admission?.abortController.signal });
      if (admission) await settleAdmission(admission, plan.ad.turn_id, result.settlement);
      else await settleEvent(plan.ad.turn_id, result.settlement);
      res.json({
        turn_id: plan.ad.turn_id,
        assistant: result.assistant,
        ad: adPayload,
        ads: adToCliAds(adPayload),
        injection: DEFAULT_INJECTION,
        status: adDisplayStatus(adPayload, plan.runtimeMode),
        settlement: result.settlement,
        usage: result.usage,
      });
      await recordQueuedImpression(plan.ad.turn_id);
    } catch (err) {
      const message = safeProviderError(err, plan.provider);
      console.error('[adrouter/agent] turn failed:', message);
      await markEventRecoveryRequired(plan.ad.turn_id);
      const admission = admissionFrom(res); if (admission) await handleProviderFailure(err, admission);
      res.status(502).json({ error: `Provider API error: ${message}` });
    } finally {
      finalizeResponse();
    }
    return;
  }

  res.status(200);
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');

  const finalizeResponse = abortOnResponseClose(res, plan.ad.turn_id);
  const adQueued = safeWriteNdjson(res, {
    type: 'ad',
    ad: adPayload,
    ads: adToCliAds(adPayload),
    injection: DEFAULT_INJECTION,
    status: adDisplayStatus(adPayload, plan.runtimeMode),
  });
  if (adQueued) await recordQueuedImpression(plan.ad.turn_id);

  try {
    const admission = admissionFrom(res);
    const result = await streamAgentTurn(plan, parsed.data.context.tools, (event) => safeWriteNdjson(res, event), { maxOutputTokens: res.locals.maxOutputTokens as number, abortSignal: admission?.abortController.signal });
    if (admission) await settleAdmission(admission, plan.ad.turn_id, result.settlement);
    else await settleEvent(plan.ad.turn_id, result.settlement);
    for (const toolCall of result.assistant.tool_calls) {
      safeWriteNdjson(res, { type: 'tool_call', tool_call: toolCall });
    }
    safeWriteNdjson(res, { type: 'settlement', turn_id: plan.ad.turn_id, settlement: result.settlement, usage: result.usage });
    safeWriteNdjson(res, { type: 'done', assistant: result.assistant });
  } catch (err) {
    const message = safeProviderError(err, plan.provider);
    console.error('[adrouter/agent] turn failed:', message);
    await markEventRecoveryRequired(plan.ad.turn_id);
    const admission = admissionFrom(res); if (admission) await handleProviderFailure(err, admission);
    safeWriteNdjson(res, { type: 'error', message });
  } finally {
    finalizeResponse();
    res.end();
  }
});
