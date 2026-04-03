// ── Retry with Exponential Backoff ─────────────────────────────────

export interface RetryConfig {
  maxRetries: number;
  initialDelayMs: number;
  maxDelayMs: number;
  retryableStatusCodes: number[];
}

export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  initialDelayMs: 1000,
  maxDelayMs: 30_000,
  retryableStatusCodes: [429, 500, 502, 503, 504],
};

function isRetryable(error: unknown, config: RetryConfig): boolean {
  if (error instanceof Error) {
    // Network errors
    if (error.message.includes('ECONNRESET')) return true;
    if (error.message.includes('ETIMEDOUT')) return true;
    if (error.message.includes('ECONNREFUSED')) return true;
    if (error.message.includes('fetch failed')) return true;

    // API errors with status code
    const statusMatch = error.message.match(/(\d{3})/);
    if (statusMatch) {
      const status = Number(statusMatch[1]);
      return config.retryableStatusCodes.includes(status);
    }
  }
  return false;
}

function getRetryAfter(error: unknown): number | null {
  if (error instanceof Error && 'headers' in error) {
    const headers = (error as any).headers;
    const retryAfter = headers?.get?.('retry-after') ?? headers?.['retry-after'];
    if (retryAfter) {
      const secs = Number(retryAfter);
      if (!isNaN(secs)) return secs * 1000;
    }
  }
  return null;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  config: RetryConfig = DEFAULT_RETRY_CONFIG,
  onRetry?: (attempt: number, delayMs: number, error: Error) => void,
): Promise<T> {
  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt === config.maxRetries || !isRetryable(error, config)) {
        throw error;
      }

      const retryAfterMs = getRetryAfter(error);
      const backoffMs = Math.min(
        config.initialDelayMs * Math.pow(2, attempt) + Math.random() * 1000,
        config.maxDelayMs,
      );
      const delayMs = retryAfterMs ?? backoffMs;

      onRetry?.(attempt + 1, delayMs, error as Error);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw new Error('Unreachable');
}


