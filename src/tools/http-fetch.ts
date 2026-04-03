import { z } from 'zod';
import { buildTool } from './build-tool.js';

const InputSchema = z.object({
  url: z.string().url().describe('URL to fetch'),
  method: z.enum(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']).optional().describe('HTTP method (default: GET)'),
  headers: z.record(z.string(), z.string()).optional().describe('Request headers'),
  body: z.string().optional().describe('Request body (for POST/PUT/PATCH)'),
  maxBodySize: z.number().int().optional().describe('Max response body size in bytes (default: 1MB)'),
});

export const httpFetch = buildTool({
  name: 'http_fetch',
  description: 'Fetch a URL and return its status, headers, and body. Follows redirects (max 5).',
  inputSchema: InputSchema,
  isReadOnly: false, // POST/PUT/DELETE are not read-only
  isDestructive: false,
  isOpenWorld: true,
  timeoutMs: 30_000,
  categories: ['network'],

  async execute(input: z.infer<typeof InputSchema>) {
    const start = performance.now();
    const method = input.method ?? 'GET';
    const maxBodySize = input.maxBodySize ?? 1024 * 1024; // 1MB

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30_000);

      const response = await fetch(input.url, {
        method,
        headers: input.headers as Record<string, string> | undefined,
        body: input.body,
        signal: controller.signal,
        redirect: 'follow',
      });

      clearTimeout(timer);

      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });

      let body: string;
      const contentLength = Number(response.headers.get('content-length') || 0);
      if (contentLength > maxBodySize) {
        body = `[Response too large: ${contentLength} bytes, limit: ${maxBodySize}]`;
      } else {
        const rawBody = await response.text();
        body = rawBody.length > maxBodySize
          ? rawBody.slice(0, maxBodySize) + `\n...[truncated at ${maxBodySize} bytes]`
          : rawBody;
      }

      return {
        output: {
          status: response.status,
          statusText: response.statusText,
          headers: responseHeaders,
          body,
          url: response.url,
        },
        durationMs: Math.round(performance.now() - start),
      };
    } catch (err: any) {
      return {
        output: null,
        error: err.name === 'AbortError' ? 'Request timed out' : err.message,
        durationMs: Math.round(performance.now() - start),
      };
    }
  },
});
