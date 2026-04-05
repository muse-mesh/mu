import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import type { MuConfig } from '../config.js';
import type { MuLogger } from '../logger.js';
import type { Renderer } from './renderer.js';
import type { AgentCallbacks } from '../agent.js';
import type { CostTracker } from '../cost.js';
import { userMessageEvent, sessionEndEvent } from '../logger.js';

// ── REPL ───────────────────────────────────────────────────────────

export async function runRepl(
  config: MuConfig,
  agent: { generate: (prompt: string, callbacks?: AgentCallbacks) => Promise<any>; costTracker: CostTracker; extractMemories: (sessionId: string) => Promise<void> },
  logger: MuLogger,
  renderer: Renderer,
) {
  renderer.banner(config.model, config.maxSteps, logger.sessionId);

  const rl = createInterface({ input: stdin, output: stdout });
  let totalSteps = 0;
  let totalTokens = 0;
  const sessionStart = performance.now();
  let activeAbort: AbortController | null = null;

  renderer.info('Type your prompt and press Enter. Ctrl+C to stop generation.\n');

  // Handle Ctrl+C: cancel active generation, or exit if idle
  process.on('SIGINT', () => {
    if (activeAbort) {
      activeAbort.abort();
      activeAbort = null;
      renderer.stopThinking();
      renderer.warn('Generation cancelled');
      return;
    }
    // No active generation — exit
    rl.close();
    const totalDurationMs = Math.round(performance.now() - sessionStart);
    logger.log(sessionEndEvent(totalSteps, totalTokens, totalDurationMs));
    const cost = agent.costTracker.getCost();
    if (cost > 0) {
      renderer.info(`Session cost: $${cost.toFixed(4)}`);
    }
    // Extract memories in background (don't block exit)
    agent.extractMemories(logger.sessionId).catch(() => {});
    renderer.done(totalSteps, totalTokens, totalDurationMs, logger.sessionId);
    process.exit(0);
  });

  try {
    while (true) {
      const prompt = await rl.question('\n  You: ');
      if (!prompt.trim()) continue;

      logger.log(userMessageEvent(prompt));

      const abortController = new AbortController();
      activeAbort = abortController;
      let hasText = false;
      const stepStart = performance.now();

      try {
        renderer.thinking();

        const callbacks: AgentCallbacks = {
          signal: abortController.signal,
          onToolCall(stepNumber, toolName, input) {
            renderer.stopThinking();
            renderer.toolCall(toolName, input);
            renderer.thinking('Running');
          },
          onToolResult(stepNumber, toolName, output) {
            renderer.stopThinking();
            const durationMs = Math.round(performance.now() - stepStart);
            renderer.toolResult(toolName, output, durationMs);
          },
          onStepFinish(stepNumber, finishReason, usage) {
            totalSteps++;
            totalTokens += (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
          },
          onText(text) {
            renderer.stopThinking();
            if (!hasText) {
              renderer.modelText(text);
              hasText = true;
            }
          },
        };

        await agent.generate(prompt, callbacks);

        renderer.stopThinking();
      } catch (err: any) {
        renderer.stopThinking();
        if (err.name === 'AbortError') {
          // Already handled by SIGINT handler
        } else {
          renderer.error(err.message);
        }
      } finally {
        activeAbort = null;
      }
    }
  } catch {
    // EOF
  } finally {
    rl.close();
    const totalDurationMs = Math.round(performance.now() - sessionStart);
    logger.log(sessionEndEvent(totalSteps, totalTokens, totalDurationMs));
    const cost = agent.costTracker.getCost();
    if (cost > 0) {
      renderer.info(`Session cost: $${cost.toFixed(4)}`);
    }
    // Extract session memories before exit
    await agent.extractMemories(logger.sessionId).catch(() => {});
    renderer.done(totalSteps, totalTokens, totalDurationMs, logger.sessionId);
  }
}
