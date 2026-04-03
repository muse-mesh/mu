# mu — Architecture Document

> A local-first AI agent harness with full Linux machine access, built on Vercel AI SDK v6.

This document covers mu's current architecture, design decisions, and a roadmap of improvements informed by patterns from the Claude Code (Tengu) reference architecture.

---

## Table of Contents

1. [System Overview](#system-overview)
2. [Entry Points & Execution Modes](#entry-points--execution-modes)
3. [Core Agent Loop](#core-agent-loop)
4. [Configuration System](#configuration-system)
5. [Tool System](#tool-system)
6. [Permission System](#permission-system)
7. [Context Compaction](#context-compaction)
8. [Persistent Memory](#persistent-memory)
9. [MCP Integration](#mcp-integration)
10. [CLI & Terminal Rendering](#cli--terminal-rendering)
11. [Web UI & HTTP API](#web-ui--http-api)
12. [Session Management](#session-management)
13. [Cost Tracking](#cost-tracking)
14. [Logging & Audit Trail](#logging--audit-trail)
15. [State Management](#state-management)
16. [Error Recovery & Retry](#error-recovery--retry)
17. [Graceful Shutdown](#graceful-shutdown)
18. [Module Dependency Graph](#module-dependency-graph)
19. [Deployment Topologies](#deployment-topologies)
20. [Future Roadmap — Improvements from Reference Architecture](#future-roadmap--improvements-from-reference-architecture)

---

## System Overview

mu is a single-process AI agent that runs on a local Linux machine (or in a container) and provides the LLM with unrestricted tool access gated by a configurable permission system. It supports three execution modes (headless, REPL, web), 11 built-in tools, MCP server connections, context compaction, persistent memory, and structured audit logging.

### High-Level Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                        index.ts (CLI)                        │
│              Commander.js  ·  Config Loader                  │
├──────────┬──────────┬────────────────────────────────────────┤
│ Headless │   REPL   │              Web Server (Hono)         │
│  (once)  │  (loop)  │   REST API  ·  SSE Streaming  ·  SPA   │
├──────────┴──────────┴────────────────────────────────────────┤
│                      Agent Core (agent.ts)                   │
│         streamText()  ·  stepCountIs()  ·  Callbacks         │
├──────────────────────────────────────────────────────────────┤
│                     Tool Execution Pipeline                  │
│  Permission Check → Timeout → Execute → Truncate → Log       │
├───────────┬──────────┬──────────┬──────────┬─────────────────┤
│ shell_exec│file_read │file_write│   glob   │  ... 7 more     │
│ file_edit │  grep    │ list_dir │http_fetch│  + MCP tools    │
├───────────┴──────────┴──────────┴──────────┴─────────────────┤
│  Permissions │ Compaction │ Memory │ MCP Client │ Cost Track │
├──────────────┴────────────┴────────┴────────────┴────────────┤
│  Logger (pino) │ State Store │ Retry │ Shutdown │ Context    │
└──────────────────────────────────────────────────────────────┘
```

### Key Design Principles

- **Single-process**: One Node.js process serves CLI, REPL, and web UI. No microservices.
- **Streaming-first**: All LLM interactions use `streamText()` async generators for real-time feedback.
- **Permission-gated**: Every tool call passes through a permission check before execution.
- **Audit-everything**: All tool calls, model responses, and token usage are logged to append-only JSONL.
- **Modular tools**: Tools are self-contained definitions (`MuToolDef`) with behavioral flags, plugged into a 12-step execution pipeline.
- **Provider-agnostic**: Any OpenAI-compatible API endpoint works via `@ai-sdk/openai`.

---

## Entry Points & Execution Modes

**File**: `src/index.ts`

mu has three execution modes, selected by CLI arguments:

### Headless Mode
```
mu "fix the bug in server.ts"
```
- Single prompt → agent loop → exit with result.
- Used for scripting, CI/CD, and non-interactive automation.
- Respects `--output` format (text, json, ndjson).

### REPL Mode
```
mu
```
- Interactive multi-turn conversation loop via readline.
- Spinner animation during LLM thinking.
- Ctrl+C aborts current generation; Ctrl+D exits.
- Tracks cumulative steps, tokens, and cost across turns.

### Web Mode
```
mu --web
```
- Starts Hono HTTP server on port 3141.
- Serves React SPA from `web/dist/`.
- REST API for session management + SSE streaming for chat.
- CORS enabled for local development.

### Bootstrap Sequence

```
CLI flags (Commander.js)
  → loadConfig() (merge file + env + defaults)
  → createLogger(config)
  → createToolSet(config, logger)
  → loadMCPTools(config, logger)  [if MCP servers configured]
  → createAgent(config, tools, logger)
  → dispatch to mode (headless | repl | web)
```

---

## Core Agent Loop

**File**: `src/agent.ts`

The agent loop wraps Vercel AI SDK's `streamText()` with mu-specific callbacks and configurations.

### Loop Architecture

```
User Prompt
    │
    ▼
streamText({
  model,
  system prompt,
  messages,
  tools,
  maxSteps: stopWhen(stepCountIs(N)),
  experimental: { repairToolCall }
})
    │
    ├── text-delta events   → onTextDelta callback → renderer
    ├── tool-call events    → onToolCall callback → log + render
    ├── tool-result events  → onToolResult callback → log + render
    ├── step-finish events  → onStepFinish callback → usage tracking
    └── finish              → return result
```

### Key Behaviors

- **Bounded execution**: `stopWhen(stepCountIs(maxSteps))` prevents runaway loops (configurable 1–500, default 25).
- **Tool repair**: `experimental.repairToolCall` enables lenient JSON parsing for malformed LLM tool calls.
- **Streaming callbacks**: Six callback hooks (`onToolCall`, `onToolResult`, `onTextDelta`, `onStepFinish`, `onText`, `onFinish`) feed the renderer and logger.
- **Token tracking**: Each `step-finish` event accumulates input/output token counts.

---

## Configuration System

**File**: `src/config.ts`

### Schema (Zod-validated)

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `apiBaseUrl` | string | — | OpenAI-compatible API endpoint |
| `apiKey` | string | — | API key (from env or file) |
| `model` | string | `"gpt-4o"` | Model identifier |
| `maxSteps` | 1–500 | 25 | Maximum agent loop iterations |
| `temperature` | 0–2 | — | Sampling temperature |
| `permissionMode` | enum | `"default"` | Permission gating mode |
| `logLevel` | enum | `"info"` | pino log level |
| `outputFormat` | enum | `"text"` | CLI output format |
| `systemPromptFile` | string | — | Custom system prompt path |
| `enabledTools` | string[] | all | Tool allowlist |
| `mcpServers` | array | [] | MCP server connection configs |
| `costBudget` | number | — | Max USD spend per session |
| `webPort` | number | 3141 | HTTP server port |

### Resolution Order (highest priority first)

```
CLI flags (--model, --api-key, etc.)
  ↓
Environment variables (MU_BOT_*)
  ↓
Project config (.mu.json in cwd)
  ↓
User config (~/.mu.json)
  ↓
Hardcoded defaults
```

---

## Tool System

**Files**: `src/tools/index.ts`, `src/tools/build-tool.ts`, `src/tools/*.ts`

### Tool Definition Interface

Every tool is a `MuToolDef` with behavioral flags:

```typescript
interface MuToolDef {
  name: string;
  description: string;
  parameters: ZodSchema;
  execute: (input, context: ToolContext) => Promise<string>;

  // Behavioral flags
  isReadOnly: boolean;      // Safe without prompting
  isDestructive: boolean;   // Modifies filesystem or runs code
  isOpenWorld: boolean;     // Network access
  requiresApproval: boolean;// Always prompt
  categories: string[];     // ['filesystem', 'shell', 'network', ...]
  timeoutMs: number;        // Per-call timeout (default 30s)

  // Lifecycle hooks
  onBefore?: (input) => void;
  onAfter?: (input, output) => void;
}
```

### Built-in Tools (11)

| Tool | Category | Read-Only | Description |
|------|----------|-----------|-------------|
| `shell_exec` | shell | No | Run bash commands on host |
| `file_read` | filesystem | Yes | Read file contents (with line ranges) |
| `file_write` | filesystem | No | Write/create files (auto-creates dirs) |
| `file_edit` | filesystem | No | Replace exact string in file (diff output) |
| `glob` | filesystem | Yes | Find files by glob pattern |
| `grep` | filesystem | Yes | Search text (ripgrep with Node.js fallback) |
| `list_dir` | filesystem | Yes | List directory contents (recursive depth) |
| `http_fetch` | network | Mixed | HTTP requests (30s timeout, 1MB limit) |
| `system_info` | system | Yes | OS/hardware info |
| `think` | agent | Yes | Reasoning scratchpad (no-op) |
| `task_complete` | agent | Yes | Signal task completion (no-op) |

### 12-Step Execution Pipeline

Every tool call passes through this pipeline inside `createToolSet()`:

```
 1. Parse & validate input (Zod schema)
 2. Check tool is enabled (config.enabledTools)
 3. Permission check (permissionMode gate)
 4. Run onBefore hook (if defined)
 5. Start timer
 6. Execute with AbortSignal + timeout
 7. Capture output string
 8. Truncate if > 50KB (head + tail strategy)
 9. Run onAfter hook (if defined)
10. Log to JSONL audit trail
11. Handle errors (PermissionDeniedError, timeout, etc.)
12. Return result to agent
```

### Tool Factory

`buildTool(partial)` applies safe defaults:
- `isReadOnly: false`, `isDestructive: false`, `isOpenWorld: false`
- `timeoutMs: 30_000`
- Validates required fields at build time.

---

## Permission System

**Files**: `src/permissions/index.ts`, `src/permissions/prompt.ts`

### Permission Modes

| Mode | Behavior |
|------|----------|
| `auto` | All tools execute without prompting |
| `default` | Read-only auto-approved; destructive tools prompted once (session "always" memory) |
| `approve-destructive` | Read-only auto-approved; every destructive call prompts |
| `plan` | Read-only tools only; destructive tools blocked entirely |

### Decision Flow

```
Tool call arrives
    │
    ▼
Is tool read-only? ──Yes──→ Auto-approve
    │ No
    ▼
Permission mode?
    ├── auto → approve
    ├── plan → deny (throw PermissionDeniedError)
    ├── approve-destructive → prompt user [y/N/always]
    └── default → check session approvals map
                    ├── already approved → approve
                    └── not approved → prompt user [y/N/always]
                                        ├── y → approve (this call)
                                        ├── always → approve + remember
                                        └── N → deny
```

### Session Approvals

In `default` mode, when a user responds "always" to a permission prompt, that tool is remembered for the rest of the session. The approval map is cleared when the session ends.

---

## Context Compaction

**Files**: `src/compaction/index.ts`, `src/compaction/prompts.ts`

### Compaction Strategy

Context compaction prevents exceeding the model's context window by monitoring token usage ratios and applying progressive compression.

```
Token ratio = estimated_tokens(messages) / context_window(model)

ratio > 0.9  →  RESET   (emergency: extract key facts, replace entire history)
ratio > 0.7  →  SUMMARIZE (compact old messages, keep last 4)
ratio ≤ 0.7  →  NONE    (no action needed)
```

### Compaction Pipeline

1. **`shouldCompact(messages, model)`**: Calculate ratio against known context windows.
2. **`truncateToolOutput(output, maxLen)`**: Head/tail strategy — keep 40% head + 40% tail, summarize middle with `[... N chars truncated ...]`.
3. **`compactConversation(messages, model)`**: LLM-based summarization of older messages, preserving the last 4 messages untouched.
4. **`resetConversation(messages, model)`**: Emergency — extract key facts from the entire conversation and replace with a condensed system prompt.

### Context Windows

Hardcoded in `src/context.ts`:
- GPT-4o: 128K, o3-mini: 128K, Claude Sonnet: 200K, DeepSeek: 64K, default: 32K.

### Token Estimation

Heuristic: ~4 characters per token (`Math.ceil(text.length / 4)`).

---

## Persistent Memory

**File**: `src/memory/index.ts`

### 3-Tier Memory Model

```
Tier 1: MEMORY.md (project root)
  └── Manually written or auto-generated project context
  └── Read by agent at session start

Tier 2: Typed entries (~/.mu/memory/{projectHash}/entries.json)
  └── Structured MemoryEntry objects with type, relevance, timestamps
  └── Persisted to disk as JSON array

Tier 3: Session extraction
  └── LLM extracts facts from conversation at session end
  └── Appended to Tier 2 entries
```

### MemoryEntry Schema

```typescript
interface MemoryEntry {
  id: string;
  type: 'fact' | 'preference' | 'convention' | 'decision';
  content: string;
  source: string;       // session ID that created it
  relevance: number;    // 0–1 score
  createdAt: string;
  lastAccessedAt: string;
}
```

### Memory Operations

| Function | Purpose |
|----------|---------|
| `readProjectMemory(cwd)` | Load MEMORY.md from project root |
| `loadMemoryEntries(cwd)` | Load typed entries from disk |
| `addMemoryEntry(cwd, entry)` | Append new entry to entries.json |
| `extractSessionMemory(messages, model, sessionId)` | LLM extracts facts at session end |
| `queryMemory(cwd, query)` | Placeholder for semantic search (not yet implemented) |

---

## MCP Integration

**File**: `src/mcp/client.ts`

### Connection Flow

```
Config defines MCP servers:
  [{ name: "github", transport: "stdio", config: { command: "npx", args: [...] } }]

loadMCPTools(config, logger)
  → For each server:
    1. Create transport (StdioClientTransport | SSE | HTTP config)
    2. experimental_createMCPClient(transport)
    3. client.tools() → fetch tool list
    4. Namespace: mcp__{serverName}__{toolName}
    5. Return merged tool record
  → addExternalTools(mcpTools, toolSet)
```

### Supported Transports

| Transport | Protocol | Use Case |
|-----------|----------|----------|
| `stdio` | stdin/stdout | Local subprocess servers |
| `sse` | Server-Sent Events | Long-running remote servers |
| `http` | HTTP Streamable | Stateless remote servers |

### Namespacing

MCP tools are prefixed with `mcp__{serverName}__` to prevent collisions with built-in tools. Example: `mcp__github__create_issue`.

---

## CLI & Terminal Rendering

**Files**: `src/cli/renderer.ts`, `src/cli/repl.ts`

### Renderer Modes

| Mode | Output |
|------|--------|
| **Text** (default) | ANSI-colored, boxed headers, braille spinner, tool panels |
| **NDJSON** | Structured JSON per line — no visual decoration |
| **Quiet** | Silent — only final output |

### Renderer Interface

```typescript
interface Renderer {
  banner(config): void;          // Boxed header with model/steps/session
  stepStart(n): void;            // Step divider
  toolCall(name, input): void;   // Tool invocation display
  toolResult(name, output): void;// Tool result display
  modelText(text): void;         // LLM response text
  thinking(label?): void;        // Start spinner
  stopThinking(): void;          // Stop spinner
  stepFinish(n, usage): void;    // Step summary
  done(summary): void;           // Session summary
  error(err): void;              // Error display
  info(msg): void;               // Info message
  warn(msg): void;               // Warning message
}
```

### REPL Loop

```
readline prompt ("mu> ")
  → user input
  → emit userMessageEvent
  → renderer.thinking()
  → agent.generate(prompt, {
      onToolCall → renderer.toolCall()
      onToolResult → renderer.toolResult()
      onStepFinish → renderer.stepFinish()
      onText → renderer.modelText()
    })
  → renderer.stopThinking()
  → accumulate totalSteps, totalTokens
  → loop
```

---

## Web UI & HTTP API

**File**: `src/web/server.ts`

### Server Architecture

- **Framework**: Hono (lightweight, fast HTTP framework).
- **Adapter**: `@hono/node-server` for Node.js runtime.
- **Static files**: Serves Vite-built React SPA from `web/dist/` via `serveStatic()`.
- **CORS**: Enabled for all origins (local development).

### REST API Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/sessions` | Create new chat session |
| `GET` | `/api/sessions` | List all sessions |
| `GET` | `/api/sessions/:id` | Get session details |
| `DELETE` | `/api/sessions/:id` | Delete session |
| `POST` | `/api/chat` | Send message, stream response (SSE) |
| `GET` | `/api/config` | Redacted config (model, maxSteps, permissionMode) |
| `GET` | `/api/health` | Health check (status, uptime, model) |
| `GET` | `/api/gateway` | Gateway rate-limit information |

### Chat Streaming Flow

```
Browser: POST /api/chat { messages: UIMessage[] }
  → Server: convertToModelMessages(messages)
  → streamText({ model, system, messages, tools })
  → SSE stream (text-delta, tool-call, tool-result, finish)
  → Browser: @ai-sdk/react useChat() hook consumes stream
```

### Frontend Stack

- **React 19** with TypeScript.
- **Vite 6** for bundling and HMR during development.
- **`@ai-sdk/react`** `useChat()` hook for streaming integration.
- **Build output**: `web/dist/` — served as static files by Hono in production.

---

## Session Management

**File**: `src/web/sessions.ts`

### Session Model

```typescript
interface WebSession {
  sessionId: string;
  status: 'idle' | 'running' | 'completed' | 'error';
  model: string;
  maxSteps: number;
  createdAt: string;
  messages: Message[];
  totalTokens: number;
  totalSteps: number;
}
```

### Storage Strategy

- **Memory**: In-memory `Map<string, WebSession>` for fast access.
- **Disk**: Persistent JSON files at `~/.mu/sessions/{sessionId}.json`.
- **Hydration**: On `getSession()`, check memory first, then load from disk.

### Operations

| Function | Behavior |
|----------|----------|
| `createSession(model, maxSteps)` | Generate UUID, initialize, persist to disk |
| `getSession(id)` | Memory → disk fallback |
| `listSessions()` | Merge memory + disk, sort by recency |
| `updateSession(id, updates)` | Merge into memory + persist |
| `deleteSession(id)` | Remove from memory + delete file |

---

## Cost Tracking

**File**: `src/cost.ts`

### Pricing Model

Per-million-token pricing lookup:

| Model | Input | Output |
|-------|-------|--------|
| GPT-4o | $2.50 | $10.00 |
| Claude Sonnet | $3.00 | $15.00 |
| DeepSeek | $0.14 | $0.28 |

### CostTracker API

```typescript
class CostTracker {
  addUsage(inputTokens, outputTokens): void;
  addGatewayCost(cost: number): void;  // Direct cost from gateway headers
  isOverBudget(): boolean;
  isNearBudget(threshold?: number): boolean;
  getTotalCost(): number;
  getSummary(): { inputTokens, outputTokens, estimatedCost };
}
```

---

## Logging & Audit Trail

**File**: `src/logger.ts`

### Dual Output

1. **Stdout**: Human-readable log lines (respects `outputFormat` and `logLevel`).
2. **JSONL file**: Append-only structured log at `~/.mu/logs/{sessionId}.jsonl`.

### LogEvent Types

```typescript
type LogEvent =
  | { type: 'session_start'; sessionId; model; maxSteps; timestamp }
  | { type: 'user_message'; content; timestamp }
  | { type: 'tool_call_start'; toolName; input; stepNumber; timestamp }
  | { type: 'tool_call_finish'; toolName; output; durationMs; timestamp }
  | { type: 'step_finish'; stepNumber; usage; timestamp }
  | { type: 'model_response'; content; timestamp }
  | { type: 'error'; error; timestamp }
  | { type: 'session_end'; totalSteps; totalTokens; durationMs; timestamp };
```

### Audit Guarantees

- Every tool call generates both a `tool_call_start` and `tool_call_finish` event.
- All events include timestamps for forensic analysis.
- JSONL format enables streaming analysis with `jq`, `grep`, etc.

---

## State Management

**File**: `src/state.ts`

### Reactive Store

A minimal (~35-line) generic reactive store:

```typescript
function createStore<T>(initialState: T, onChange?: (state: T) => void) {
  return {
    getState(): T;
    setState(updater: (prev: T) => T): void;
    subscribe(listener: (state: T) => void): () => void;
  };
}
```

- Used for `WebSession` state in the web UI layer.
- `onChange` fires on every `setState()` call.
- `subscribe()` returns an unsubscribe function.
- No external dependencies.

---

## Error Recovery & Retry

**File**: `src/retry.ts`

### Retry Strategy

```typescript
withRetry(fn, config?, onRetry?)
```

- **Max retries**: 3 (configurable).
- **Backoff**: Exponential with jitter — `initialDelayMs * 2^attempt + random(jitter)`.
- **Max delay**: Capped at `maxDelayMs`.
- **Retry-After**: Respects HTTP `Retry-After` header.

### Retryable Errors

| Category | Errors |
|----------|--------|
| Network | `ECONNRESET`, `ETIMEDOUT`, `ENOTFOUND`, `EPIPE` |
| HTTP | 429 (rate limit), 500, 502, 503, 504 |

Non-retryable errors (400, 401, 403, 404) throw immediately.

---

## Graceful Shutdown

**File**: `src/shutdown.ts`

```
SIGTERM or SIGINT received
  → Log "shutting down"
  → Run cleanup callback (if provided)
  → 10-second timeout failsafe
  → process.exit(0)
```

---

## Module Dependency Graph

```
src/index.ts
├── src/config.ts ← Zod, fs, path, os
├── src/logger.ts ← pino
├── src/agent.ts ← ai SDK (streamText, stepCountIs)
├── src/cost.ts
├── src/retry.ts
├── src/shutdown.ts
├── src/state.ts
├── src/context.ts
├── src/types.ts ← zod
│
├── src/tools/
│   ├── index.ts ← MuToolDef registry + pipeline
│   ├── build-tool.ts
│   ├── shell-exec.ts ← child_process
│   ├── file-read.ts ← fs
│   ├── file-write.ts ← fs
│   ├── file-edit.ts ← fs
│   ├── glob.ts ← fs + regex
│   ├── grep.ts ← fs + ripgrep fallback
│   ├── list-dir.ts ← fs
│   ├── http-fetch.ts ← globalThis.fetch
│   ├── system-info.ts ← os
│   ├── think.ts
│   └── task-complete.ts
│
├── src/permissions/
│   ├── index.ts ← permission modes + session approvals
│   └── prompt.ts ← readline
│
├── src/compaction/
│   ├── index.ts ← ai SDK (generateText), context.ts
│   └── prompts.ts
│
├── src/memory/
│   └── index.ts ← ai SDK (generateText), fs
│
├── src/mcp/
│   └── client.ts ← ai SDK (experimental_createMCPClient)
│
├── src/cli/
│   ├── renderer.ts ← ANSI, spinner
│   └── repl.ts ← readline, agent callbacks
│
└── src/web/
    ├── server.ts ← Hono, ai SDK (streamText)
    └── sessions.ts ← fs, crypto
```

---

## Deployment Topologies

### Local Development

```
pnpm dev          # tsx watch mode (backend)
pnpm dev:web      # Vite dev server (frontend HMR)
```

### Production — Single Machine

```
pnpm build        # Vite frontend + tsup backend
pnpm start        # Node.js serves everything on :3141
```

### Docker

```dockerfile
# Multi-stage build
FROM node:22-slim AS builder  → pnpm install + build
FROM node:22-slim AS runtime  → copy dist, WORKDIR /, non-root user
HEALTHCHECK /api/health
EXPOSE 3141
```

- Root-owned `/app` — agent cannot modify its own code.
- `WORKDIR /` — agent's shell commands operate on the host filesystem (or container root).
- Non-root `mu` user for runtime.

### Raspberry Pi (ARM64)

Native deployment via rsync + pnpm:
```
rsync -az dist/ package.json pnpm-lock.yaml pi:~/mu/
ssh pi 'cd ~/mu && pnpm install --prod && node dist/index.js --web'
```

---

## Future Roadmap — Improvements from Reference Architecture

The following improvements are informed by patterns in the Claude Code (Tengu) reference architecture (14 documents in `refrence/`). They are organized by subsystem, with estimated complexity and priority.

---

### 1. Query Engine Enhancements

**Reference**: `01-query-engine.md`

| Improvement | Description | Priority |
|-------------|-------------|----------|
| **Multi-phase loop** | Formalize 5-phase execution: pre-processing → API streaming → post-streaming → tool execution → inter-turn housekeeping. Currently mu's loop is implicit in `streamText()` callbacks. | Medium |
| **Auto-compaction on 413** | Automatically compact and retry when the API returns a 413 (context too large) error, instead of failing. | High |
| **Extended thinking** | Support models with extended thinking budgets (e.g., Claude's `thinking` parameter). Pass through thinking blocks for debugging. | Low |
| **Budget tracking integration** | Wire `CostTracker.isOverBudget()` into the agent loop as a stop condition alongside `stepCountIs()`. | High |
| **Withheld error recovery** | Detect and handle withheld content errors (413, max_output_tokens, media errors) with automatic retry strategies. | Medium |

---

### 2. Advanced Tool System

**Reference**: `02-tool-system.md`

| Improvement | Description | Priority |
|-------------|-------------|----------|
| **Concurrent read-only execution** | Execute read-only tool calls in parallel (batch of N) while serializing destructive operations. Currently all tools execute serially. | High |
| **Streaming tool executor** | Stream partial tool output back to the UI during long-running operations (e.g., large file reads, shell commands). | Medium |
| **Deferred tool discovery** | Don't load all tools into the prompt upfront. Discover and inject tools on-demand based on conversation context to save prompt tokens. | Medium |
| **Tool annotations** | Add metadata annotations (`searchHint`, `alwaysLoad`, `readonlyHint`, `destructiveHint`) for smarter tool selection. | Low |
| **Tool result caching** | Cache idempotent read-only tool results within a turn to avoid redundant filesystem reads. | Low |
| **Structured tool output** | Return structured objects (not just strings) from tools for richer UI rendering. | Medium |

---

### 3. State Management Upgrades

**Reference**: `04-state-management.md`

| Improvement | Description | Priority |
|-------------|-------------|----------|
| **AppState singleton** | Unify all state (sessions, config, permissions, UI) into a single `AppState` store with fine-grained selectors. Currently state is scattered across modules. | Medium |
| **Side-effect layer** | Centralized `onChangeAppState()` handler for consistent side effects (persist settings, sync permissions, clear caches). | Low |
| **Selector pattern** | `useAppState(s => s.field)` via `useSyncExternalStore` for React components (prevent unnecessary re-renders). | Low |

---

### 4. UI & Rendering Improvements

**Reference**: `05-ui-layer.md`

| Improvement | Description | Priority |
|-------------|-------------|----------|
| **Rich tool rendering** | Render tool calls as expandable panels with syntax-highlighted diffs, file trees, and structured output. | Medium |
| **Message grouping** | Group parallel tool calls visually in the UI. | Low |
| **Virtual scrolling** | Viewport-based rendering for long conversations (web UI performance). | Low |
| **Command palette** | Slash command system (`/compact`, `/cost`, `/clear`, `/model`) for quick actions. | High |
| **Keyboard shortcuts** | Keybindings for common actions (abort, clear, scroll, etc.) in both REPL and web. | Low |

---

### 5. Command & Skill System

**Reference**: `06-command-skill-system.md`

| Improvement | Description | Priority |
|-------------|-------------|----------|
| **Slash commands** | `/compact`, `/cost`, `/model`, `/clear`, `/help` — user-invocable actions outside the LLM loop. | High |
| **Skill templates** | YAML-frontmatter markdown files (`.mu/skills/`) with reusable prompt templates, tool restrictions, and model overrides. | Medium |
| **File-based skills** | Discover skills from `.mu/skills/` project directory and `~/.mu/skills/` user directory. | Medium |
| **Conditional skills** | Activate skills based on file path globs (e.g., `*.py` activates Python-specific skills). | Low |
| **Effort hints** | `effort: low|medium|high|max` in skill frontmatter for cost optimization. | Low |

---

### 6. MCP Enhancements

**Reference**: `07-mcp-integration.md`

| Improvement | Description | Priority |
|-------------|-------------|----------|
| **OAuth support** | RFC 9728/8414 OAuth flows for authenticated MCP servers. | Low |
| **Connection lifecycle** | Graceful SIGINT → SIGTERM → SIGKILL escalation for MCP subprocess cleanup. | Medium |
| **Reconnection logic** | Automatic reconnection with exponential backoff for failed MCP connections. | Medium |
| **WebSocket transport** | Add WebSocket as a fourth MCP transport option. | Low |
| **Lazy connections** | Connect to MCP servers on first tool invocation, not at startup. | Medium |
| **Tool prompt stability** | Sort tools alphabetically for prompt-cache-friendly ordering. | Low |

---

### 7. Permission System Hardening

**Reference**: `08-permission-system.md`

| Improvement | Description | Priority |
|-------------|-------------|----------|
| **Rule-based permissions** | Allow/deny/ask patterns with glob matching (e.g., `"Bash(npm *)"` → auto-approve). | High |
| **Permission config file** | `.mu/permissions.json` or equivalent for project-level permission rules. | Medium |
| **Auto classifier** | LLM-based classifier for `auto` mode — classify tool calls as safe/unsafe without user prompting. | Low |
| **Bypass-immune checks** | Protect sensitive paths (`.git/`, `.mu/`) even in `auto` mode. | High |
| **Denial tracking** | Track consecutive denials and fall back to interactive prompting after threshold. | Low |
| **Permission audit log** | Log all permission decisions (allow, deny, prompt response) for compliance. | Medium |

---

### 8. Multi-Agent Coordination

**Reference**: `09-multi-agent.md`

| Improvement | Description | Priority |
|-------------|-------------|----------|
| **Sub-agent spawning** | `AgentTool` that spawns child agents for parallel task decomposition. | Medium |
| **Background agents** | Async sub-agents that run in background and report results via messaging. | Low |
| **Inter-agent messaging** | `SendMessage` tool for named agents to communicate. | Low |
| **Coordinator mode** | Specialized system prompt for task planning and delegation. | Low |
| **Git worktree isolation** | Sub-agents work in isolated git worktrees for safe concurrent modifications. | Low |

---

### 9. CLI & Transport Enhancements

**Reference**: `10-cli-transport-sdk.md`

| Improvement | Description | Priority |
|-------------|-------------|----------|
| **JSON-RPC protocol** | Structured I/O protocol (NDJSON) for programmatic access — enable IDE and SDK integrations. | Medium |
| **Output formats** | Expand beyond text/ndjson to include markdown and structured JSON. | Low |
| **SDK client** | TypeScript SDK for embedding mu in other applications. | Low |
| **Headless hooks** | Pre/post hooks for headless mode (e.g., notify on completion, post results to webhook). | Low |

---

### 10. Plugin System

**Reference**: `11-plugin-system.md`

| Improvement | Description | Priority |
|-------------|-------------|----------|
| **Plugin interface** | Formal plugin API contributing commands, tools, skills, and hooks. | Medium |
| **Builtin plugins** | Ship default plugins (code-review, testing, documentation, etc.). | Low |
| **Plugin namespacing** | `plugin:{name}:{component}` prevents collisions between plugins. | Low |
| **Marketplace** | Git-based plugin marketplace with clone/pull/remove lifecycle. | Low |

---

### 11. Memory System Improvements

**Reference**: `12-memory-system.md`

| Improvement | Description | Priority |
|-------------|-------------|----------|
| **Relevance scoring** | LLM side-query to select top-N relevant memory entries per turn (currently all entries are loaded). | High |
| **Background extraction** | Non-blocking memory extraction triggered by conversation length thresholds. | Medium |
| **Memory deduplication** | Content hash deduplication to prevent duplicate facts. | Medium |
| **Memory caps** | Enforce limits (e.g., 200 entries, 25KB total) to prevent memory bloat. | Medium |
| **Staleness tracking** | Flag memories older than N days with freshness warnings. | Low |
| **Team memory** | Shared memory across sub-agents for coordinated work. | Low |

---

### 12. Remote Sessions & Bridge

**Reference**: `03-bridge-remote-control.md`, `13-remote-sessions.md`

| Improvement | Description | Priority |
|-------------|-------------|----------|
| **Remote control protocol** | Bridge protocol for IDE-driven agent control (VS Code extension, web IDE). | Low |
| **Permission relay** | Forward permission requests from remote agent to local terminal. | Low |
| **Session handoff** | Transfer an active session between local and remote runtimes. | Low |
| **Cloud container runtime** | Provision remote containers for sandboxed agent execution. | Low |
| **Crash recovery** | Reconnect to remote sessions after network interruptions. | Low |

---

### Priority Summary

| Priority | Count | Examples |
|----------|-------|---------|
| **High** | 7 | Auto-compaction on 413, concurrent tools, cost budget stop, slash commands, rule-based permissions, bypass-immune paths, memory relevance scoring |
| **Medium** | 15 | Multi-phase loop, streaming tools, deferred tools, structured output, MCP reconnection, sub-agents, permission audit log, background extraction |
| **Low** | 18 | Extended thinking, vim mode, plugin marketplace, remote sessions, team memory |

### Recommended Implementation Order

1. **Slash commands** (`/compact`, `/cost`, `/model`) — instant user value, small scope.
2. **Auto-compaction on 413** — prevents the most common failure mode.
3. **Cost budget as stop condition** — `CostTracker` exists, just wire it in.
4. **Concurrent read-only tool execution** — significant performance improvement.
5. **Rule-based permissions** — replace blunt modes with fine-grained control.
6. **Bypass-immune path checks** — security hardening for `.git/`, `.mu/`.
7. **Memory relevance scoring** — reduce prompt bloat from memory entries.
8. **MCP reconnection + lazy connections** — reliability for long sessions.
9. **Skill system** — reusable prompt templates for common workflows.
10. **Sub-agent spawning** — unlock parallel task decomposition.
