# Phase 5 — Hardening & Intelligence

**Goal:** Add the advanced systems that make mu production-grade — context compaction, persistent memory, cost controls, error recovery, skill system, and integration tests.

**Depends on:** Phase 1–2 (agent core, tool system). Can run in parallel with Phase 3–4.
**Blocks:** Nothing — these are polish and robustness features.

---

## Deliverables

| # | Deliverable | Description |
|---|-------------|-------------|
| 5.1 | Context compaction pipeline | 3-stage compaction to keep context within limits |
| 5.2 | Memory system | Persistent MEMORY.md + typed memory files + session extraction |
| 5.3 | Cost controls | Token budget tracking, per-session USD limits, abort on threshold |
| 5.4 | Error recovery | Retry logic, exponential backoff, circuit breaker |
| 5.5 | Skill system | YAML-frontmatter skill files loaded from disk |
| 5.6 | Integration tests | End-to-end tests with mock LLM provider |
| 5.7 | Context window management | Dynamic model context window awareness |
| 5.8 | System prompt engineering | Optimised default prompts, prompt templates |

---

## 5.1 Context Compaction Pipeline

**File: `src/compaction/index.ts`**

Adapted from reference `06-commands-and-skills.md` and `12-memory-system.md`. Three stages:

### Stage 1: Tool Output Truncation (per-step, automatic)
Applied immediately when tool output exceeds `maxOutputLength`:
```typescript
function truncateToolOutput(output: string, maxLen: number): string {
  if (output.length <= maxLen) return output;
  const head = output.slice(0, maxLen * 0.4);
  const tail = output.slice(-maxLen * 0.4);
  return `${head}\n\n[... ${output.length - head.length - tail.length} chars truncated ...]\n\n${tail}`;
}
```

### Stage 2: Conversation Summary (triggered at threshold)
When message history exceeds 70% of model context window:
```typescript
async function compactConversation(messages: Message[], model: Model): Promise<Message[]> {
  const summary = await generateText({
    model,
    system: COMPACTION_PROMPT,
    messages: messages.slice(0, -4), // Keep last 4 messages intact
  });

  return [
    { role: 'system', content: `[Previous conversation summary]\n${summary.text}` },
    ...messages.slice(-4),
  ];
}
```

### Stage 3: Full Reset (emergency)
When even compacted context exceeds 90% of window:
- Extract key facts from entire conversation
- Create fresh context with extracted facts as system prompt addition
- Log warning to user

### Trigger Logic
```typescript
function shouldCompact(messages: Message[], modelContextWindow: number): 'none' | 'summarize' | 'reset' {
  const tokenEstimate = estimateTokens(messages); // ~4 chars per token heuristic
  const ratio = tokenEstimate / modelContextWindow;

  if (ratio > 0.9) return 'reset';
  if (ratio > 0.7) return 'summarize';
  return 'none';
}
```

Wire into `onStepFinish` or `prepareStep` callback.

---

## 5.2 Memory System

**Files: `src/memory/`**

Adapted from reference `12-memory-system.md`. Three tiers:

### Tier 1: MEMORY.md (project-level)
- File at project root: `MEMORY.md`
- Agent reads on session start, updates at session end
- Contains project conventions, architecture decisions, key file locations
- Auto-generated from session insights

### Tier 2: Typed Memory Files
```typescript
interface MemoryEntry {
  id: string;
  type: 'fact' | 'preference' | 'convention' | 'decision';
  content: string;
  source: string;        // Which session created this
  relevance: number;     // 0-1, decays over time
  createdAt: string;
  lastAccessedAt: string;
}
```

Stored in `~/.mu/memory/` as JSON files, organized by project.

### Tier 3: Session Context Extraction
At session end, extract and persist:
- Key decisions made
- Files modified and why
- Errors encountered and solutions
- User preferences observed

```typescript
async function extractSessionMemory(messages: Message[], model: Model): Promise<MemoryEntry[]> {
  const extraction = await generateText({
    model,
    system: MEMORY_EXTRACTION_PROMPT,
    messages,
  });
  return parseMemoryEntries(extraction.text);
}
```

### Memory Injection
On session start:
1. Read `MEMORY.md` if present → add to system prompt
2. Score memory entries by relevance to current prompt
3. Inject top-K entries into system prompt

```typescript
function selectRelevantMemory(prompt: string, entries: MemoryEntry[], k: number): MemoryEntry[] {
  return entries
    .map(e => ({ ...e, score: cosineSimilarity(prompt, e.content) * e.relevance }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}
```

For now, `cosineSimilarity` can use a simple word-overlap heuristic. Upgrade to embeddings later if needed.

---

## 5.3 Cost Controls

**File: `src/cost.ts`**

### Token Budget Tracking
```typescript
interface CostTracker {
  totalInputTokens: number;
  totalOutputTokens: number;
  estimatedCostUsd: number;
  limitUsd: number;
  isOverBudget: () => boolean;
}
```

### Model Pricing Table
```typescript
const PRICING: Record<string, { input: number; output: number }> = {
  'gpt-4o':       { input: 2.50, output: 10.00 },  // per 1M tokens
  'gpt-4o-mini':  { input: 0.15, output: 0.60 },
  'claude-sonnet-4-20250514': { input: 3.00, output: 15.00 },
  // Extensible via config
};
```

### Budget Enforcement
- Tracked via `onStepFinish` → `result.usage`
- When `costLimitUsd > 0` and estimated cost exceeds limit:
  - Warn at 80% threshold
  - Abort at 100% with summary of work done
- Add as a `stopWhen` condition:

```typescript
stopWhen: [
  stepCountIs(config.maxSteps),
  costExceeds(config.costLimitUsd, pricing[config.model]),
],
```

---

## 5.4 Error Recovery

### API Errors
```typescript
const RETRY_CONFIG = {
  maxRetries: 3,
  initialDelayMs: 1000,
  maxDelayMs: 30000,
  retryableStatusCodes: [429, 500, 502, 503, 504],
};

async function withRetry<T>(fn: () => Promise<T>, config = RETRY_CONFIG): Promise<T> {
  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt === config.maxRetries) throw error;
      if (!isRetryable(error)) throw error;

      const delay = Math.min(
        config.initialDelayMs * Math.pow(2, attempt) + Math.random() * 1000,
        config.maxDelayMs
      );
      await sleep(delay);
    }
  }
  throw new Error('Unreachable');
}
```

### Rate Limiting (429)
- Parse `Retry-After` header
- Exponential backoff with jitter
- Log retry attempts

### Tool Errors
- Tool execution errors are caught and returned to the model as error messages
- The model can decide to retry, try a different approach, or report the error
- Persistent tool failures (3+ consecutive) trigger a warning to the user

### Network Errors
- Timeout on API calls (configurable, default 120s for generation)
- Connection reset → retry
- DNS failure → abort with clear error message

---

## 5.5 Skill System

**Files: `src/skills/`**

Adapted from reference `06-commands-and-skills.md`. Skills are markdown files with YAML frontmatter that provide domain-specific instructions to the agent.

### Skill File Format
```markdown
---
name: typescript-migration
description: Migrate JavaScript files to TypeScript
triggers:
  - "migrate to typescript"
  - "convert to ts"
tools:
  - file_read
  - file_write
  - file_edit
  - shell_exec
---

## Instructions

When migrating JavaScript to TypeScript:
1. Read the source file
2. Add type annotations based on usage patterns
3. Rename .js to .ts
4. Run tsc to check for errors
5. Fix any type errors iteratively

## Conventions
- Use strict mode
- Prefer interfaces over types for object shapes
- Use unknown instead of any
```

### Skill Loading
```typescript
interface Skill {
  name: string;
  description: string;
  triggers: string[];
  tools?: string[];       // Restrict to these tools when skill is active
  instructions: string;   // The markdown body
}

function loadSkills(dir: string): Skill[] {
  const files = globSync(`${dir}/**/*.md`);
  return files.map(f => parseSkillFile(f));
}
```

### Skill Activation
On each user message:
1. Check if message matches any skill trigger (substring or regex)
2. If matched, inject skill instructions into system prompt
3. Optionally restrict `activeTools` to the skill's tool list

Skills live in:
- `~/.mu/skills/` — User-global skills
- `.mu/skills/` — Project-local skills

---

## 5.6 Integration Tests

**Files: `tests/`**

### Mock LLM Provider
```typescript
import { createMockProvider } from './helpers/mock-provider';

const mockProvider = createMockProvider([
  // Step 1: Model calls file_read
  { toolCalls: [{ name: 'file_read', args: { path: '/tmp/test.txt' } }] },
  // Step 2: Model responds with text
  { text: 'The file contains: hello world' },
]);
```

### Test Categories

| Category | Tests | Description |
|----------|-------|-------------|
| Agent loop | 5 | stepCountIs, task_complete, error recovery, abort |
| Tool execution | 10 | Each tool's happy path + error cases |
| Permission system | 4 | All 4 modes with mock prompts |
| Config | 3 | CLI flags, env vars, config file precedence |
| Compaction | 3 | Truncation, summarisation, reset |
| Memory | 3 | Read, write, relevance scoring |
| Cost tracking | 2 | Warning at 80%, abort at 100% |
| NDJSON output | 2 | Parseable output, complete events |
| MCP client | 2 | Tool import, execution |
| CLI | 3 | Headless, REPL, flag parsing |

### Test Runner
Use Node.js built-in test runner (`node:test`) — no dependency needed:

```typescript
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';

describe('agent loop', () => {
  it('stops after maxSteps', async () => {
    const agent = createTestAgent({ maxSteps: 3 });
    const result = await agent.generate({ prompt: 'keep going' });
    assert.strictEqual(result.steps.length, 3);
  });
});
```

---

## 5.7 Context Window Management

**File: `src/context.ts`**

Be aware of model context window sizes:

```typescript
const CONTEXT_WINDOWS: Record<string, number> = {
  'gpt-4o':           128_000,
  'gpt-4o-mini':      128_000,
  'claude-sonnet-4-20250514':    200_000,
  'claude-3-5-haiku': 200_000,
  'deepseek-chat':    64_000,
  // Fallback
  'default':          32_000,
};

export function getContextWindow(model: string): number {
  return CONTEXT_WINDOWS[model] ?? CONTEXT_WINDOWS.default;
}
```

Used by:
- Compaction pipeline (trigger thresholds)
- `prepareStep` callback (check before each step)
- Token usage display

---

## 5.8 System Prompt Engineering

**File: `src/prompts.ts`**

Default system prompt, optimised through testing:

```typescript
export const DEFAULT_SYSTEM_PROMPT = `You are mu, an AI agent with full access to the local machine via tools.

## Capabilities
- Execute shell commands (shell_exec)
- Read, write, and edit files (file_read, file_write, file_edit)
- Search code and files (grep, glob, code_search)
- Fetch URLs (http_fetch)
- Manage background processes (shell_exec_bg)

## Guidelines
- Think step by step before acting. Use the 'think' tool to plan complex tasks.
- Read files before modifying them.
- Prefer small, incremental changes over large rewrites.
- Verify your changes work (run tests, check output).
- When done, use task_complete to signal completion.
- If you're unsure, ask the user rather than guessing.
- Never modify files outside the working directory without explicit permission.

## Error Handling
- If a command fails, read the error output carefully.
- Try a different approach rather than repeating the same failing command.
- Report persistent failures to the user with context.

## Environment
- OS: {{OS}}
- Shell: /bin/bash
- Working directory: {{CWD}}
- Available tools: {{TOOL_LIST}}
`;
```

Template variables are filled at session start.

---

## Acceptance Criteria

| Test | Expected |
|------|----------|
| 100+ message conversation | Compaction triggers, context stays within window |
| Session end | Memory entries extracted and persisted |
| New session in same project | Relevant memories injected into context |
| `--cost-limit 0.50` | Aborts when estimated cost reaches $0.50 |
| API returns 429 | Retries with exponential backoff |
| Tool fails 3x consecutively | Warning surfaced to user |
| `.mu/skills/deploy.md` exists | Skill loaded on "deploy" trigger match |
| `pnpm test` | All integration tests pass |
| Config loads from all 3 sources | Correct precedence applied |

---

## Estimated File Count

| Directory | Files | Purpose |
|-----------|-------|---------|
| `src/compaction/` | 2 | index.ts, prompts.ts |
| `src/memory/` | 3 | index.ts, extraction.ts, scoring.ts |
| `src/skills/` | 2 | index.ts, parser.ts |
| `src/` | 3 | cost.ts, context.ts, prompts.ts |
| `tests/` | 8 | agent.test.ts, tools.test.ts, permissions.test.ts, config.test.ts, compaction.test.ts, memory.test.ts, cost.test.ts, ndjson.test.ts |
| `tests/helpers/` | 2 | mock-provider.ts, fixtures.ts |
| **Total new** | **~20 files** | |

---

## Post-Phase 5: Future Considerations (v2)

These are explicitly out of scope for v1 but noted for future:

1. **Multi-agent orchestration** — Coordinator/worker pattern from reference `09-multi-agent-patterns.md`
2. **Plugin system** — Git-based plugin loading from reference `11-plugin-system.md`
3. **Remote sessions** — SSH/container-based execution from reference `13-remote-sessions.md`
4. **Embedding-based memory** — Replace word-overlap with proper vector similarity
5. **Streaming web responses** — Token-by-token streaming in web UI
6. **VS Code extension** — Editor integration
7. **Persistent agent** — Always-on daemon mode with scheduled tasks
