import { streamText, stepCountIs, type ToolSet } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import type { MuConfig } from './config.js';
import type { MuLogger } from './logger.js';
import { stepFinishEvent, modelResponseEvent } from './logger.js';
import { createCostTracker, type CostTracker } from './cost.js';
import { withRetry } from './retry.js';
import { setCurrentStep } from './tools/index.js';
import { shouldCompact, compactConversation, resetConversation, type CompactableMessage } from './compaction/index.js';
import { buildMemoryContext, extractSessionMemory, addMemoryEntry, saveMemoryEntries, loadMemoryEntries } from './memory/index.js';

// ── Model Provider ─────────────────────────────────────────────────

function createModel(config: MuConfig) {
  const provider = createOpenAI({
    baseURL: config.apiBaseUrl,
    apiKey: config.apiKey,
  });
  return provider.chat(config.model);
}

// ── Agent Callbacks ────────────────────────────────────────────────

export interface AgentCallbacks {
  signal?: AbortSignal;
  onToolCall?: (stepNumber: number, toolName: string, input: unknown) => void;
  onToolResult?: (stepNumber: number, toolName: string, output: string) => void;
  onStepFinish?: (stepNumber: number, finishReason: string, usage: { inputTokens: number; outputTokens: number }) => void;
  onText?: (fullText: string) => void;
  onStepText?: (stepNumber: number, text: string) => void;
  onTextDelta?: (delta: string) => void;
  onCostUpdate?: (cost: CostTracker) => void;
  onRetry?: (attempt: number, delayMs: number, error: Error) => void;
}

// ── Agent Factory ──────────────────────────────────────────────────

export function createAgent(config: MuConfig, tools: ToolSet, logger: MuLogger) {
  const model = createModel(config);
  const costTracker = createCostTracker(config.model, config.costLimitUsd);

  // Persistent message history for multi-turn conversations
  let conversationHistory: Array<{ role: string; content: string }> = [];

  return {
    costTracker,

    resetHistory() {
      conversationHistory = [];
    },

    async extractMemories(sessionId: string) {
      if (conversationHistory.length < 4) return; // Too short to extract from
      try {
        const entries = await extractSessionMemory(conversationHistory, model, sessionId);
        if (entries.length > 0) {
          const cwd = process.cwd();
          const existing = loadMemoryEntries(cwd);
          saveMemoryEntries(cwd, [...existing, ...entries]);
          logger.info(`Extracted ${entries.length} memory entries from session`);
        }
      } catch (err: any) {
        logger.debug(`Memory extraction failed: ${err.message}`);
      }
    },

    async generate(prompt: string, callbacks?: AgentCallbacks) {
      // ── Phase 1: Pre-processing ────────────────────────────────

      // Memory injection: build context from MEMORY.md + stored entries
      const cwd = process.cwd();
      const memoryContext = buildMemoryContext(cwd, prompt);
      const systemContent = [config.systemPrompt ?? '', memoryContext].filter(Boolean).join('\n\n');

      // Compaction: check if conversation history is getting too long
      if (conversationHistory.length > 0) {
        const allMessages: CompactableMessage[] = [
          { role: 'system', content: systemContent },
          ...conversationHistory as CompactableMessage[],
        ];
        const action = shouldCompact(allMessages, config.model);
        if (action === 'summarize') {
          logger.info('Context nearing limit — compacting conversation…');
          const compacted = await compactConversation(allMessages, model);
          // Replace history with compacted version (drop system, it gets re-added)
          conversationHistory = compacted.filter(m => m.role !== 'system').map(m => ({ role: m.role, content: m.content }));
        } else if (action === 'reset') {
          logger.info('Context at limit — resetting conversation with key facts…');
          const reset = await resetConversation(allMessages, model);
          conversationHistory = reset.filter(m => m.role !== 'system').map(m => ({ role: m.role, content: m.content }));
        }
      }

      // Build messages: system + history + new user message
      const messages: any[] = [
        { role: 'system', content: systemContent },
        ...conversationHistory,
        { role: 'user', content: prompt },
      ];

      const doStream = () => streamText({
        model,
        messages,
        tools,
        temperature: config.temperature,
        abortSignal: callbacks?.signal,
        stopWhen: stepCountIs(config.maxSteps),
        experimental_repairToolCall: async ({ toolCall, error }: any) => {
          logger.debug(`Repairing malformed tool call for ${toolCall.toolName}: ${error.message}`);
          try {
            const fixed = lenientJsonParse((toolCall as any).args);
            return { ...toolCall, args: JSON.stringify(fixed) };
          } catch {
            return null;
          }
        },
      });

      // Wrap in retry for transient API errors
      const result = await withRetry(
        () => Promise.resolve(doStream()),
        undefined,
        (attempt, delayMs, error) => {
          logger.info(`Retry attempt ${attempt} in ${delayMs}ms: ${error.message}`);
          callbacks?.onRetry?.(attempt, delayMs, error);
        },
      );

      let step = 0;
      let stepText = '';
      let fullText = '';

      for await (const part of result.fullStream) {
        switch (part.type) {
          case 'start-step':
            stepText = '';
            setCurrentStep(step);
            break;

          case 'text-delta':
            stepText += part.text;
            fullText += part.text;
            callbacks?.onTextDelta?.(part.text);
            break;

          case 'tool-call':
            callbacks?.onToolCall?.(step, (part as any).toolName, (part as any).input);
            break;

          case 'tool-result':
            {
              const output = typeof (part as any).output === 'string'
                ? (part as any).output
                : JSON.stringify((part as any).output);
              callbacks?.onToolResult?.(step, (part as any).toolName, output);
            }
            break;

          case 'finish-step':
            if (stepText) {
              logger.log(modelResponseEvent(step, stepText));
              callbacks?.onStepText?.(step, stepText);
            }
            {
              const u = part.usage ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
              const inputTkns = u.inputTokens ?? 0;
              const outputTkns = u.outputTokens ?? 0;

              // Track cost
              costTracker.addUsage(inputTkns, outputTkns);
              callbacks?.onCostUpdate?.(costTracker);

              logger.log(stepFinishEvent(step, part.finishReason, {
                inputTokens: inputTkns,
                outputTokens: outputTkns,
                totalTokens: (u as any).totalTokens ?? (inputTkns + outputTkns),
              }));
              callbacks?.onStepFinish?.(step, part.finishReason, {
                inputTokens: inputTkns,
                outputTokens: outputTkns,
              });

              // Check budget after tracking
              if (costTracker.isOverBudget()) {
                logger.info(`Cost limit reached: $${costTracker.getCost().toFixed(4)} >= $${costTracker.limitUsd}`);
              }
              if (costTracker.isNearBudget()) {
                logger.info(`Approaching cost limit: $${costTracker.getCost().toFixed(4)} / $${costTracker.limitUsd}`);
              }
            }
            step++;
            stepText = '';
            break;
        }
      }

      if (fullText) {
        callbacks?.onText?.(fullText);
      }

      // Await final result properties (they're Promises on the StreamTextResult)
      const finalUsage = await result.usage;
      const finalSteps = await result.steps;
      const finalFinishReason = await result.finishReason;

      // Save conversation history for multi-turn
      conversationHistory.push({ role: 'user', content: prompt });
      if (fullText) {
        conversationHistory.push({ role: 'assistant', content: fullText });
      }

      return {
        text: fullText,
        usage: finalUsage,
        steps: finalSteps,
        finishReason: finalFinishReason,
        costTracker,
      };
    },
  };
}

// ── Helper: Lenient JSON Parse ─────────────────────────────────────

function lenientJsonParse(input: string): unknown {
  try {
    return JSON.parse(input);
  } catch {
    const cleaned = input
      .replace(/,\s*([}\]])/g, '$1')
      .replace(/'/g, '"')
      .replace(/(\w+)\s*:/g, '"$1":');
    return JSON.parse(cleaned);
  }
}
