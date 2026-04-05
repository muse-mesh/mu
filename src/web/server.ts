import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MuConfig } from '../config.js';
import { createLogger, sessionStartEvent, userMessageEvent, stepFinishEvent, modelResponseEvent, sessionEndEvent, type MuLogger } from '../logger.js';
import { setRequestLogger, setCurrentStep } from '../tools/index.js';
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
import { getContextWindow, estimateTokens } from '../context.js';

// ── Context Trimming for Web Chat ──────────────────────────────────
// The useChat hook sends the full message history (including all tool
// call results) on every request. Without trimming, multi-step tool-heavy
// conversations balloon to 900k+ tokens and become unusable.

const TOOL_OUTPUT_SUMMARY_LIMIT = 500; // chars to keep from old tool outputs

function trimMessagesForContext(messages: UIMessage[], model: string): UIMessage[] {
  const contextWindow = getContextWindow(model);
  // Reserve 30% for the new response + system prompt
  const budget = Math.floor(contextWindow * 0.7);

  // Always keep the last 2 messages (current user + prev assistant) untouched
  const keepUntouched = Math.min(2, messages.length);
  const olderMessages = messages.slice(0, messages.length - keepUntouched);
  const recentMessages = messages.slice(-keepUntouched);

  // Trim tool outputs in older messages to reduce tokens
  const trimmedOlder: UIMessage[] = olderMessages.map((msg) => {
    if (msg.role !== 'assistant') return msg;
    const trimmedParts = msg.parts.map((part: any) => {
      if (part.type?.startsWith('tool-') || part.type === 'dynamic-tool') {
        if (part.output && typeof part.output === 'string' && part.output.length > TOOL_OUTPUT_SUMMARY_LIMIT) {
          return { ...part, output: part.output.slice(0, TOOL_OUTPUT_SUMMARY_LIMIT) + '\n…[trimmed]' };
        }
        if (part.output && typeof part.output === 'object') {
          const str = JSON.stringify(part.output);
          if (str.length > TOOL_OUTPUT_SUMMARY_LIMIT) {
            return { ...part, output: str.slice(0, TOOL_OUTPUT_SUMMARY_LIMIT) + '\n…[trimmed]' };
          }
        }
      }
      return part;
    });
    return { ...msg, parts: trimmedParts };
  });

  let result = [...trimmedOlder, ...recentMessages];

  // If still over budget after trimming tool outputs, drop oldest messages
  let totalEstimate = estimateTokens(
    result.map((m) => m.parts.map((p: any) => p.text || p.output || '').join(' ')).join('\n'),
  );

  while (totalEstimate > budget && result.length > keepUntouched + 1) {
    result = result.slice(1); // Drop oldest message
    totalEstimate = estimateTokens(
      result.map((m) => m.parts.map((p: any) => p.text || p.output || '').join(' ')).join('\n'),
    );
  }

  return result;
}

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

    // Per-request audit logger — each web chat turn gets its own JSONL session file
    const reqLogger = createLogger(config);
    setRequestLogger(reqLogger);
    setCurrentStep(0);
    const startTime = Date.now();

    try {

    // Extract user message text for logging
    const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user');
    const userContent = lastUserMsg?.parts
      .filter((p: any) => p.type === 'text')
      .map((p: any) => p.text)
      .join('\n') ?? '';
    reqLogger.log(sessionStartEvent(reqLogger.sessionId, selectedModel, config.maxSteps));
    reqLogger.log(userMessageEvent(userContent));

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
            try {
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
            } catch (err) {
              // Network error mid-stream — propagate so the AI SDK closes the response cleanly
              controller.error(err);
            }
          },
          cancel() {
            reader.cancel().catch(() => {});
          },
        });
        return new Response(stream, { status: res.status, statusText: res.statusText, headers: res.headers });
      },
    });
    const model = provider.chat(selectedModel);

    let usageAcc = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cachedInputTokens: 0 };
    let stepCount = 0;

    let streamError: Error | null = null;
    const result = streamText({
      model,
      system: config.systemPrompt ?? '',
      messages: await convertToModelMessages(trimMessagesForContext(messages, selectedModel)),
      tools,
      temperature: config.temperature,
      stopWhen: stepCountIs(config.maxSteps),
      onStepFinish: ({ response, usage, finishReason, text }) => {
        if (response?.modelId) gatewayInfo.modelId = response.modelId;
        stepCount++;
        setCurrentStep(stepCount);
        reqLogger.log(stepFinishEvent(stepCount, finishReason ?? 'unknown', {
          inputTokens: (usage as any)?.inputTokens ?? 0,
          outputTokens: (usage as any)?.outputTokens ?? 0,
          totalTokens: ((usage as any)?.inputTokens ?? 0) + ((usage as any)?.outputTokens ?? 0),
        }));
        if (text) {
          reqLogger.log(modelResponseEvent(stepCount, text));
        }
      },
      onError: ({ error }) => {
        streamError = error instanceof Error ? error : new Error(String(error));
        reqLogger.error('streamText error', { error: String(error) });
        reqLogger.log(sessionEndEvent(stepCount, 0, Date.now() - startTime));
        setRequestLogger(null);
      },
      onFinish: ({ usage }) => {
        const totalTokens = ((usage as any)?.inputTokens ?? 0) + ((usage as any)?.outputTokens ?? 0);
        reqLogger.log(sessionEndEvent(stepCount, totalTokens, Date.now() - startTime));
        setRequestLogger(null);
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
          // stepCount is already incremented in onStepFinish — don't double-count
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
    } catch (err: any) {
      reqLogger.error('chat handler error', { error: err.message });
      reqLogger.log(sessionEndEvent(0, 0, Date.now() - startTime));
      setRequestLogger(null);
      return c.json({ error: err.message ?? 'Internal server error' }, 500);
    }
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

    const server = serve({ fetch: app.fetch, port }, () => {
      logger.info(`Web UI running at http://localhost:${port}`);
      console.log(`\x1b[36m🌐 mu web UI → http://localhost:${port}\x1b[0m`);
    });

    // Disable timeouts for long-running streaming AI responses.
    // Node.js defaults (headersTimeout=60s, requestTimeout=300s) can drop
    // connections before a slow model finishes generating.
    (server as any).headersTimeout = 0;
    (server as any).requestTimeout = 0;
    (server as any).timeout = 0;
  }

  return { app, start };
}
