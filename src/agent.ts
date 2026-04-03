import { streamText, stepCountIs, type ToolSet } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import type { MuConfig } from './config.js';
import type { MuLogger } from './logger.js';
import { stepFinishEvent, modelResponseEvent } from './logger.js';

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
}

// ── Agent Factory ──────────────────────────────────────────────────

export function createAgent(config: MuConfig, tools: ToolSet, logger: MuLogger) {
  const model = createModel(config);

  return {
    async generate(prompt: string, callbacks?: AgentCallbacks) {
      const result = streamText({
        model,
        messages: [
          { role: 'system', content: config.systemPrompt ?? '' },
          { role: 'user', content: prompt },
        ],
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

      let step = 0;
      let stepText = '';
      let fullText = '';

      for await (const part of result.fullStream) {
        switch (part.type) {
          case 'start-step':
            stepText = '';
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
              logger.log(stepFinishEvent(step, part.finishReason, {
                inputTokens: u.inputTokens ?? 0,
                outputTokens: u.outputTokens ?? 0,
                totalTokens: (u as any).totalTokens ?? ((u.inputTokens ?? 0) + (u.outputTokens ?? 0)),
              }));
              callbacks?.onStepFinish?.(step, part.finishReason, {
                inputTokens: u.inputTokens ?? 0,
                outputTokens: u.outputTokens ?? 0,
              });
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

      return {
        text: fullText,
        usage: finalUsage,
        steps: finalSteps,
        finishReason: finalFinishReason,
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
