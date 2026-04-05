# mu — Implementation Tracker

> Auto-generated from gap analysis against phase docs. Updated: 2026-04-05

---

## Phase 1 — Core Agent ✅ 100%

- [x] Project scaffolding (package.json, tsconfig, pnpm workspaces)
- [x] Config system with Zod validation, env/CLI/file precedence
- [x] Structured logger (pino, JSONL to `~/.mu/logs/`)
- [x] Reactive state store (`src/state.ts`)
- [x] Agent core using `streamText()` with tool loop
- [x] Bootstrap tools: `shell_exec`, `file_read`, `file_write`
- [x] CLI headless mode (single prompt → execute → exit)
- [x] CLI REPL mode (interactive readline)
- [x] Terminal renderer (ANSI colors, spinner, all log levels)
- [x] JSONL audit logging (append-only per session)

---

## Phase 2 — Tool System & Permissions ⚠️ ~90%

- [x] `MuToolDef` interface with behavioral flags
- [x] `buildTool()` factory with safe defaults
- [x] 12-step tool execution pipeline
- [x] Permission system (4 modes: auto, default, plan, approve-destructive)
- [x] Tool registry with enable/disable from config
- [x] File tools: `file_read`, `file_write`, `file_edit`, `glob`, `grep`
- [x] Shell tool: `shell_exec`
- [ ] Shell tool: `shell_exec_bg` (background process manager)
- [ ] Code tool: `code_search` (semantic grep / pattern matching)
- [ ] Code tool: `multi_file_edit` (batch file editor with transactions)
- [x] System tools: `http_fetch`, `list_dir`, `system_info`
- [x] Agent tools: `think`, `task_complete`
- [x] MCP client for external tool servers
- [x] Tool repair (`experimental_repairToolCall`)
- [x] Concurrent tool batching (via AI SDK)
- [x] NDJSON renderer for CLI output
- [x] Step number tracking in tool audit logs

---

## Phase 3 — Web UI ⚠️ ~85%

- [x] Hono HTTP server with CORS
- [x] AI SDK `useChat` streaming (replaces SSE architecture)
- [x] REST API: session CRUD, config, health, gateway info
- [x] React + Vite SPA frontend
- [x] Chat interface with message history
- [x] Model selector with search, provider grouping, price/context display
- [x] Tool call visualization (expandable panels, custom per-tool renderers)
- [x] Token usage + cost display per message
- [x] OpenRouter model fetching + caching
- [x] Session list sidebar with resume capability
- [x] Dark/light theme toggle button
- [ ] Browser-side permission approval modal
- [ ] Step-by-step execution timeline component

---

## Phase 4 — Containerisation & Deployment ✅ ~95%

- [x] Multi-stage Dockerfile (build + production)
- [x] docker-compose.yml with volumes, resource limits
- [x] Container security (non-root `mu` user, read-only `/app`)
- [x] CLI tools in container (git, curl, wget, jq, ripgrep, tree, python3)
- [x] `.env.example` with documented variables
- [x] Health check endpoint (`/api/health`)
- [x] HEALTHCHECK directive in Dockerfile
- [x] Graceful shutdown handler (`src/shutdown.ts`)
- [x] CI/CD GitHub Actions workflow
- [x] Multi-arch builds (amd64 + arm64)
- [x] README with deployment instructions
- [ ] Expand README with step-by-step quickstart guide

---

## Phase 5 — Hardening & Intelligence ⚠️ ~85%

### Wired ✅
- [x] Cost tracker: instantiated in agent, fed per step, budget warnings logged
- [x] Retry: `withRetry()` wrapping `streamText()` (3 retries, backoff, 429/5xx)
- [x] Multi-turn REPL: conversation history persisted across turns
- [x] Graceful shutdown: cleanup callback for MCP connections
- [x] Context window lookup (`src/context.ts`)
- [x] Compaction pipeline wired into agent loop
  - `shouldCompact()` — checked before each generate with full message history
  - `compactConversation()` — triggered at 70% context usage
  - `resetConversation()` — triggered at 90% context usage
- [x] Memory system wired into agent loop
  - `buildMemoryContext()` — injected into system prompt every turn
  - `extractSessionMemory()` — called at REPL session end
  - Memory entries persisted per-project

### Not implemented ❌
- [ ] Skill system (YAML frontmatter `.md` files, loader, prompt injection)
- [ ] Integration test suite (mock LLM provider, 30+ tests)

---

## Cross-cutting / Polish

- [ ] Web permission bridge (permission prompts work in browser, not just CLI)
- [x] Cost display in REPL session summary
- [ ] Default system prompt improvements (more detailed capabilities section)

---

## Priority Queue

### Batch 1 ✅ (complete)
1. [x] Wire cost tracker into agent loop
2. [x] Wire retry around streamText
3. [x] Fix multi-turn REPL memory
4. [x] Wire graceful shutdown cleanup
5. [x] Fix stepNumber in wrapTool

### Batch 2 ✅ (complete)
6. [x] Wire compaction into agent loop
7. [x] Wire memory system into agent loop

### Batch 3 (next) — Missing tools
8. [ ] `shell_exec_bg` tool
9. [ ] `code_search` tool
10. [ ] `multi_file_edit` tool

### Batch 4 — Web UI polish
11. [ ] Permission approval modal (web)
12. [ ] Step timeline component

### Batch 5 — Hardening
13. [ ] Skill system
14. [ ] Integration test suite
