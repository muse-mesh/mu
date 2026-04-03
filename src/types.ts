import type { z } from 'zod';
import type { MuConfig } from './config.js';
import type { MuLogger } from './logger.js';

// ── Tool System Types ──────────────────────────────────────────────

export interface ToolContext {
  sessionId: string;
  stepNumber: number;
  toolCallId: string;
  config: MuConfig;
  logger: MuLogger;
  abortSignal: AbortSignal;
}

export interface ToolResult {
  output: unknown;
  error?: string;
  durationMs?: number;
}

export interface MuToolDef {
  name: string;
  description: string;
  inputSchema: z.ZodType;

  // Behavioral flags
  isReadOnly: boolean;
  isDestructive: boolean;
  isOpenWorld: boolean;
  isBackground: boolean;
  requiresApproval: boolean;

  // Execution
  execute: (input: any, ctx: ToolContext) => Promise<ToolResult>;

  // Timeouts & limits
  timeoutMs: number;
  maxOutputLength?: number;
  categories?: string[];

  // Lifecycle hooks
  onBefore?: (input: any, ctx: ToolContext) => Promise<void>;
  onAfter?: (input: any, output: ToolResult, ctx: ToolContext) => Promise<void>;
}

// ── Token & Usage Types ────────────────────────────────────────────

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

// ── Log Event Types ────────────────────────────────────────────────

export type LogEvent =
  | { type: 'session_start'; sessionId: string; model: string; maxSteps: number; timestamp: string }
  | { type: 'user_message'; content: string; timestamp: string }
  | { type: 'step_start'; stepNumber: number; timestamp: string }
  | { type: 'tool_call_start'; stepNumber: number; toolName: string; toolCallId: string; input: unknown; timestamp: string }
  | { type: 'tool_call_finish'; stepNumber: number; toolName: string; toolCallId: string; output: unknown; durationMs: number; error?: string; timestamp: string }
  | { type: 'step_finish'; stepNumber: number; finishReason: string; usage: TokenUsage; timestamp: string }
  | { type: 'model_response'; stepNumber: number; text: string; timestamp: string }
  | { type: 'session_end'; totalSteps: number; totalTokens: number; totalDurationMs: number; timestamp: string };

// ── Session State ──────────────────────────────────────────────────

export interface SessionState {
  sessionId: string;
  status: 'idle' | 'running' | 'completed' | 'error' | 'aborted';
  currentStep: number;
  totalTokens: { input: number; output: number };
  startTime: number;
}
