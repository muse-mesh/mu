import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MuConfig } from '../config.js';
import type { MuLogger } from '../logger.js';
import { streamText, stepCountIs, convertToModelMessages, type ToolSet, type UIMessage } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import {
  createSession,
  getSession,
  listSessions,
  deleteSession,
  updateSession,
  type WebSession,
} from './sessions.js';
import { fetchModels, getCachedModels } from '../models.js';

// ── Create Web Server ──────────────────────────────────────────────

export function createWebServer(config: MuConfig, tools: ToolSet, logger: MuLogger) {
  const app = new Hono();

  app.use('*', cors());

  // ── REST API ───────────────────────────────────────────────────

  // Create a new session
  app.post('/api/sessions', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const model = body.model ?? config.model;
    const maxSteps = body.maxSteps ?? config.maxSteps;
    const session = createSession(model, maxSteps);
    return c.json({ sessionId: session.sessionId, status: session.status });
  });

  // List all sessions
  app.get('/api/sessions', (c) => {
    return c.json(listSessions());
  });

  // Get session details
  app.get('/api/sessions/:id', (c) => {
    const session = getSession(c.req.param('id'));
    if (!session) return c.json({ error: 'Session not found' }, 404);
    return c.json(session);
  });

  // Delete session
  app.delete('/api/sessions/:id', (c) => {
    const deleted = deleteSession(c.req.param('id'));
    return c.json({ deleted });
  });

  // Get config (redacted)
  app.get('/api/config', (c) => {
    return c.json({
      model: config.model,
      maxSteps: config.maxSteps,
      permissionMode: config.permissionMode,
      temperature: config.temperature,
    });
  });

  // Health check
  app.get('/api/health', (c) => {
    return c.json({
      status: 'ok',
      uptime: process.uptime(),
      model: config.model,
    });
  });

  // ── Shared gateway info (updated per-request) ────────────────────

  let gatewayInfo = { rateLimitLimit: 0, rateLimitRemaining: 0, modelId: '' };

  app.get('/api/gateway', (c) => c.json(gatewayInfo));

  // ── Models from OpenRouter ──────────────────────────────────────

  app.get('/api/models', (c) => c.json(getCachedModels()));

  // ── AI SDK UI Streaming Chat ────────────────────────────────────

  app.post('/api/chat', async (c) => {
    const body = await c.req.json();
    const messages: UIMessage[] = body.messages;
    const selectedModel: string = body.model ?? config.model;

    // Intercept fetch to capture cost & rate-limit headers from gateway
    let capturedCost = { cost: 0, costDetails: {} as Record<string, number> };

    const provider = createOpenAI({
      baseURL: config.apiBaseUrl,
      apiKey: config.apiKey,
      fetch: async (url, options) => {
        const res = await globalThis.fetch(url as any, options as any);

        // Capture rate-limit headers
        gatewayInfo.rateLimitLimit = Number(res.headers.get('x-ratelimit-limit') ?? 0);
        gatewayInfo.rateLimitRemaining = Number(res.headers.get('x-ratelimit-remaining') ?? 0);

        if (!res.body) return res;
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let sseBuffer = '';
        const stream = new ReadableStream({
          async pull(controller) {
            const { done, value } = await reader.read();
            if (done) { controller.close(); return; }
            const text = decoder.decode(value, { stream: true });
            sseBuffer += text;
            const lines = sseBuffer.split('\n');
            sseBuffer = lines.pop() || ''; // keep incomplete last line
            for (const line of lines) {
              if (line.startsWith('data: ') && line.includes('"cost"')) {
                try {
                  const data = JSON.parse(line.slice(6));
                  if (data.usage?.cost != null) {
                    capturedCost.cost += data.usage.cost;
                    if (data.usage.cost_details) {
                      for (const [k, v] of Object.entries(data.usage.cost_details)) {
                        capturedCost.costDetails[k] = (capturedCost.costDetails[k] ?? 0) + (v as number);
                      }
                    }
                  }
                } catch {}
              }
            }
            controller.enqueue(value);
          },
        });
        return new Response(stream, { status: res.status, statusText: res.statusText, headers: res.headers });
      },
    });
    const model = provider.chat(selectedModel);

    const startTime = Date.now();
    let usageAcc = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cachedInputTokens: 0 };
    let stepCount = 0;

    const result = streamText({
      model,
      system: config.systemPrompt ?? '',
      messages: await convertToModelMessages(messages),
      tools,
      temperature: config.temperature,
      stopWhen: stepCountIs(config.maxSteps),
      onStepFinish: ({ response }) => {
        if (response?.modelId) gatewayInfo.modelId = response.modelId;
      },
    });

    return result.toUIMessageStreamResponse({
      messageMetadata: ({ part }) => {
        if (part.type === 'finish-step') {
          const u = part.usage as any;
          usageAcc.inputTokens += u.inputTokens ?? 0;
          usageAcc.outputTokens += u.outputTokens ?? 0;
          usageAcc.reasoningTokens += u.reasoningTokens ?? 0;
          usageAcc.cachedInputTokens += u.cachedInputTokens ?? 0;
          stepCount++;
        }
        if (part.type === 'finish') {
          return {
            usage: {
              inputTokens: usageAcc.inputTokens,
              outputTokens: usageAcc.outputTokens,
              totalTokens: usageAcc.inputTokens + usageAcc.outputTokens,
              reasoningTokens: usageAcc.reasoningTokens,
              cachedInputTokens: usageAcc.cachedInputTokens,
            },
            cost: capturedCost.cost,
            latencyMs: Date.now() - startTime,
            steps: stepCount,
          };
        }
        return undefined;
      },
    });
  });

  // Save UI messages for session persistence
  app.put('/api/sessions/:id/save', async (c) => {
    const sessionId = c.req.param('id');
    const session = getSession(sessionId);
    if (!session) return c.json({ error: 'Session not found' }, 404);
    const { messages } = await c.req.json();
    updateSession(sessionId, (s) => {
      (s as any).uiMessages = messages;
      s.status = 'completed';
    });
    return c.json({ saved: true });
  });

  // ── Static File Serving (bundled mode) ─────────────────────────
  // Resolve relative to the app's install directory, not cwd (which may be /)
  const appDir = join(dirname(fileURLToPath(import.meta.url)), '..');
  const webDistPath = join(appDir, 'web', 'dist');
  if (existsSync(webDistPath)) {
    app.use('/*', serveStatic({ root: join(appDir, 'web', 'dist') }));
    app.get('*', serveStatic({ root: join(appDir, 'web', 'dist'), path: 'index.html' }));
  }

  // ── Start Server ───────────────────────────────────────────────

  function start() {
    const port = config.webUiPort;

    // Fetch models from OpenRouter on startup (non-blocking)
    fetchModels()
      .then((models) => logger.info(`Loaded ${models.length} models from OpenRouter`))
      .catch((err) => logger.info(`Failed to fetch OpenRouter models: ${err.message}`));

    serve({ fetch: app.fetch, port }, () => {
      logger.info(`Web UI running at http://localhost:${port}`);
      console.log(`\x1b[36m🌐 mu web UI → http://localhost:${port}\x1b[0m`);
    });
  }

  return { app, start };
}
