# mu — Product Requirements Document

**Version:** 1.0.0
**Date:** 2026-04-03
**Author:** Kush
**Status:** FROZEN — Verified against Vercel AI SDK v6 docs. Ready for implementation.

> **Phase execution plans:** See [Phase 1](phases/PHASE-1-core-agent.md) · [Phase 2](phases/PHASE-2-tool-system.md) · [Phase 3](phases/PHASE-3-web-ui.md) · [Phase 4](phases/PHASE-4-containerisation.md) · [Phase 5](phases/PHASE-5-hardening.md)

---

## 1. Executive Summary

mu is a local-first AI agent harness that gives frontier LLMs full, auditable access to a Linux machine. It wraps any OpenAI-spec-compatible model behind Vercel AI SDK v6's `ToolLoopAgent`, executing tool calls directly on the host system. The agent runs a configurable tool loop — shell commands, file operations, network requests, and more — with verbose step-by-step logging for complete auditability. It ships as a TypeScript/Node.js project with a CLI interface and a minimal web UI, containerisable via Docker for deployment on VMs, Raspberry Pis, Macs, or any Linux-based environment.

### 1.1 Reference Architecture

This PRD is informed by a deep study of Claude Code's (codename "Tengu") internal architecture — ~54 tools, 8 execution modes, a 5-phase agentic loop, 7 permission modes, multi-agent coordination, and MCP integration. mu adopts the **patterns** that map to a single-agent local harness while leaving the multi-tenancy, enterprise, and cloud-specific concerns behind.

**Key patterns adopted from reference:**

| Pattern | Source | What mu takes |
|---------|--------|--------------------|
| 5-phase agentic loop | `01-query-engine.md` | Pre-process → API call → Post-stream → Tool execution → Inter-turn housekeeping |
| Tool interface with `buildTool()` defaults | `02-tool-system.md` | Behavioral flags (`isReadOnly`, `isDestructive`), safe defaults, 14-step execution pipeline |
| Concurrent tool batching | `02-tool-system.md` | Read-only tools parallel (max 10), mutating tools serial |
| Permission system with modes | `08-permission-system.md` | 4-mode subset: `default` (ask), `auto` (allow all), `plan` (read-only), `approve-destructive` |
| Context compaction pipeline | `01-query-engine.md` | Tool-result budget → snip-compact → auto-compact for long-running sessions |
| Typed memory with relevance scoring | `12-memory-system.md` | `MEMORY.md` + typed memory files for cross-session learnings |
| MCP client capability | `07-mcp-integration.md` | Connect to external MCP servers for tool extensibility |
| NDJSON SDK protocol | `10-cli-transport-sdk.md` | Programmatic `--output ndjson` mode for scripting and automation |
| Skill system with YAML frontmatter | `06-command-skill-system.md` | User-defined reusable prompt+tool combos as `.md` files |

---

## 2. Problem Statement

Frontier models are powerful reasoners but have no hands. Existing agent frameworks either:

- Lock you into a specific provider (OpenAI Assistants API, Claude computer use)
- Require heavyweight infrastructure (LangGraph servers, AutoGen orchestrators)
- Offer poor visibility into what the agent is actually doing on your machine
- Lack configurable safety rails for tool loop depth and execution auditing

mu solves this by being a **thin, transparent harness** — not a framework — that connects any OpenAI-spec model to your local machine with maximum visibility and minimal abstraction.

---

## 3. Goals & Non-Goals

### Goals

| # | Goal |
|---|------|
| G1 | Run agentic tool loops via Vercel AI SDK v6 (`ToolLoopAgent` / `generateText` with `stopWhen`) |
| G2 | Compatible with any OpenAI-spec gateway (OpenAI, Anthropic via gateway, OpenRouter, local Ollama, LM Studio, etc.) |
| G3 | All tools execute locally on the host machine — no remote tool servers |
| G4 | Configurable max tool loop steps with hard safety ceiling |
| G5 | Extensive structured logging of every step, tool call, tool result, token usage, and timing |
| G6 | Verbose real-time output showing the agent's reasoning and actions at each step |
| G7 | CLI-first interface with a minimal web UI for monitoring/interaction |
| G8 | Containerisable via Docker; runs on Linux VMs, Raspberry Pi (ARM64), macOS |
| G9 | Tool list is modular and extensible — tools derived from reference architecture |
| G10 | Permission-gated tool execution with behavioral classification (read-only, destructive, open-world) |
| G11 | Context window management for long-running agentic sessions (compaction pipeline) |
| G12 | MCP client support for connecting external tool servers |
| G13 | NDJSON programmatic output mode for scripting/automation |
| G14 | Persistent memory system for cross-session learnings |

### Non-Goals

| # | Non-Goal |
|---|----------|
| NG1 | Not a multi-agent orchestration framework for v1 (single agent, single loop — coordinator/worker pattern is a future phase) |
| NG2 | Not a SaaS product — runs on your own hardware |
| NG3 | No built-in authentication/multi-tenancy for v1 |
| NG4 | No mobile app |
| NG5 | No GUI for tool authoring — tools are code |
| NG6 | No bridge/remote-control protocol for v1 (future consideration) |
| NG7 | No plugin marketplace for v1 (git-based plugin system is a future phase) |

---

## 4. Architecture Overview

```
┌──────────────────────────────────────────────────────────────────────┐
│                              mu                                   │
│                                                                       │
│  ┌──────────┐    ┌─────────────────────────┐    ┌─────────────────┐  │
│  │   CLI    │───▶│      Agent Core         │───▶│  Tool Registry  │  │
│  │  (stdin/ │    │                         │    │                 │  │
│  │  stdout) │    │  ToolLoopAgent          │    │  Built-in tools │  │
│  └──────────┘    │  ┌───────────────────┐  │    │  MCP tools      │  │
│                  │  │ 5-Phase Loop      │  │    │  (extensible)   │  │
│  ┌──────────┐    │  │ 1. Pre-process    │  │    └────────┬────────┘  │
│  │  Web UI  │───▶│  │ 2. API call       │  │             │           │
│  │ (Hono +  │    │  │ 3. Post-stream    │  │    ┌────────▼────────┐  │
│  │  SSE)    │    │  │ 4. Tool exec      │  │    │  Permission     │  │
│  └──────────┘    │  │ 5. Housekeeping   │  │    │  System         │  │
│                  │  └───────────────────┘  │    │  (4 modes)      │  │
│  ┌──────────┐    │                         │    └─────────────────┘  │
│  │  NDJSON  │───▶│  ┌───────────────────┐  │                         │
│  │  SDK     │    │  │ Logger / Audit    │  │    ┌─────────────────┐  │
│  └──────────┘    │  └───────────────────┘  │    │  MCP Client     │  │
│                  │  ┌───────────────────┐  │    │  (external tool  │  │
│  ┌──────────┐    │  │ Config Manager   │  │    │   servers)      │  │
│  │  Memory  │◀──▶│  └───────────────────┘  │    └─────────────────┘  │
│  │  System  │    │  ┌───────────────────┐  │                         │
│  └──────────┘    │  │ Compaction       │  │    ┌─────────────────┐  │
│                  │  │ Pipeline         │  │    │  OpenAI-spec    │  │
│                  │  └───────────────────┘  │───▶│  LLM Gateway    │  │
│                  └─────────────────────────┘    └─────────────────┘  │
│                                                                       │
└──────────────────────────────────────────────────────────────────────┘
                              │
                    ┌─────────▼─────────┐
                    │   Host Machine    │
                    │   (Linux/macOS)   │
                    │   Full system     │
                    │   access          │
                    └───────────────────┘
```

### 4.1 Component Breakdown

| Component | Responsibility |
|-----------|---------------|
| **Agent Core** | Wraps Vercel AI SDK v6 `ToolLoopAgent` or manual `generateText` loop. Implements the 5-phase agentic loop (pre-process → API call → post-stream → tool execution → inter-turn housekeeping). Manages conversation, tool dispatch, and loop control. |
| **Tool Registry** | Central registry with behavioral metadata. Each tool has `isReadOnly`, `isDestructive`, `isOpenWorld` flags. Read-only tools batch in parallel (max 10), mutating tools run serially. Merges built-in + MCP tools. |
| **Permission System** | 4-mode permission gating: `default` (ask every time), `auto` (allow all), `plan` (read-only only), `approve-destructive` (auto-allow reads, ask for writes). Rule-based with deny-always-wins semantics. Bypass-immune safety checks for critical paths. |
| **Compaction Pipeline** | Multi-stage context management for long sessions: tool-result budget trimming → snip-compact large outputs → auto-compact when approaching context limit. Uses `prepareStep` to modify messages. |
| **Config Manager** | Loads configuration from `mu.config.ts` / env vars / CLI flags. Controls model, max steps, log level, permission mode, tool whitelist, etc. |
| **Logger / Audit** | Structured JSON logging (via pino) of every step, tool call input/output, timing, token usage. Writes to stdout + rotating log files. |
| **CLI Interface** | Interactive terminal UI. Accepts user prompts, displays streaming agent output. REPL mode for multi-turn. |
| **NDJSON SDK** | Programmatic interface for scripting. Newline-delimited JSON messages matching structured protocol — tool calls, results, text deltas, control messages. |
| **Web UI** | Minimal Hono HTTP server. Server-Sent Events (SSE) for real-time streaming. Shows conversation, tool calls, step details. |
| **Memory System** | Persistent cross-session memory via `MEMORY.md` + typed memory files. Auto-extraction of insights from long sessions. Relevance scoring for memory retrieval. |
| **MCP Client** | Connects to external MCP servers (stdio, SSE, HTTP transports) for tool extensibility. MCP tools merged into tool registry with `mcp__{server}__{tool}` naming. |

### 4.2 Agentic Loop — 5-Phase Design (from reference)

The core loop is modelled after the query engine pattern in the reference architecture:

```
while (step < maxSteps && !aborted) {
  ┌─ Phase 1: PRE-PROCESSING ──────────────────────────┐
  │  • Memory/skill discovery and injection             │
  │  • Message history preparation                      │
  │  • Compaction pipeline (if context budget tight)     │
  │  • Active tool selection for this step               │
  └─────────────────────────────────────────────────────┘
           │
  ┌─ Phase 2: API CALL ────────────────────────────────┐
  │  • Call model via generateText/streamText           │
  │  • Stream tool_use blocks as they arrive            │
  │  • Begin parallel tool execution if concurrent-safe │
  └─────────────────────────────────────────────────────┘
           │
  ┌─ Phase 3: POST-STREAM ─────────────────────────────┐
  │  • Check abort signal                               │
  │  • Error recovery (retry, model escalation)         │
  │  • Log step metadata (usage, finishReason, timing)  │
  └─────────────────────────────────────────────────────┘
           │
  ┌─ Phase 4: TOOL EXECUTION ──────────────────────────┐
  │  • Permission check (mode-dependent)                │
  │  • Execute tools (parallel batch for read-only)     │
  │  • Capture output, errors, duration                 │
  │  • Truncate large outputs to budget                 │
  └─────────────────────────────────────────────────────┘
           │
  ┌─ Phase 5: INTER-TURN HOUSEKEEPING ─────────────────┐
  │  • Append tool results to message history           │
  │  • Memory extraction (if long-running)              │
  │  • Token budget check                               │
  │  • Emit step-finish event to all transports         │
  └─────────────────────────────────────────────────────┘
           │
        continue / stop decision
}
```

**Terminal reasons:** `completed`, `max_steps`, `aborted`, `model_error`, `cost_limit`, `prompt_too_long`
**Continue reasons:** `tool_calls_pending`, `compact_retry`, `budget_continuation`

---

## 5. Technical Design

### 5.1 Runtime & Language

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Language | TypeScript | AI SDK is TypeScript-native; type-safe tool schemas via Zod |
| Runtime | Node.js 22+ | LTS, native ESM, good ARM64 support |
| Package manager | pnpm | Fast, disk-efficient, lockfile consistency |
| Build | tsup or tsx (dev) | Simple, fast TypeScript compilation |

### 5.2 Core Dependencies

| Package | Purpose |
|---------|---------|
| `ai` (v6) | Vercel AI SDK — `ToolLoopAgent`, `generateText`, `streamText`, `tool`, `stepCountIs` |
| `@ai-sdk/openai` | OpenAI-compatible provider (works with any OpenAI-spec endpoint) |
| `@ai-sdk/mcp` | MCP client for connecting external tool servers |
| `@modelcontextprotocol/sdk` | MCP transport (stdio, HTTP) for local MCP servers |
| `zod` | Schema validation for config and tool inputs |
| `hono` | Lightweight HTTP server for web UI (works in Node, Bun, Deno) |
| `pino` | Structured JSON logging |
| `dotenv` | Environment variable loading |

### 5.3 Model / Provider Configuration

mu uses the OpenAI-compatible provider from AI SDK, pointed at any OpenAI-spec gateway:

```typescript
import { createOpenAI } from '@ai-sdk/openai';

const provider = createOpenAI({
  baseURL: config.apiBaseUrl,   // e.g. "https://api.openai.com/v1" or "http://localhost:11434/v1"
  apiKey: config.apiKey,
  compatibility: 'compatible',  // relaxed mode for non-OpenAI endpoints
});

const model = provider(config.model); // e.g. "gpt-4o", "claude-sonnet-4-6", "llama3"
```

This means mu works out of the box with:
- OpenAI API
- Anthropic (via OpenAI-compatible proxy or AI Gateway)
- OpenRouter
- Ollama (`http://localhost:11434/v1`)
- LM Studio
- vLLM, TGI, llama.cpp server
- Any OpenAI-spec endpoint

### 5.4 Agent Loop Design

Two modes, selectable via config:

#### Mode A: ToolLoopAgent (Recommended)

```typescript
import { ToolLoopAgent, stepCountIs } from 'ai';

const agent = new ToolLoopAgent({
  model,
  instructions: SYSTEM_PROMPT,
  tools: toolRegistry.getAll(),
  stopWhen: [
    stepCountIs(config.maxSteps),  // Hard ceiling, default 50
    // Custom conditions can be added
  ],
  onStepFinish: async ({ stepNumber, usage, finishReason, toolCalls, toolResults }) => {
    logger.logStep({ stepNumber, usage, finishReason, toolCalls, toolResults });
    ui.renderStep({ stepNumber, toolCalls, toolResults });
  },
});

const result = await agent.generate({ prompt: userInput });
```

#### Mode B: Manual Loop (Maximum Control)

```typescript
import { generateText, ModelMessage } from 'ai';

const messages: ModelMessage[] = [
  { role: 'system', content: SYSTEM_PROMPT },
  { role: 'user', content: userInput },
];

let step = 0;
while (step < config.maxSteps) {
  const result = await generateText({
    model,
    messages,
    tools: toolRegistry.getAll(),
    experimental_onToolCallStart({ toolName, toolCallId, input }) {
      logger.logToolStart({ step, toolName, toolCallId, input });
    },
    experimental_onToolCallFinish({ toolName, toolCallId, output, error, durationMs }) {
      logger.logToolFinish({ step, toolName, toolCallId, output, error, durationMs });
    },
  });

  messages.push(...result.response.messages);
  logger.logStep({ step, usage: result.usage, finishReason: result.finishReason });

  if (result.finishReason !== 'tool-calls') break;
  step++;
}
```

### 5.5 Tool System (informed by reference `02-tool-system.md`)

#### Tool Interface

Each tool is a standalone module with behavioral metadata, wrapped in Vercel AI SDK's `tool()`:

```typescript
// types.ts — mu tool metadata (inspired by reference Tool interface)
interface MuToolDef {
  // Identity
  name: string;
  description: string;
  searchHint?: string;           // Help model discover via tool search

  // Schema
  inputSchema: z.ZodType;

  // Behavioral flags (from reference — used for permission + concurrency decisions)
  isReadOnly: boolean;           // true = safe to run in parallel, no approval needed
  isDestructive: boolean;        // true = requires approval in approve-destructive mode
  isOpenWorld: boolean;          // true = makes network/external calls

  // Execution
  execute: (input: any, ctx: ToolContext) => Promise<ToolResult>;

  // Timeouts
  timeoutMs: number;             // per-tool timeout, default varies by category
}

// Factory with safe defaults (from reference buildTool() pattern)
function buildTool(partial: Partial<MuToolDef> & Pick<MuToolDef, 'name' | 'description' | 'inputSchema' | 'execute'>): MuToolDef {
  return {
    isReadOnly: false,           // conservative default
    isDestructive: false,
    isOpenWorld: false,
    timeoutMs: 30_000,
    ...partial,
  };
}
```

#### Tool Execution Pipeline (adapted from reference 14-step pipeline)

```
1. Tool lookup (registry)
2. Abort signal check
3. Zod schema validation
4. Permission check (mode-dependent)
5. Approval prompt (if destructive + approve mode)
6. Timeout wrapper
7. Execute tool.call()
8. Output truncation (maxOutputLength)
9. Error capture
10. Duration measurement
11. Audit log emission
12. Result assembly → return to agent loop
```

#### Concurrency Model (from reference)

```typescript
// Partition tool calls into concurrent batches
const readOnlyBatch = toolCalls.filter(tc => tools[tc.toolName].isReadOnly);
const mutatingBatch = toolCalls.filter(tc => !tools[tc.toolName].isReadOnly);

// Read-only tools run in parallel (max 10 concurrent)
const readResults = await Promise.all(
  readOnlyBatch.slice(0, 10).map(tc => executeTool(tc))
);

// Mutating tools run serially
for (const tc of mutatingBatch) {
  await executeTool(tc);
}
```

#### Tool Categories (from reference, adapted for mu)

Tools will be derived directly from the reference architecture's ~54 tool catalog. The categories:

| Category | Tools (from reference) | mu Adaptation |
|----------|----------------------|-------------------|
| **Shell** | `Bash` (18 supporting files), background execution | `shell_exec` — unified shell tool with timeout, cwd, background mode |
| **File Read** | `Read`, `Glob`, `Grep`, `LS` | `file_read`, `file_list` (glob), `file_search` (grep) |
| **File Write** | `Edit`, `Write`, `MultiEdit` | `file_write`, `file_edit` (patch-based), `file_multi_edit` |
| **Network** | `Fetch`, `WebSearch`, `Browser` | `http_request`, `web_search` |
| **Code Analysis** | LSP-based tools | Future — `code_symbols`, `code_references` |
| **System** | Process management, system info | `process_list`, `process_kill`, `system_info` |
| **Git** | Status, diff, commit, log | `git_status`, `git_diff`, `git_commit`, `git_log` |
| **Memory** | Remember tool, memory CRUD | `memory_write`, `memory_read` |
| **Agent** | Sub-agent spawning | Future — `agent_spawn` for coordinator/worker pattern |
| **MCP** | Dynamically loaded from MCP servers | `mcp__{server}__{tool}` naming convention |

> **Note:** The exact tool implementations will be built in Phase 2, derived directly from the reference docs.

### 5.6 Logging & Audit System

Every action is logged as structured JSON to enable post-hoc audit:

```typescript
interface StepLog {
  timestamp: string;         // ISO 8601
  sessionId: string;         // Unique per conversation
  stepNumber: number;
  finishReason: string;      // 'tool-calls' | 'stop' | 'length' | ...
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  toolCalls: Array<{
    toolCallId: string;
    toolName: string;
    input: unknown;
    output: unknown;
    error: string | null;
    durationMs: number;
  }>;
  modelResponse: string;     // Text generated by model (if any)
}
```

**Log destinations:**
- **stdout** — Real-time verbose output (configurable verbosity levels)
- **Log file** — `~/.mu/logs/{sessionId}.jsonl` — append-only, one JSON object per line
- **Web UI** — Streamed via SSE for real-time monitoring

**Verbose output levels:**

| Level | What's shown |
|-------|-------------|
| `quiet` | Final result only |
| `normal` | Step summaries + final result |
| `verbose` | Every tool call input/output, model reasoning, token usage, timing |
| `debug` | All of verbose + raw API request/response payloads |

Default: `verbose` (maximum visibility as per requirements).

### 5.7 Configuration

Configuration is loaded with the following precedence (highest first):

1. CLI flags (`--max-steps 100`)
2. Environment variables (`MU_BOT_MAX_STEPS=100`)
3. Config file (`mu.config.ts` or `.mu.json`)
4. Defaults

```typescript
interface MuConfig {
  // Model
  apiBaseUrl: string;            // default: "https://api.openai.com/v1"
  apiKey: string;                // from env: MU_BOT_API_KEY
  model: string;                 // default: "gpt-4o"

  // Agent Loop
  maxSteps: number;              // default: 50, hard max: 500
  loopMode: 'agent' | 'manual';  // default: 'agent' (ToolLoopAgent)
  temperature: number;           // default: 0
  
  // Logging
  logLevel: 'quiet' | 'normal' | 'verbose' | 'debug';  // default: 'verbose'
  logDir: string;                // default: "~/.mu/logs"
  logToFile: boolean;            // default: true
  outputFormat: 'text' | 'json' | 'ndjson';  // default: 'text', 'ndjson' for SDK mode

  // Tools
  enabledTools: string[] | 'all';  // default: 'all'
  
  // Permission System (4 modes — from reference 08-permission-system.md)
  permissionMode: 'default' | 'auto' | 'plan' | 'approve-destructive';
  // default     = ask before every tool call
  // auto        = allow all tools without asking (YOLO mode)
  // plan        = only allow read-only tools (isReadOnly: true)
  // approve-destructive = auto-allow reads, ask for destructive ops

  // Web UI
  webUiEnabled: boolean;         // default: false
  webUiPort: number;             // default: 3141

  // Safety
  maxOutputLength: number;       // truncate tool output at N chars, default: 50000
  costLimitUsd: number;          // stop session if estimated cost exceeds this, default: 0 (disabled)

  // Memory System (from reference 12-memory-system.md)
  memoryEnabled: boolean;        // default: true
  memoryDir: string;             // default: "~/.mu/memory"
  memoryMaxFiles: number;        // default: 200
  memoryMaxFileSize: number;     // default: 25600 (25KB)

  // MCP (from reference 07-mcp-integration.md)
  mcpServers: Record<string, McpServerConfig>;  // defined in .mu/mcp.json

  // System prompt
  systemPrompt: string;          // custom system prompt override
  systemPromptFile: string;      // path to system prompt file
}

interface McpServerConfig {
  transport: 'stdio' | 'sse' | 'http';
  command?: string;              // for stdio
  args?: string[];
  url?: string;                  // for sse/http
  env?: Record<string, string>;
}
```

### 5.8 CLI Interface

```
Usage: mu [options] [prompt]

Options:
  -m, --model <model>         Model identifier (default: "gpt-4o")
  -b, --base-url <url>        API base URL
  -s, --max-steps <n>         Maximum tool loop steps (default: 50)
  -v, --verbose               Set log level to verbose
  -d, --debug                 Set log level to debug
  -w, --web                   Enable web UI
  -p, --port <port>           Web UI port (default: 3141)
  --permission <mode>         Permission mode: default|auto|plan|approve-destructive
  --output <format>           Output format: text|json|ndjson (default: text)
  --cost-limit <usd>          Stop if estimated cost exceeds $N
  --no-memory                 Disable memory system for this session
  -c, --config <path>         Path to config file
  -h, --help                  Show help
  --version                   Show version

Examples:
  mu "list all running docker containers and their resource usage"
  mu -m claude-sonnet-4-6 --max-steps 100 "refactor src/ to use ESM imports"
  mu --permission approve-destructive "clean up old log files larger than 100MB"
  mu --output ndjson "check disk usage" | jq '.type'
  mu --permission plan "explain the project structure in src/"
  echo "check disk usage" | mu
```

**Execution modes (adapted from reference):**

| Mode | How | Description |
|------|-----|-------------|
| **Interactive REPL** | `mu` (no prompt) | Multi-turn conversation with full tool loop |
| **Headless** | `mu "prompt"` or `mu -p "prompt"` | Single prompt, execute, exit |
| **NDJSON SDK** | `mu --output ndjson` | Programmatic interface for scripting. Emits structured JSON-RPC messages per line |
| **Web** | `mu --web` | Starts Hono server + optional interactive CLI |

### 5.9 Web UI

Minimal single-page web interface:

- **Tech:** Hono server + vanilla HTML/JS (no React/build step for simplicity)
- **Features:**
  - Real-time streaming of agent output via SSE
  - Conversation view showing user prompts and agent responses
  - Expandable tool call details (input, output, timing, errors)
  - Step-by-step execution timeline
  - Token usage summary
  - Session history sidebar
- **API endpoints:**
  - `POST /api/chat` — Send a message, returns SSE stream
  - `GET /api/sessions` — List past sessions
  - `GET /api/sessions/:id` — Get session log
  - `GET /` — Serve the web UI

### 5.10 Docker & Containerisation

```dockerfile
FROM node:22-slim

WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile --prod

COPY dist/ ./dist/

ENV MU_BOT_API_KEY=""
ENV MU_BOT_API_BASE_URL="https://api.openai.com/v1"
ENV MU_BOT_MODEL="gpt-4o"
ENV MU_BOT_MAX_STEPS=50
ENV MU_BOT_LOG_LEVEL="verbose"
ENV MU_BOT_WEB_UI_ENABLED="true"
ENV MU_BOT_WEB_UI_PORT=3141

EXPOSE 3141

# When containerised, the agent operates within the container's filesystem/network
# Mount host volumes or use Docker-in-Docker for host access
ENTRYPOINT ["node", "dist/index.js"]
CMD ["--web"]
```

**Multi-arch build:**
```bash
docker buildx build --platform linux/amd64,linux/arm64 -t mu:latest .
```

This supports: x86_64 VMs, ARM64 Raspberry Pi, Apple Silicon Macs.

**Host access patterns:**
- **Direct (bare metal/VM):** Full system access, preferred for maximum capability
- **Docker with mounts:** `-v /:/host` for filesystem access, `--network host` for network access, `--privileged` for full device access
- **Docker-in-Docker:** For managing containers from within the agent

---

## 6. Project Structure

```
mu/
├── src/
│   ├── index.ts              # Entry point — CLI parsing, bootstrap
│   ├── agent.ts              # ToolLoopAgent setup, 5-phase loop
│   ├── config.ts             # Configuration loading & validation (Zod)
│   ├── logger.ts             # Structured logging (pino)
│   ├── state.ts              # Minimal reactive store (~35 lines, from reference)
│   ├── tools/
│   │   ├── index.ts          # Tool registry — merges built-in + MCP tools
│   │   ├── types.ts          # MuToolDef interface, defineTool() factory
│   │   ├── executor.ts       # 12-step execution pipeline, concurrency batching
│   │   ├── shell-exec.ts     # Shell command execution (background support)
│   │   ├── file-read.ts      # Read file contents
│   │   ├── file-write.ts     # Write/create files
│   │   ├── file-edit.ts      # Patch-based file editing
│   │   ├── file-list.ts      # Glob-based file listing
│   │   ├── file-search.ts    # Grep/regex search across files
│   │   ├── http-request.ts   # HTTP requests (fetch)
│   │   ├── process-list.ts   # List running processes
│   │   ├── process-kill.ts   # Kill processes
│   │   ├── system-info.ts    # System information (OS, CPU, RAM, disk)
│   │   ├── git-*.ts          # Git operations (status, diff, commit, log)
│   │   ├── memory-read.ts    # Read from memory system
│   │   ├── memory-write.ts   # Write to memory system
│   │   └── ...               # Additional tools
│   ├── permissions/
│   │   ├── index.ts          # Permission evaluator — 4-mode system
│   │   ├── rules.ts          # Rule matching (exact, glob, path patterns)
│   │   └── types.ts          # PermissionMode, PermissionResult types
│   ├── compaction/
│   │   ├── index.ts          # Compaction pipeline orchestrator
│   │   ├── tool-budget.ts    # Truncate tool results to token budget
│   │   ├── snip-compact.ts   # Snip large message sections
│   │   └── auto-compact.ts   # LLM-assisted summarization of history
│   ├── memory/
│   │   ├── index.ts          # Memory system manager
│   │   ├── store.ts          # File-based memory storage (MEMORY.md + typed files)
│   │   ├── relevance.ts      # Side-query relevance scoring (top-5 per turn)
│   │   └── extractor.ts      # Session memory extraction (background)
│   ├── mcp/
│   │   ├── client.ts         # MCP client — connect to external servers
│   │   ├── config.ts         # MCP server config loading (.mu/mcp.json)
│   │   └── converter.ts      # MCP tool → mu tool conversion
│   ├── cli/
│   │   ├── repl.ts           # Interactive REPL mode
│   │   ├── renderer.ts       # Terminal output formatting (verbose/debug)
│   │   └── ndjson.ts         # NDJSON SDK output mode
│   ├── web/
│   │   ├── server.ts         # Hono HTTP server
│   │   ├── routes.ts         # API routes (chat, sessions, SSE)
│   │   └── public/
│   │       └── index.html    # Single-page web UI
│   └── types.ts              # Shared TypeScript types
├── mu.config.ts           # Default config (user can override)
├── package.json
├── tsconfig.json
├── Dockerfile
├── docker-compose.yml
├── .env.example
├── phases/                    # Phase execution plans
│   ├── PHASE-1-core-agent.md
│   ├── PHASE-2-tool-system.md
│   ├── PHASE-3-web-ui.md
│   ├── PHASE-4-containerisation.md
│   └── PHASE-5-hardening.md
├── refrence/                  # Reference architecture docs
└── README.md
```

---

## 7. Verbosity & Visibility Requirements

This is a core differentiator. mu must provide **maximum visibility** into agent execution:

### 7.1 Terminal Output (verbose mode, default)

```
╭─ mu ──────────────────────────────────────────────╮
│ Model: claude-sonnet-4-6 via https://api.openai.com/v1│
│ Max steps: 50 │ Session: abc-123-def                  │
╰───────────────────────────────────────────────────────╯

You: Find all Python files larger than 1MB and list them by size

─── Step 1 ─────────────────────────────────────────────
🤖 Thinking: I'll search for large Python files using find...

🔧 Tool: shell_exec
   Input:  {"command": "find / -name '*.py' -size +1M -exec ls -lhS {} + 2>/dev/null | head -50"}
   ⏱  Duration: 2,341ms
   Output: (truncated to 2000 chars)
   -rw-r--r-- 1 root root 4.2M /usr/lib/python3/dist-packages/...
   -rw-r--r-- 1 root root 2.1M /opt/...
   ...

   Tokens: ↑ 1,204  ↓ 89  │  Finish: tool-calls

─── Step 2 ─────────────────────────────────────────────
🤖 Response:
   I found 12 Python files larger than 1MB. Here are the largest:
   ...

   Tokens: ↑ 1,891  ↓ 456  │  Finish: stop
   Total tokens used: 3,640  │  Total time: 4.7s

╭─ Done ────────────────────────────────────────────────╮
│ 2 steps │ 3,640 tokens │ 4.7s │ Log: ~/.mu/logs/abc-123-def.jsonl │
╰───────────────────────────────────────────────────────╯
```

### 7.2 Log File Output (JSONL)

Every session produces a `.jsonl` file with one JSON object per event:

```jsonl
{"type":"session_start","sessionId":"abc-123-def","model":"claude-sonnet-4-6","maxSteps":50,"timestamp":"2026-04-03T10:00:00.000Z"}
{"type":"user_message","content":"Find all Python files larger than 1MB...","timestamp":"..."}
{"type":"step_start","stepNumber":0,"timestamp":"..."}
{"type":"tool_call_start","stepNumber":0,"toolName":"shell_exec","toolCallId":"tc_001","input":{"command":"find ..."},"timestamp":"..."}
{"type":"tool_call_finish","stepNumber":0,"toolName":"shell_exec","toolCallId":"tc_001","output":"...","durationMs":2341,"timestamp":"..."}
{"type":"step_finish","stepNumber":0,"finishReason":"tool-calls","usage":{"inputTokens":1204,"outputTokens":89},"timestamp":"..."}
{"type":"step_start","stepNumber":1,"timestamp":"..."}
{"type":"step_finish","stepNumber":1,"finishReason":"stop","usage":{"inputTokens":1891,"outputTokens":456},"timestamp":"..."}
{"type":"session_end","totalSteps":2,"totalTokens":3640,"totalDurationMs":4700,"timestamp":"..."}
```

---

## 8. Safety & Guardrails (enhanced from reference `08-permission-system.md`)

### 8.1 Permission Modes

| Mode | Behavior | Use Case |
|------|----------|----------|
| `default` | Ask before every tool call | Maximum control, first-time use |
| `auto` | Allow all tools without asking | Trusted environment, automation |
| `plan` | Only allow `isReadOnly: true` tools | Safe exploration, read-only analysis |
| `approve-destructive` | Auto-allow reads, ask for `isDestructive: true` | Balanced — most practical mode |

### 8.2 Permission Evaluation Pipeline (from reference)

```
1. Check deny rules (from config) → deny always wins
2. Check tool behavioral flags (isReadOnly, isDestructive, isOpenWorld)
3. Apply mode-specific logic:
   - plan mode: deny if !isReadOnly
   - approve-destructive: ask if isDestructive, allow if isReadOnly
   - auto: allow all
   - default: ask all
4. Bypass-immune checks (never skipped, even in auto mode):
   - Prevent writing to ~/.mu/config (self-modification)
   - Prevent rm -rf / or equivalent catastrophic commands
   - Block commands that disable the permission system itself
```

### 8.3 Other Guardrails

| Mechanism | Description |
|-----------|-------------|
| **Max steps ceiling** | Hard limit on tool loop iterations. Default 50, configurable up to 500. |
| **Tool output truncation** | Tool outputs truncated at `maxOutputLength` (default 50KB) to prevent context window overflow. |
| **Timeout per tool** | Each tool call has a configurable timeout (default 30s for shell, 10s for file ops). |
| **Cost tracking** | Token usage tracked per step and per session. `costLimitUsd` stops the session when estimated cost exceeds threshold. |
| **Audit trail** | Every tool call and its I/O is logged. Logs are append-only and tamper-evident via sequential ordering. |
| **Compaction pipeline** | Prevents context window overflow in long sessions via multi-stage message compression. |
| **MCP tool sandboxing** | MCP tools inherit the same permission system as built-in tools. `mcp__*` glob rules can deny entire servers. |

---

## 9. OpenAI-Spec Gateway Compatibility

mu is designed to work with **any endpoint** that implements the OpenAI chat completions API (`/v1/chat/completions`). This includes:

| Provider | Base URL | Notes |
|----------|----------|-------|
| OpenAI | `https://api.openai.com/v1` | Native support |
| OpenRouter | `https://openrouter.ai/api/v1` | Multi-model gateway |
| Ollama | `http://localhost:11434/v1` | Local models |
| LM Studio | `http://localhost:1234/v1` | Local models |
| vLLM | `http://localhost:8000/v1` | Self-hosted inference |
| llama.cpp server | `http://localhost:8080/v1` | Lightweight local |
| Azure OpenAI | Custom endpoint | Via `@ai-sdk/azure` |
| Anthropic | Via AI Gateway or proxy | Via `@ai-sdk/anthropic` or gateway |

The `@ai-sdk/openai` provider with `compatibility: 'compatible'` mode handles minor variations between endpoints.

---

## 10. Deployment Targets

| Target | Setup |
|--------|-------|
| **Linux VM** | `git clone` + `pnpm install` + `pnpm start` or Docker |
| **Raspberry Pi (ARM64)** | Docker multi-arch image or direct Node.js install |
| **macOS** | Direct Node.js or Docker Desktop |
| **Docker Compose** | `docker compose up` with env vars for config |
| **Bare metal** | systemd service file provided for long-running operation |

---

## 11. Development Phases

Each phase has a dedicated execution plan document in `phases/`.

### Phase 1 — Core Agent ([PHASE-1-core-agent.md](phases/PHASE-1-core-agent.md))

Project scaffolding, config system, structured logger, agent core with 5-phase loop, 3 bootstrap tools (shell_exec, file_read, file_write), CLI interface (headless + REPL), verbose terminal renderer, JSONL audit logging, minimal reactive state store.

### Phase 2 — Full Tool System ([PHASE-2-tool-system.md](phases/PHASE-2-tool-system.md))

Complete tool set derived from reference architecture. Tool execution pipeline with behavioral flags. Permission system (4 modes). Concurrent tool batching. MCP client integration. NDJSON SDK output mode. Tool output truncation and timeout enforcement.

### Phase 3 — Web UI ([PHASE-3-web-ui.md](phases/PHASE-3-web-ui.md))

Hono server setup, SSE streaming endpoint, single-page HTML/JS UI, session history API, tool call detail views, real-time step-by-step execution timeline, token usage dashboard.

### Phase 4 — Containerisation & Distribution ([PHASE-4-containerisation.md](phases/PHASE-4-containerisation.md))

Dockerfile (multi-arch amd64+arm64), docker-compose.yml, systemd service file, .env.example, README with quickstart guide, host access patterns (mounts, privileged, DinD).

### Phase 5 — Hardening & Advanced Features ([PHASE-5-hardening.md](phases/PHASE-5-hardening.md))

Context compaction pipeline (3-stage). Memory system (MEMORY.md + typed files + relevance scoring + session extraction). Cost estimation stop conditions. Error recovery and retry logic. Skill system (YAML frontmatter .md files). Integration tests with mock LLM.

---

## 12. Key Technical Decisions

| Decision | Choice | Alternative Considered | Why |
|----------|--------|----------------------|-----|
| SDK | Vercel AI SDK v6 | LangChain, raw API calls | First-class TypeScript, `ToolLoopAgent`, built-in loop control, provider abstraction |
| Agent loop | `ToolLoopAgent` with `stopWhen` | Manual while loop | Less boilerplate, built-in step tracking, `prepareStep` for dynamic control. Manual loop available as escape hatch. |
| Provider | `@ai-sdk/openai` (compatible mode) | Provider-specific SDKs | Single provider covers all OpenAI-spec endpoints |
| Web server | Hono | Express, Fastify | Zero-dependency, multi-runtime, fast, modern API |
| Logging | pino | winston, console.log | Structured JSON, fast, low overhead |
| CLI | Commander + custom renderer | Ink, blessed | Minimal dependencies, raw control over output formatting |
| Schema | Zod | JSON Schema, TypeBox | AI SDK native, excellent DX, runtime validation |

---

## 13. Vercel AI SDK v6 Features Utilised

| Feature | Usage in mu |
|---------|----------------|
| `ToolLoopAgent` | Primary agent class — encapsulates model, tools, loop config |
| `tool()` helper | All tools defined with type-safe Zod schemas |
| `stepCountIs()` | Max step safety limit |
| `stopWhen` (array) | Combining step limit with custom conditions |
| `prepareStep` | Context window management in long loops; dynamic model switching |
| `onStepFinish` | Per-step logging, UI updates, token tracking |
| `experimental_onToolCallStart` | Real-time tool call visibility |
| `experimental_onToolCallFinish` | Tool timing, error capture |
| `needsApproval` (custom) | Human-in-the-loop via our `buildTool()` pipeline + permission system (not a direct SDK prop) |
| `activeTools` | Dynamic tool availability per step |
| `experimental_repairToolCall` | Auto-fix malformed tool calls from weaker models |
| Response `messages` | Conversation history accumulation for multi-turn |
| `result.steps` | Full step introspection for audit logs |
| `result.totalUsage` | Aggregate token tracking per session |

---

## 14. Open Questions

| # | Question | Status |
|---|----------|--------|
| Q1 | Exact tool implementations — parameter shapes, edge cases | **In progress — derived from reference** |
| Q2 | Should tool approval be opt-in or opt-out per tool? | Resolved — behavioral flags (`isDestructive`) + permission mode |
| Q3 | Session persistence format — JSONL files vs SQLite? | JSONL for v1, SQLite later |
| Q4 | Should the web UI support sending new prompts or just monitoring? | Both — full interaction |
| Q5 | Multi-turn conversation persistence across CLI invocations? | Not for v1 — sessions are ephemeral, but memory persists learnings |
| Q6 | System prompt customisation — config file or CLI flag? | Both — `systemPrompt` + `systemPromptFile` in config |
| Q7 | Auto-compaction strategy — LLM-summarise or truncate? | Both — truncate first (cheap), LLM-summarise as fallback |
| Q8 | Memory relevance scoring — dedicated side-query or embedding? | Side-query (from reference) for v1, embeddings for v2 |
| Q9 | MCP server auto-discovery or manual config only? | Manual config via `.mu/mcp.json` for v1 |

---

## 15. Reference Value Map

What each reference document contributes to mu and what is intentionally excluded:

| Reference Doc | Adopted | Not Adopted (and why) |
|---------------|---------|----------------------|
| `01-query-engine.md` | 5-phase loop, terminal/continue reasons, compaction pipeline, budget tracking | Token budget continuation (too complex for v1), collapse-drain-retry |
| `02-tool-system.md` | `buildTool()` factory, behavioral flags, execution pipeline, concurrency batching, tool categories | Streaming tool executor (overkill), deferral system (unnecessary with smaller tool count), 11 render methods |
| `03-bridge-remote-control.md` | Crash recovery pointer concept, message dedup | Entire bridge/CCR protocol (not needed for local-first), WebSocket relay |
| `04-state-management.md` | Minimal reactive store (~35 lines), side-effect layer pattern | Full AppState (300+ fields — too much), ref-then-state React pattern, QueryGuard state machine |
| `05-ui-layer.md` | Output formatting concepts, dialog priority | React/Ink TUI (too heavy), vim mode, Yoga layout engine, virtual message list |
| `06-command-skill-system.md` | Skill file format (YAML frontmatter), skill→command transformation, safety sets | 3-variant command type hierarchy (just prompt-style for v1), 85+ slash commands |
| `07-mcp-integration.md` | MCP client, stdio/SSE/HTTP transports, tool naming convention, reconnection logic | OAuth flow, MCP server mode (v2), 6+ transport types, IDE transports |
| `08-permission-system.md` | 4-mode subset, deny-always-wins, bypass-immune checks, rule matching | Full 7-mode system (plan/bubble/dontAsk not needed), auto-mode AI classifier, enterprise rules |
| `09-multi-agent.md` | Coordinator/worker concept (future), task state machine | Full swarm orchestration, inter-agent messaging, worktree isolation |
| `10-cli-transport-sdk.md` | NDJSON protocol, headless entry, output formats | WebSocket/SSE transports (for CCR, not needed), session ingress protocol |
| `11-plugin-system.md` | Git-based plugin concept (future), namespace isolation | Full marketplace system, plugin loading lifecycle |
| `12-memory-system.md` | MEMORY.md, typed memories, relevance scoring, session extraction, caps | Sonnet-specific side-query (will be model-agnostic), memory file YAML frontmatter |
| `13-remote-sessions.md` | Reconnection patterns | Entire remote session protocol, upstream proxy, container-to-API relay |
| `ARCHITECTURE.md` | Overall subsystem map, entry point patterns, execution mode catalog | Bun runtime (using Node), GrowthBook feature gating, OTel telemetry integration |

---

## 16. Success Criteria

| Metric | Target |
|--------|--------|
| A user can send a natural language prompt and the agent executes shell commands to fulfil it | ✅ |
| Every tool call is logged with input, output, timing, and token usage | ✅ |
| Max steps is respected and the agent halts cleanly | ✅ |
| Works with at least 3 different OpenAI-spec providers | ✅ |
| Docker image builds and runs on both amd64 and arm64 | ✅ |
| Audit log can reconstruct exactly what the agent did, in order, with timestamps | ✅ |
| CLI provides real-time verbose output of agent execution | ✅ |
| Web UI shows live streaming of agent actions | ✅ |
| Permission system prevents destructive ops when in plan/approve-destructive mode | ✅ |
| Read-only tools execute in parallel, mutating tools execute serially | ✅ |
| Long sessions don't crash from context overflow (compaction pipeline) | ✅ |
| NDJSON output mode works for scripting (`mu --output ndjson \| jq`) | ✅ |
| MCP servers can be connected for additional tools | ✅ |
| Memory persists useful learnings across sessions | ✅ |

---

## 17. Future Considerations (post-v1)

These are patterns from the reference architecture that are **not in scope for v1** but are architecturally planned for:

| Feature | Reference Source | When |
|---------|-----------------|------|
| **Multi-agent coordinator/worker** | `09-multi-agent.md` | v2 — spawn sub-agents for parallel task execution |
| **Plugin system** | `11-plugin-system.md` | v2 — git-based plugin repos with namespace isolation |
| **Bridge/remote control** | `03-bridge-remote-control.md` | v2 — control mu from a web UI on another machine |
| **Skill marketplace** | `06-command-skill-system.md` | v2 — share reusable skill files |
| **MCP server mode** | `07-mcp-integration.md` | v2 — expose mu tools as an MCP server |
| **Auto-mode AI classifier** | `08-permission-system.md` | v2 — LLM classifies tool safety dynamically |
| **Embedding-based memory retrieval** | `12-memory-system.md` | v2 — replace side-query with vector search |
| **React/Ink TUI** | `05-ui-layer.md` | v2 — rich terminal UI with vim keybindings |
