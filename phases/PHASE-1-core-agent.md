# Phase 1 — Core Agent

**Goal:** Bootstrap the project and get a working agent that can accept a prompt, call tools in a loop, and produce verbose auditable output.

**Depends on:** Nothing — this is the foundation.
**Blocks:** All other phases.

---

## Deliverables

| # | Deliverable | Description |
|---|-------------|-------------|
| 1.1 | Project scaffolding | `package.json`, `tsconfig.json`, directory structure, ESM config |
| 1.2 | Config system | Zod-validated config from CLI flags → env vars → config file → defaults |
| 1.3 | Structured logger | pino-based logger writing structured JSON to stdout + JSONL files |
| 1.4 | Reactive state store | Minimal `createStore()` (~35 lines, from reference `04-state-management.md`) |
| 1.5 | Agent core | `ToolLoopAgent` setup with `stopWhen`, `onStepFinish`, lifecycle hooks |
| 1.6 | Bootstrap tools | `shell_exec`, `file_read`, `file_write` — enough to prove the loop works |
| 1.7 | CLI — headless mode | `mu "prompt"` → execute → exit |
| 1.8 | CLI — REPL mode | `mu` → interactive multi-turn conversation |
| 1.9 | Terminal renderer | Verbose output with step numbers, tool calls, timing, token usage |
| 1.10 | JSONL audit logging | Append-only `.jsonl` files in `~/.mu/logs/` |

---

## 1.1 Project Scaffolding

```bash
mkdir -p src/{tools,cli,web/public,permissions,compaction,memory,mcp}
pnpm init
pnpm add ai @ai-sdk/openai @ai-sdk/mcp @modelcontextprotocol/sdk zod hono pino dotenv commander
pnpm add -D typescript tsx tsup @types/node
```

**`tsconfig.json`:**
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true
  },
  "include": ["src"]
}
```

**`package.json` scripts:**
```json
{
  "type": "module",
  "scripts": {
    "dev": "tsx src/index.ts",
    "build": "tsup src/index.ts --format esm --dts",
    "start": "node dist/index.js"
  },
  "bin": {
    "mu": "dist/index.js"
  }
}
```

---

## 1.2 Config System

**File: `src/config.ts`**

Precedence: CLI flags > env vars > config file > defaults.

```typescript
import { z } from 'zod';

const ConfigSchema = z.object({
  apiBaseUrl: z.string().url().default('https://api.openai.com/v1'),
  apiKey: z.string().min(1),
  model: z.string().default('gpt-4o'),
  maxSteps: z.number().int().min(1).max(500).default(50),
  loopMode: z.enum(['agent', 'manual']).default('agent'),
  temperature: z.number().min(0).max(2).default(0),
  logLevel: z.enum(['quiet', 'normal', 'verbose', 'debug']).default('verbose'),
  logDir: z.string().default('~/.mu/logs'),
  logToFile: z.boolean().default(true),
  outputFormat: z.enum(['text', 'json', 'ndjson']).default('text'),
  enabledTools: z.union([z.array(z.string()), z.literal('all')]).default('all'),
  permissionMode: z.enum(['default', 'auto', 'plan', 'approve-destructive']).default('auto'),
  webUiEnabled: z.boolean().default(false),
  webUiPort: z.number().int().default(3141),
  maxOutputLength: z.number().int().default(50000),
  costLimitUsd: z.number().default(0),
  systemPrompt: z.string().optional(),
  systemPromptFile: z.string().optional(),
});

export type MuConfig = z.infer<typeof ConfigSchema>;
```

Config loading:
1. Parse CLI flags with Commander
2. Read env vars (`MU_BOT_*` prefix)
3. Look for `mu.config.ts` / `.mu.json` in cwd then home
4. Merge and validate with Zod

---

## 1.3 Structured Logger

**File: `src/logger.ts`**

Uses pino for structured JSON logging. Writes two streams:
- **stdout** — Human-readable formatted output (configured by log level)
- **File** — Raw JSON to `~/.mu/logs/{sessionId}.jsonl`

Log event types (from PRD §7.2):
```typescript
type LogEvent =
  | { type: 'session_start'; sessionId: string; model: string; maxSteps: number; timestamp: string }
  | { type: 'user_message'; content: string; timestamp: string }
  | { type: 'step_start'; stepNumber: number; timestamp: string }
  | { type: 'tool_call_start'; stepNumber: number; toolName: string; toolCallId: string; input: unknown; timestamp: string }
  | { type: 'tool_call_finish'; stepNumber: number; toolName: string; toolCallId: string; output: unknown; durationMs: number; error?: string; timestamp: string }
  | { type: 'step_finish'; stepNumber: number; finishReason: string; usage: TokenUsage; timestamp: string }
  | { type: 'model_response'; stepNumber: number; text: string; timestamp: string }
  | { type: 'session_end'; totalSteps: number; totalTokens: number; totalDurationMs: number; timestamp: string };
```

---

## 1.4 Reactive State Store

**File: `src/state.ts`**

Minimal reactive store from reference `04-state-management.md` (~35 lines):

```typescript
export function createStore<T>(initialState: T, onChange?: (state: T) => void) {
  let state = initialState;
  const listeners = new Set<(state: T) => void>();

  return {
    getState: () => state,
    setState: (updater: T | ((prev: T) => T)) => {
      const next = typeof updater === 'function' ? (updater as (prev: T) => T)(state) : updater;
      if (Object.is(state, next)) return;
      state = next;
      onChange?.(state);
      listeners.forEach(fn => fn(state));
    },
    subscribe: (fn: (state: T) => void) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
```

Session state shape:
```typescript
interface SessionState {
  sessionId: string;
  status: 'idle' | 'running' | 'completed' | 'error' | 'aborted';
  currentStep: number;
  totalTokens: { input: number; output: number };
  startTime: number;
  messages: ModelMessage[];
}
```

---

## 1.5 Agent Core

**File: `src/agent.ts`**

Two modes (config-selectable):

**Mode A — ToolLoopAgent (default):**
```typescript
import { ToolLoopAgent, stepCountIs } from 'ai';

export function createAgent(config: MuConfig, tools: ToolSet, logger: Logger) {
  return new ToolLoopAgent({
    model: createModel(config),
    instructions: config.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
    tools,
    stopWhen: [
      stepCountIs(config.maxSteps),
      // cost limit condition (if configured)
    ],
    onStepFinish: async ({ stepNumber, usage, finishReason, toolCalls, toolResults }) => {
      logger.logStepFinish({ stepNumber, usage, finishReason, toolCalls, toolResults });
    },
    // Note: experimental_onToolCallStart/Finish are generateText params, not
    // ToolLoopAgent constructor params. Per-tool logging is handled by our
    // buildTool() wrapper instead (see Phase 2).
  });
}
```

**Mode B — Manual loop (escape hatch):**
Available via `--loop-mode manual`. Uses `generateText` in a while loop with manual message accumulation (see PRD §5.4).

---

## 1.6 Bootstrap Tools

Three tools to prove the loop works:

### `shell_exec`
- Runs a shell command via `child_process.execFile` (not `exec` — avoids shell injection)
- Actually uses `/bin/bash -c` for complex commands (like the reference Bash tool)
- Captures stdout + stderr, respects timeout
- Returns `{ stdout, stderr, exitCode, durationMs }`

### `file_read`
- Reads file contents by path
- Supports line range (`startLine`, `endLine`)
- Returns `{ content, totalLines, path }`

### `file_write`
- Writes content to a file path
- Creates parent directories if needed
- Returns `{ path, bytesWritten }`

All three include `isReadOnly` / `isDestructive` flags and Zod input schemas.

---

## 1.7–1.8 CLI Interface

**File: `src/index.ts`**

```typescript
import { Command } from 'commander';

const program = new Command()
  .name('mu')
  .description('AI agent with full local machine access')
  .argument('[prompt]', 'Prompt to send to the agent')
  .option('-m, --model <model>', 'Model identifier', 'gpt-4o')
  .option('-b, --base-url <url>', 'API base URL')
  .option('-s, --max-steps <n>', 'Max tool loop steps', '50')
  .option('-v, --verbose', 'Verbose output')
  .option('-d, --debug', 'Debug output')
  .option('-w, --web', 'Enable web UI')
  .option('-p, --port <port>', 'Web UI port', '3141')
  .option('--permission <mode>', 'Permission mode')
  .option('--output <format>', 'Output format: text|json|ndjson')
  .option('-c, --config <path>', 'Config file path')
  .action(async (prompt, options) => {
    if (prompt) {
      await runHeadless(prompt, options);
    } else {
      await runRepl(options);
    }
  });
```

### Headless mode (`mu "prompt"`)
1. Parse config
2. Create agent
3. Call `agent.generate({ prompt })`
4. Stream steps to renderer
5. Print final result
6. Exit with code 0 (success) or 1 (error)

### REPL mode (`mu`)
1. Parse config
2. Print banner (model, max steps, session ID)
3. Loop: readline prompt → agent.generate → render → repeat
4. Ctrl+C to exit

---

## 1.9 Terminal Renderer

**File: `src/cli/renderer.ts`**

Formats agent output based on log level:

- **verbose (default):** Full step display with tool call inputs/outputs, timing, tokens (see PRD §7.1)
- **normal:** Step summaries only
- **quiet:** Final text output only
- **debug:** Everything + raw API payloads

Uses ANSI escape codes for colors (no dependency):
- `🔧` tool calls in cyan
- `🤖` model responses in green
- `⏱` timing in dim
- `❌` errors in red
- Box-drawing chars for session banner

---

## 1.10 JSONL Audit Logging

Every session creates `~/.mu/logs/{sessionId}.jsonl`.

One JSON object per line, strictly ordered, append-only. Log directory created on first run with `0700` permissions. Session ID is `crypto.randomUUID()`.

Files are never modified after creation — this makes the audit trail tamper-evident via sequential ordering and timestamps.

---

## Acceptance Criteria

| Test | Expected |
|------|----------|
| `mu "echo hello"` | Agent calls shell_exec, prints output, exits 0 |
| `mu "read /etc/hostname"` | Agent calls file_read, displays content |
| `mu "create /tmp/test.txt with content 'hello world'"` | Agent calls file_write, confirms creation |
| `mu --max-steps 2 "keep running ls"` | Agent stops after 2 steps, prints max-steps warning |
| `mu` (no prompt) | Enters REPL, accepts multiple prompts |
| `~/.mu/logs/*.jsonl` | Contains structured log events for above sessions |
| `mu --output ndjson "echo hi"` | Outputs NDJSON to stdout (parseable by `jq`) |

---

## Estimated File Count

| Directory | Files | Purpose |
|-----------|-------|---------|
| `src/` | 4 | index.ts, agent.ts, config.ts, types.ts |
| `src/tools/` | 4 | index.ts, shell-exec.ts, file-read.ts, file-write.ts |
| `src/cli/` | 2 | repl.ts, renderer.ts |
| Root | 5 | package.json, tsconfig.json, .env.example, mu.config.ts, README.md |
| **Total** | **~15 files** | |
