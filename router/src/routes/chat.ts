// POST /api/chat — web chat route.
//
// Mock mode keeps the original JSON shape. Live mode streams shared NDJSON
// events: ad first, text deltas, settlement, then the connection closes.

import '../lib/env.js';
import { Router } from 'express';
import { z } from 'zod';
import {
  createMockResponse,
  DEFAULT_ROUTER_MODEL,
  planAgentRouting,
  resolveRuntimeForModel,
  safeProviderError,
  safeWriteNdjson,
  streamChatCompletion,
} from '../lib/agent-routing.js';
import type { ChatMessage, RuntimeMode } from '../lib/types.js';
import { requireWebChatAuth } from '../lib/profile.js';
import { abortOnResponseClose, markEventRecoveryRequired, recordQueuedImpression, settleEvent } from '../lib/persistence.js';
import { listModels } from '../lib/modelRegistry.js';
import { admissionFrom, handleProviderFailure, rejectHostedExecutionControls, releasePreGeneration, requireAdmission, settleAdmission } from '../runtime/admission.js';
import { requireNotDraining } from '../runtime/auth.js';
import { getRuntimeConfig } from '../runtime/config.js';
import { recordFirstToken } from '../runtime/metrics.js';

export const chatRouter = Router();

const ENABLE_DEMO_TIER_OVERRIDE = process.env.ENABLE_DEMO_TIER_OVERRIDE === 'true' || !listModels().some((model) => model.configured);

const BodySchema = z.object({
  messages: z.array(
    z.object({
      role: z.enum(['system', 'user', 'assistant']),
      content: z.string(),
    }),
  ),
  tier_override: z.enum(['A', 'B', 'C', 'NONE']).optional(),
  runtime_mode: z.enum(['auto', 'mock', 'live']).default('auto'),
  model: z.string().default(DEFAULT_ROUTER_MODEL),
  thinking_level: z.enum(['none', 'medium', 'high']).optional(),
  reasoning_effort: z.enum(['low', 'medium', 'high']).optional(),
  ads_enabled: z.boolean().optional(),
  max_output_tokens: z.number().int().positive().optional(),
});

chatRouter.post('/chat', requireWebChatAuth, requireNotDraining, rejectHostedExecutionControls, requireAdmission, async (req, res) => {
  const parsed = BodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid body', details: parsed.error.flatten() });
    await releasePreGeneration(res); return;
  }

  const requestedRuntimeMode = parsed.data.runtime_mode;
  let runtimeMode: RuntimeMode;
  try {
    const runtime = resolveRuntimeForModel(parsed.data.model, getRuntimeConfig().hosted ? 'live' : requestedRuntimeMode);
    runtimeMode = runtime.runtimeMode;
    if (runtimeMode === 'live' && !runtime.configured) {
      res.status(409).json({ error: `Live API mode is not configured for ${runtime.provider}.` });
      await releasePreGeneration(res); return;
    }
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error), code: 'invalid_model' });
    await releasePreGeneration(res); return;
  }

  const tierOverride = parsed.data.tier_override;
  if (tierOverride && !ENABLE_DEMO_TIER_OVERRIDE) {
    res.status(403).json({ error: 'tier_override is disabled for this environment.' });
    await releasePreGeneration(res); return;
  }

  try {
    const plan = await planAgentRouting({
      messages: parsed.data.messages as ChatMessage[],
      model: parsed.data.model,
      thinkingLevel: parsed.data.thinking_level,
      legacyReasoningEffort: parsed.data.reasoning_effort,
      runtimeMode,
      adsEnabled: parsed.data.ads_enabled,
      client: 'webui',
      tierOverride: tierOverride && (tierOverride === 'NONE' || ENABLE_DEMO_TIER_OVERRIDE) ? tierOverride : undefined,
      reservationId: admissionFrom(res)?.reservationId,
    });

    if (plan.runtimeMode === 'mock') {
      const mock = createMockResponse(plan, res.locals.maxOutputTokens as number);
      const admission = admissionFrom(res);
      if (admission) await settleAdmission(admission, plan.ad.turn_id, mock.settlement);
      else await settleEvent(plan.ad.turn_id, mock.settlement);
      res.json({ mode: 'mock', ad: mock.ad, text: mock.text, settlement: mock.settlement });
      return;
    }

    res.status(200);
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    const finalizeResponse = abortOnResponseClose(res, plan.ad.turn_id);
    if (safeWriteNdjson(res, { type: 'ad', ad: plan.ad })) {
      await recordQueuedImpression(plan.ad.turn_id);
    }

    const admission = admissionFrom(res);
    const streamStarted = process.hrtime.bigint();
    let firstTokenRecorded = false;
    try {
      const settlement = await streamChatCompletion(plan, (event) => {
        if (!firstTokenRecorded && event && typeof event === 'object' && (event as { type?: string }).type === 'text') {
          firstTokenRecorded = true;
          recordFirstToken(plan.model, streamStarted, 'success');
        }
        safeWriteNdjson(res, event);
      }, { maxOutputTokens: res.locals.maxOutputTokens as number, abortSignal: admission?.abortController.signal });
      if (admission) await settleAdmission(admission, plan.ad.turn_id, settlement);
      else await settleEvent(plan.ad.turn_id, settlement);
      safeWriteNdjson(res, { type: 'settlement', turn_id: plan.ad.turn_id, settlement });
    } catch (err) {
      if (!firstTokenRecorded) recordFirstToken(plan.model, streamStarted, 'error');
      const message = safeProviderError(err, plan.provider);
      console.warn('[adrouter] live stream failed:', message);
      await markEventRecoveryRequired(plan.ad.turn_id);
      if (admission) await handleProviderFailure(err, admission);
      safeWriteNdjson(res, { type: 'error', message });
    } finally {
      finalizeResponse();
      res.end();
    }
  } catch (err) {
    await releasePreGeneration(res);
    const message = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: message, ...(message.startsWith('unsupported_thinking_level:') ? { code: 'unsupported_thinking_level' } : {}) });
  }
});
