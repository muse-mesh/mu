import { tool, type ToolSet } from 'ai';
import type { MuToolDef, ToolContext } from '../types.js';
import type { MuLogger } from '../logger.js';
import type { MuConfig } from '../config.js';
import { toolCallStartEvent, toolCallFinishEvent } from '../logger.js';
import { checkPermission, PermissionDeniedError } from '../permissions/index.js';

// ── Built-in tool imports ──────────────────────────────────────────

import { shellExec } from './shell-exec.js';
import { shellExecBg } from './shell-exec-bg.js';
import { fileRead } from './file-read.js';
import { fileWrite } from './file-write.js';
import { fileEdit } from './file-edit.js';
import { multiFileEdit } from './multi-file-edit.js';
import { globTool } from './glob.js';
import { grepTool } from './grep.js';
import { codeSearch } from './code-search.js';
import { listDir } from './list-dir.js';
import { httpFetch } from './http-fetch.js';
import { systemInfo } from './system-info.js';
import { think } from './think.js';
import { taskComplete } from './task-complete.js';

// ── Tool Registry ──────────────────────────────────────────────────

const TOOL_REGISTRY: Map<string, MuToolDef> = new Map();

function registerTool(def: MuToolDef) {
  TOOL_REGISTRY.set(def.name, def);
}

// Register all built-in tools
const builtinTools: MuToolDef[] = [
  shellExec,
  shellExecBg,
  fileRead,
  fileWrite,
  fileEdit,
  multiFileEdit,
  globTool,
  grepTool,
  codeSearch,
  listDir,
  httpFetch,
  systemInfo,
  think,
  taskComplete,
];

for (const t of builtinTools) {
  registerTool(t);
}

// ── Step Counter ───────────────────────────────────────────────────

let currentStep = 0;

export function setCurrentStep(step: number) { currentStep = step; }

// ── Per-request logger override ────────────────────────────────────
// Web requests use this to inject a per-session logger so tool audit
// events go to the right JSONL file instead of the app-level logger.

let _requestLogger: MuLogger | null = null;

export function setRequestLogger(logger: MuLogger | null) { _requestLogger = logger; }
export function getRequestLogger(): MuLogger | null { return _requestLogger; }

// ── 12-Step Execution Pipeline ─────────────────────────────────────
// 1. Parse & validate input (Zod)
// 2. Check tool enabled
// 3. Permission check
// 4. onBefore hook
// 5. Start timer
// 6. Execute with AbortSignal + timeout
// 7. Capture output + error
// 8. Truncate output
// 9. onAfter hook
// 10. Log to JSONL audit
// 11. Return to agent

function wrapTool(def: MuToolDef, config: MuConfig, logger: MuLogger) {
  const maxOutputLength = def.maxOutputLength ?? config.maxOutputLength;

  return tool({
    description: def.description,
    inputSchema: def.inputSchema as any,
    execute: async (input: any, { toolCallId }: any) => {
      const stepNumber = currentStep;
      const startTs = performance.now();
      const activeLogger = _requestLogger ?? logger;

      activeLogger.log(toolCallStartEvent(stepNumber, def.name, toolCallId, input));

      try {
        // Step 3: Permission check
        await checkPermission(def, config.permissionMode as any, input);

        // Step 4: onBefore hook
        const ctx: ToolContext = {
          sessionId: activeLogger.sessionId,
          stepNumber,
          toolCallId,
          config,
          logger: activeLogger,
          abortSignal: new AbortController().signal,
        };
        if (def.onBefore) await def.onBefore(input, ctx);

        // Step 5-6: Timeout wrapper + execute
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), def.timeoutMs);
        ctx.abortSignal = controller.signal;

        const result = await def.execute(input, ctx);
        clearTimeout(timer);

        const durationMs = Math.round(performance.now() - startTs);

        // Step 8: Truncate large outputs
        let output = result.output;
        if (typeof output === 'string' && output.length > maxOutputLength) {
          output = output.slice(0, maxOutputLength) + `\n...[truncated at ${maxOutputLength} chars]`;
        } else if (typeof output === 'object' && output !== null) {
          const serialized = JSON.stringify(output);
          if (serialized.length > maxOutputLength) {
            output = serialized.slice(0, maxOutputLength) + `\n...[truncated at ${maxOutputLength} chars]`;
          }
        }

        // Step 9: onAfter hook
        if (def.onAfter) await def.onAfter(input, { ...result, output }, ctx);

        // Step 10: Log
        activeLogger.log(toolCallFinishEvent(stepNumber, def.name, toolCallId, output, durationMs, result.error));

        // Step 11: Return
        if (result.error) {
          return JSON.stringify({ error: result.error, output });
        }
        return typeof output === 'string' ? output : JSON.stringify(output);
      } catch (err: any) {
        const durationMs = Math.round(performance.now() - startTs);
        let errorMsg: string;
        if (err instanceof PermissionDeniedError) {
          errorMsg = err.message;
        } else if (err.name === 'AbortError') {
          errorMsg = `Tool timed out after ${def.timeoutMs}ms`;
        } else {
          errorMsg = err.message;
        }
        activeLogger.log(toolCallFinishEvent(stepNumber, def.name, toolCallId, null, durationMs, errorMsg));
        return JSON.stringify({ error: errorMsg });
      }
    },
  } as any);
}

// ── Create Tool Set ────────────────────────────────────────────────

export function createToolSet(config: MuConfig, logger: MuLogger): ToolSet {
  const toolSet: ToolSet = {};

  const enabledDefs = config.enabledTools === 'all'
    ? [...TOOL_REGISTRY.values()]
    : [...TOOL_REGISTRY.values()].filter(t =>
        (config.enabledTools as string[]).includes(t.name)
      );

  for (const def of enabledDefs) {
    toolSet[def.name] = wrapTool(def, config, logger);
  }

  return toolSet;
}

export function addExternalTools(tools: Record<string, any>, toolSet: ToolSet) {
  Object.assign(toolSet, tools);
}
