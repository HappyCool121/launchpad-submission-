const forbiddenKeys = /prompt|response|message|content|tool|source|access.?token|refresh.?token|id.?token|bearer|credential|api.?key|authorization|database.?url/i;

function sanitize(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).filter(([key, value]) =>
    !forbiddenKeys.test(key) && ['string', 'number', 'boolean'].includes(typeof value),
  ));
}

export function logEvent(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), service: 'adrouter', event, ...sanitize(fields) }));
}

export function logError(event: string, error: unknown, fields: Record<string, unknown> = {}): void {
  const errorType = error instanceof Error ? error.name : 'UnknownError';
  const status = error && typeof error === 'object' && 'status' in error ? Number((error as { status?: unknown }).status) : undefined;
  logEvent(event, { ...fields, error_type: errorType, ...(Number.isFinite(status) ? { provider_status: status } : {}) });
}

export function logMetric(namespace: string, metrics: Record<string, number>, dimensions: Record<string, string> = {}): void {
  const safeMetrics = Object.fromEntries(Object.entries(metrics).filter(([key, value]) => !forbiddenKeys.test(key) && Number.isFinite(value)));
  const safeDimensions = sanitize(dimensions) as Record<string, string>;
  console.log(JSON.stringify({
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [{ Namespace: namespace, Dimensions: [Object.keys(safeDimensions)], Metrics: Object.keys(safeMetrics).map((Name) => ({ Name })) }],
    },
    ...safeDimensions,
    ...safeMetrics,
  }));
}
