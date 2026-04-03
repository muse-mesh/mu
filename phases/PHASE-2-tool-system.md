# Phase 2 — Tool System & Permissions

**Goal:** Build the complete tool infrastructure — MuToolDef interface, buildTool() factory, execution pipeline, permission system, and all planned tools.

**Depends on:** Phase 1 (agent core, config, logger, state store).
**Blocks:** Phase 3 (web UI needs tool metadata), Phase 5 (compaction/memory depend on tool patterns).

---

## Deliverables

| # | Deliverable | Description |
|---|-------------|-------------|
| 2.1 | MuToolDef interface | Typed tool definition with behavioral flags |
| 2.2 | buildTool() factory | Wraps MuToolDef into Vercel AI SDK `tool()` with middleware |
| 2.3 | Tool execution pipeline | 12-step pipeline: parse → permission → execute → truncate → log |
| 2.4 | Permission system | 4-mode permission model (default, auto, plan, approve-destructive) |
| 2.5 | Tool registry | Central tool map with metadata, enable/disable by config |
| 2.6 | File tools | file_read, file_write, file_edit (diff-based), glob, grep |
| 2.7 | Shell tools | shell_exec (enhanced), shell_exec_bg (background processes) |
| 2.8 | Code tools | code_search (semantic grep), multi_file_edit |
| 2.9 | System tools | http_fetch, list_dir, system_info |
| 2.10 | Agent tools | think (scratchpad), task_complete, sub_agent (optional) |
| 2.11 | MCP client | Connect to external MCP servers, surface their tools |
| 2.12 | NDJSON output mode | Structured SDK protocol for machine consumers |
| 2.13 | Tool repair | `experimental_repairToolCall` integration for malformed calls |
| 2.14 | Concurrent tool batching | Execute independent tool calls in parallel |

---

## 2.1 MuToolDef Interface

**File: `src/tools/types.ts`**

Extends Vercel AI SDK `tool()` with behavioral metadata (from reference `02-tool-system.md`):

```typescript
import { z, ZodSchema } from 'zod';

export interface MuToolDef<TInput extends ZodSchema, TOutput> {
  name: string;
  description: string;
  inputSchema: TInput;

  // Behavioral flags (used by permission system and UI)
  isReadOnly: boolean;       // true = no side effects
  isDestructive: boolean;    // true = modifies filesystem / runs code
  requiresApproval: boolean; // true = always ask user in non-auto modes
  isBackground: boolean;     // true = long-running, don't block loop

  // Execution
  execute: (input: z.infer<TInput>, context: ToolContext) => Promise<TOutput>;

  // Optional
  timeout?: number;           // ms, default 30_000
  maxOutputLength?: number;   // chars, default from config
  categories?: string[];      // ['filesystem', 'shell', 'network', etc.]

  // Lifecycle hooks
  onBefore?: (input: z.infer<TInput>, context: ToolContext) => Promise<void>;
  onAfter?: (input: z.infer<TInput>, output: TOutput, context: ToolContext) => Promise<void>;
}

export interface ToolContext {
  sessionId: string;
  stepNumber: number;
  toolCallId: string;
  config: MuConfig;
  logger: Logger;
  state: SessionState;
  abortSignal: AbortSignal;
}
```

---

## 2.2 buildTool() Factory

**File: `src/tools/factory.ts`**

Converts `MuToolDef` → Vercel AI SDK `tool()`:

```typescript
import { tool as aiTool } from 'ai';

export function buildTool<TInput extends ZodSchema, TOutput>(
  def: MuToolDef<TInput, TOutput>,
  ctx: Omit<ToolContext, 'stepNumber' | 'toolCallId'>
): ReturnType<typeof aiTool> {
  return aiTool({
    description: def.description,
    inputSchema: def.inputSchema,
    execute: async (input, { toolCallId }) => {
      const context: ToolContext = { ...ctx, toolCallId, stepNumber: ctx.state.currentStep };

      // Pipeline: validate → permission → before hook → timeout wrapper → execute → truncate → after hook → log
      await validateInput(def, input);
      await checkPermission(def, context);
      await def.onBefore?.(input, context);

      const result = await withTimeout(
        () => def.execute(input, context),
        def.timeout ?? 30_000,
        `Tool ${def.name} timed out`
      );

      const truncated = truncateOutput(result, def.maxOutputLength ?? ctx.config.maxOutputLength);
      await def.onAfter?.(input, truncated, context);
      context.logger.logToolFinish({ toolName: def.name, toolCallId, output: truncated });

      return truncated;
    },
  });
}
```

---

## 2.3 Tool Execution Pipeline

12-step pipeline (adapted from reference `02-tool-system.md`, 14-step reduced):

```
1.  Parse & validate input (Zod)
2.  Check tool enabled (config.enabledTools)
3.  Permission check (per permission mode)
4.  Rate limiting (optional, for shell/network)
5.  onBefore hook
6.  Start timer
7.  Execute with AbortSignal + timeout
8.  Capture output + error
9.  Truncate output (maxOutputLength)
10. onAfter hook
11. Log to JSONL audit
12. Return to agent
```

Error handling: If a tool throws, the error is caught, formatted as `{ error: string }`, and returned to the model (not re-thrown). The loop continues.

---

## 2.4 Permission System

**File: `src/permissions/index.ts`**

Four modes (simplified from reference's 7-mode system):

| Mode | Behavior |
|------|----------|
| `auto` | All tools execute without prompting. For trusted environments / containers. Default. |
| `default` | Read-only tools auto-approved. Destructive tools prompt once, then remembered for session. |
| `approve-destructive` | Read-only auto-approved. Every destructive tool call prompts. |
| `plan` | Agent outputs a plan first. User approves/rejects. Then executes approved steps. |

```typescript
export async function checkPermission(def: MuToolDef, ctx: ToolContext): Promise<void> {
  const mode = ctx.config.permissionMode;

  if (mode === 'auto') return;
  if (def.isReadOnly) return;

  if (mode === 'default') {
    if (sessionApprovals.has(def.name)) return;
    const approved = await promptUser(`Allow ${def.name}? [y/N/always]`);
    if (approved === 'always') sessionApprovals.add(def.name);
    if (!approved) throw new PermissionDeniedError(def.name);
  }

  if (mode === 'approve-destructive' && def.isDestructive) {
    const approved = await promptUser(`Allow destructive: ${def.name}? [y/N]`);
    if (!approved) throw new PermissionDeniedError(def.name);
  }
}
```

Permission prompting in CLI mode uses `readline`. In web UI mode (Phase 3), it signals via SSE for browser-side approval.

---

## 2.5 Tool Registry

**File: `src/tools/index.ts`**

Central registration:

```typescript
const TOOL_REGISTRY: Map<string, MuToolDef<any, any>> = new Map();

export function registerTool(def: MuToolDef<any, any>) {
  TOOL_REGISTRY.set(def.name, def);
}

export function getEnabledTools(config: MuConfig): Record<string, ReturnType<typeof aiTool>> {
  const enabled = config.enabledTools === 'all'
    ? [...TOOL_REGISTRY.values()]
    : [...TOOL_REGISTRY.values()].filter(t => config.enabledTools.includes(t.name));

  return Object.fromEntries(enabled.map(def => [def.name, buildTool(def, ctx)]));
}
```

Supports `--tools shell_exec,file_read` CLI flag for restricting available tools.

---

## 2.6 File Tools

### `file_read` (enhanced from Phase 1)
- Line range support (`startLine`, `endLine`)
- Binary file detection (returns base64 or error)
- Symlink resolution
- `isReadOnly: true`

### `file_write`
- Creates parent dirs automatically
- Backup original if overwriting (to `/tmp/mu-backups/`)
- `isDestructive: true`

### `file_edit` (new — diff-based editing)
- Takes `path`, `oldContent`, `newContent` (string replacement)
- Validates `oldContent` exists exactly once in file
- Returns unified diff of the change
- `isDestructive: true`

### `glob`
- Glob pattern matching using `fast-glob`
- Returns list of matching file paths
- Respects `.gitignore` by default
- `isReadOnly: true`

### `grep`
- Regex search across files
- Returns matches with file path, line number, content
- Supports `--include` / `--exclude` patterns
- Uses `ripgrep` if available, falls back to Node.js impl
- `isReadOnly: true`

---

## 2.7 Shell Tools

### `shell_exec` (enhanced)
- Uses `child_process.spawn` with `/bin/bash -c`
- Configurable timeout (default 5 min for shell, 30s for other tools)
- Stdin support for piping
- Working directory option
- Environment variable pass-through from config
- Output truncation at `maxOutputLength`
- `isDestructive: true`

### `shell_exec_bg` (background processes)
- Starts a process in background, returns PID
- Can query status / output later via `shell_status` tool
- Useful for servers, watchers, builds
- `isBackground: true`, `isDestructive: true`

---

## 2.8 Code Tools

### `code_search`
- Semantic grep: searches for code patterns by description
- Falls back to ripgrep with smart pattern construction
- Returns ranked results with context
- `isReadOnly: true`

### `multi_file_edit`
- Batch file edits in one tool call (reduces round trips)
- Takes array of `{ path, oldContent, newContent }` operations
- Applies all or rolls back on failure
- `isDestructive: true`

---

## 2.9 System Tools

### `http_fetch`
- Fetches a URL, returns status + headers + body
- Respects timeout (30s default)
- Size limit on response body (1MB default)
- Follows redirects (max 5)
- `isReadOnly: true` (GET), `isDestructive: true` (POST/PUT/DELETE)

### `list_dir`
- Lists directory contents with file type indicators
- Supports depth parameter for recursive listing
- `isReadOnly: true`

### `system_info`
- Returns OS, arch, hostname, pwd, node version, available tools
- `isReadOnly: true`

---

## 2.10 Agent Tools

### `think`
- Scratchpad / chain-of-thought tool (from reference `02-tool-system.md`)
- Input: `{ thought: string }`
- Returns the thought back unchanged
- Lets the model reason without taking action
- `isReadOnly: true`

### `task_complete`
- Signals that the agent's task is done
- Input: `{ summary: string }`
- Sets a flag that the `stopWhen` condition can check
- `isReadOnly: true`

---

## 2.11 MCP Client

**File: `src/mcp/client.ts`**

Connects to external MCP servers to import their tools:

```typescript
import { createMCPClient } from '@ai-sdk/mcp';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

export async function loadMCPTools(config: MuConfig) {
  const tools: Record<string, any> = {};

  for (const server of config.mcpServers ?? []) {
    let transport;
    if (server.transport === 'stdio') {
      transport = new StdioClientTransport({
        command: server.config.command,
        args: server.config.args ?? [],
      });
    } else {
      transport = { type: server.transport as 'http' | 'sse', url: server.config.url! };
    }

    const client = await createMCPClient({ transport });
    const serverTools = await client.tools();
    Object.assign(tools, serverTools);
  }

  return tools;
}
```

Config format:
```json
{
  "mcpServers": [
    { "name": "my-server", "transport": "stdio", "config": { "command": "my-mcp-server" } },
    { "name": "remote", "transport": "sse", "config": { "url": "https://mcp.example.com/sse" } }
  ]
}
```

MCP tools are automatically merged into the agent's tool set.

---

## 2.12 NDJSON Output Mode

**File: `src/cli/ndjson.ts`**

When `--output ndjson`, all agent output goes to stdout as newline-delimited JSON:

```json
{"type":"session_start","sessionId":"abc-123","model":"gpt-4o","timestamp":"2025-01-01T00:00:00Z"}
{"type":"tool_call","stepNumber":1,"toolName":"shell_exec","input":{"command":"echo hello"}}
{"type":"tool_result","stepNumber":1,"toolName":"shell_exec","output":{"stdout":"hello\n","exitCode":0},"durationMs":42}
{"type":"text","stepNumber":2,"content":"The command output 'hello'."}
{"type":"session_end","totalSteps":2,"totalTokens":{"input":150,"output":30}}
```

This enables:
- Piping to `jq` for filtering
- Programmatic consumption by other tools
- Building higher-level orchestration on top of mu

---

## 2.13 Tool Repair

Wire up `experimental_repairToolCall` in the agent:

```typescript
experimental_repairToolCall: async ({ toolCall, tools, error }) => {
  logger.warn(`Malformed tool call for ${toolCall.toolName}: ${error.message}`);
  // Attempt to fix by re-parsing with lenient JSON
  try {
    const fixed = lenientJsonParse(toolCall.args);
    return { ...toolCall, args: JSON.stringify(fixed) };
  } catch {
    return null; // Give up, model will retry
  }
},
```

---

## 2.14 Concurrent Tool Batching

When the model returns multiple tool calls in a single step, execute independent ones in parallel:

```typescript
// In the agent config or manual loop:
const results = await Promise.allSettled(
  toolCalls.map(call => executeToolWithPipeline(call, ctx))
);
```

Vercel AI SDK handles this automatically in `ToolLoopAgent` (all tool calls in a step run concurrently). Just ensure the pipeline is async-safe.

---

## Acceptance Criteria

| Test | Expected |
|------|----------|
| All tools registered with correct flags | `getEnabledTools()` returns full set |
| `--tools file_read,file_write` | Only those tools available to model |
| `--permission default` + destructive call | User prompted in CLI |
| `--permission auto` + destructive call | No prompt, executes immediately |
| `file_edit` with bad oldContent | Error returned to model, loop continues |
| MCP server configured | MCP tools appear in registry |
| `--output ndjson` | All output is parseable NDJSON |
| Model sends malformed JSON args | Tool repair fixes and retries |
| Model sends 3 tool calls in 1 step | All 3 execute concurrently |
| Tool exceeds timeout | Timeout error returned to model |

---

## Estimated File Count

| Directory | Files | Purpose |
|-----------|-------|---------|
| `src/tools/` | 14 | types.ts, factory.ts, index.ts, shell-exec.ts, shell-exec-bg.ts, file-read.ts, file-write.ts, file-edit.ts, glob.ts, grep.ts, code-search.ts, multi-file-edit.ts, http-fetch.ts, list-dir.ts, system-info.ts, think.ts, task-complete.ts |
| `src/permissions/` | 2 | index.ts, prompt.ts |
| `src/mcp/` | 1 | client.ts |
| `src/cli/` | 1 | ndjson.ts (add to existing) |
| **Total new** | **~18 files** | |
