import pino from 'pino';
import { mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { LogEvent, TokenUsage } from './types.js';
import type { MuConfig } from './config.js';

// ── Logger ─────────────────────────────────────────────────────────

export interface MuLogger {
  sessionId: string;
  log(event: LogEvent): void;
  info(msg: string, data?: Record<string, unknown>): void;
  debug(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): pino.Logger;
}

export function createLogger(config: MuConfig): MuLogger {
  const sessionId = randomUUID();

  // pino level mapping
  const pinoLevel = config.logLevel === 'quiet' ? 'silent'
    : config.logLevel === 'normal' ? 'info'
    : config.logLevel === 'debug' ? 'trace'
    : 'debug'; // verbose

  const pinoLogger = pino({
    level: pinoLevel,
    transport: config.outputFormat === 'text'
      ? { target: 'pino/file', options: { destination: 1 } } // stdout
      : undefined,
  });

  // JSONL file writer
  let logFilePath: string | undefined;
  if (config.logToFile) {
    mkdirSync(config.logDir, { recursive: true, mode: 0o700 });
    logFilePath = join(config.logDir, `${sessionId}.jsonl`);
  }

  function writeToFile(event: LogEvent) {
    if (logFilePath) {
      appendFileSync(logFilePath, JSON.stringify(event) + '\n');
    }
  }

  return {
    sessionId,
    log(event: LogEvent) {
      writeToFile(event);
    },
    info(msg: string, data?: Record<string, unknown>) {
      pinoLogger.info(data, msg);
    },
    debug(msg: string, data?: Record<string, unknown>) {
      pinoLogger.debug(data, msg);
    },
    error(msg: string, data?: Record<string, unknown>) {
      pinoLogger.error(data, msg);
    },
    child(bindings: Record<string, unknown>) {
      return pinoLogger.child(bindings);
    },
  };
}

// ── Log Event Helpers ──────────────────────────────────────────────

export function sessionStartEvent(sessionId: string, model: string, maxSteps: number): LogEvent {
  return { type: 'session_start', sessionId, model, maxSteps, timestamp: new Date().toISOString() };
}

export function userMessageEvent(content: string): LogEvent {
  return { type: 'user_message', content, timestamp: new Date().toISOString() };
}

export function stepStartEvent(stepNumber: number): LogEvent {
  return { type: 'step_start', stepNumber, timestamp: new Date().toISOString() };
}

export function toolCallStartEvent(stepNumber: number, toolName: string, toolCallId: string, input: unknown): LogEvent {
  return { type: 'tool_call_start', stepNumber, toolName, toolCallId, input, timestamp: new Date().toISOString() };
}

export function toolCallFinishEvent(stepNumber: number, toolName: string, toolCallId: string, output: unknown, durationMs: number, error?: string): LogEvent {
  return { type: 'tool_call_finish', stepNumber, toolName, toolCallId, output, durationMs, error, timestamp: new Date().toISOString() };
}

export function stepFinishEvent(stepNumber: number, finishReason: string, usage: TokenUsage): LogEvent {
  return { type: 'step_finish', stepNumber, finishReason, usage, timestamp: new Date().toISOString() };
}

export function modelResponseEvent(stepNumber: number, text: string): LogEvent {
  return { type: 'model_response', stepNumber, text, timestamp: new Date().toISOString() };
}

export function sessionEndEvent(totalSteps: number, totalTokens: number, totalDurationMs: number): LogEvent {
  return { type: 'session_end', totalSteps, totalTokens, totalDurationMs, timestamp: new Date().toISOString() };
}
