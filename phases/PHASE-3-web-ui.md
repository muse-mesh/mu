# Phase 3 — Web UI

**Goal:** Add a browser-based interface for interactive agent sessions with real-time streaming, tool call visualization, and session management.

**Depends on:** Phase 1 (agent core), Phase 2 (tool system, tool metadata for display).
**Blocks:** Nothing — web UI is an optional layer.

---

## Deliverables

| # | Deliverable | Description |
|---|-------------|-------------|
| 3.1 | Hono HTTP server | Lightweight server serving API + static files |
| 3.2 | SSE streaming endpoint | Real-time event stream from agent to browser |
| 3.3 | REST API | Session management, message submission, config |
| 3.4 | Frontend SPA | Vanilla HTML/JS/CSS — no framework, no build step |
| 3.5 | Chat interface | Message input, streaming response display |
| 3.6 | Tool call visualization | Expandable tool call panels with input/output |
| 3.7 | Step timeline | Visual step-by-step progression with timing |
| 3.8 | Token usage display | Running token counts and cost estimates |
| 3.9 | Session management | List, resume, delete past sessions |
| 3.10 | Permission prompts | Browser-side approval for destructive tools |
| 3.11 | Dark/light theme | CSS custom properties for theming |

---

## 3.1 Hono HTTP Server

**File: `src/web/server.ts`**

```typescript
import { Hono } from 'hono';
import { serveStatic } from 'hono/bun'; // or node adapter
import { cors } from 'hono/cors';

const app = new Hono();

app.use('*', cors());
app.use('/static/*', serveStatic({ root: './src/web/public' }));

// API routes
app.post('/api/sessions', createSession);
app.get('/api/sessions', listSessions);
app.get('/api/sessions/:id', getSession);
app.post('/api/sessions/:id/messages', sendMessage);
app.get('/api/sessions/:id/stream', streamEvents);
app.delete('/api/sessions/:id', deleteSession);

// SPA fallback
app.get('*', (c) => c.html(indexHtml));

export { app };
```

Server starts when `--web` flag is passed or `webUiEnabled: true` in config. Default port 3141.

---

## 3.2 SSE Streaming Endpoint

**File: `src/web/stream.ts`**

Server-Sent Events stream for real-time agent output:

```typescript
app.get('/api/sessions/:id/stream', async (c) => {
  const sessionId = c.req.param('id');

  return c.stream(async (stream) => {
    const unsubscribe = sessionStore.subscribe(sessionId, (event) => {
      stream.write(`data: ${JSON.stringify(event)}\n\n`);
    });

    // Keep alive
    const keepAlive = setInterval(() => {
      stream.write(': keepalive\n\n');
    }, 15000);

    stream.onAbort(() => {
      unsubscribe();
      clearInterval(keepAlive);
    });
  });
});
```

SSE event types (mirror the JSONL log events):
```
session_start, step_start, tool_call_start, tool_call_finish,
step_finish, model_response, text_delta, session_end,
permission_request, error
```

---

## 3.3 REST API

| Method | Path | Body | Response |
|--------|------|------|----------|
| `POST` | `/api/sessions` | `{ model?, maxSteps?, systemPrompt? }` | `{ sessionId }` |
| `GET` | `/api/sessions` | — | `[{ sessionId, status, createdAt, messageCount }]` |
| `GET` | `/api/sessions/:id` | — | Full session state with messages |
| `POST` | `/api/sessions/:id/messages` | `{ content: string }` | `{ accepted: true }` |
| `DELETE` | `/api/sessions/:id` | — | `{ deleted: true }` |
| `POST` | `/api/sessions/:id/approve` | `{ toolCallId, approved: boolean }` | `{ ok: true }` |
| `GET` | `/api/config` | — | Current config (redacted API key) |

---

## 3.4 Frontend SPA

**File: `src/web/public/index.html`**

Single HTML file with embedded CSS and JS. No framework, no build step, no npm dependencies in the browser. Just vanilla DOM manipulation.

Rationale: Keeps the project simple, eliminates frontend build complexity, and the UI is small enough to not need a framework.

```
src/web/public/
├── index.html      # Main SPA (HTML + embedded CSS + JS)
├── style.css       # Stylesheet (extracted from inline if it grows)
└── app.js          # Client-side logic (extracted if >500 lines)
```

---

## 3.5 Chat Interface

Layout:
```
┌─────────────────────────────────────┐
│  mu  │  model: gpt-4o  │ ⚙️    │  ← Header bar
├─────────────────────────────────────┤
│                                     │
│  User: "Read my package.json"       │  ← Message history
│                                     │
│  🔧 file_read                       │  ← Tool call (collapsible)
│  │ path: "package.json"             │
│  │ ✅ 42 lines, 1.2KB               │
│  │ ⏱ 3ms                            │
│                                     │
│  Assistant: Here's your...          │  ← Streamed response
│                                     │
├─────────────────────────────────────┤
│  [Type a message...]          [Send]│  ← Input bar
│  Tokens: 1,234 in / 567 out        │  ← Status bar
└─────────────────────────────────────┘
```

Features:
- Markdown rendering (using a lightweight lib or regex-based)
- Code block syntax highlighting (optional — Prism.js from CDN)
- Auto-scroll to bottom on new content
- Shift+Enter for multi-line input

---

## 3.6 Tool Call Visualization

Each tool call renders as a collapsible panel:

**Collapsed:**
```
🔧 shell_exec ✅ 42ms
```

**Expanded:**
```
🔧 shell_exec
├─ Input:  { "command": "ls -la" }
├─ Output: total 48\ndrwxr-xr-x ...
├─ Status: ✅ exitCode: 0
└─ Time:   42ms
```

Color coding:
- Green: Successful
- Red: Error / non-zero exit
- Yellow: Timed out
- Blue: Read-only tool
- Orange: Destructive tool (was approved)

---

## 3.7 Step Timeline

Visual progression showing all steps in the session:

```
Step 1 ──── tool_call(file_read) ──── 120ms ──── 45 tokens
Step 2 ──── tool_call(shell_exec) ── 3,200ms ── 89 tokens
Step 3 ──── text response ────────── 890ms ──── 234 tokens
```

Clickable: selecting a step scrolls to that step's content in the chat.

---

## 3.8 Token Usage Display

Status bar at the bottom showing:
- Input tokens (cumulative)
- Output tokens (cumulative)
- Estimated cost (based on model pricing table, configurable)
- Step count / max steps

Updates in real-time via SSE events.

---

## 3.9 Session Management

Sidebar or dropdown listing past sessions:

```
Sessions
├── 2025-01-15 14:30  "Deploy the app"        ✅ 12 steps
├── 2025-01-15 13:00  "Fix the login bug"      ✅ 8 steps
└── 2025-01-15 11:45  "Research caching"        ❌ error
```

Sessions stored in `~/.mu/sessions/` as JSON files. Each contains:
- Session metadata (id, model, timestamps)
- Full message history
- Tool call audit trail

Resume: Loads previous messages into context and continues the conversation.

---

## 3.10 Permission Prompts (Web)

When `permissionMode` is non-auto, destructive tool calls trigger a browser prompt:

```
┌─────────────────────────────────────┐
│  🔐 Permission Required             │
│                                     │
│  shell_exec wants to run:           │
│  rm -rf /tmp/old-builds             │
│                                     │
│  [Deny]  [Allow Once]  [Allow All] │
└─────────────────────────────────────┘
```

Flow:
1. Agent pipeline hits permission check
2. Server sends `permission_request` SSE event
3. Browser shows modal
4. User clicks approve/deny
5. Browser POSTs to `/api/sessions/:id/approve`
6. Server resolves the pending promise in the pipeline
7. Tool executes or throws PermissionDenied

---

## 3.11 Dark/Light Theme

CSS custom properties for easy theming:

```css
:root {
  --bg-primary: #ffffff;
  --bg-secondary: #f5f5f5;
  --text-primary: #1a1a1a;
  --text-secondary: #666666;
  --accent: #2563eb;
  --success: #16a34a;
  --error: #dc2626;
  --warning: #d97706;
  --border: #e5e7eb;
  --code-bg: #f1f5f9;
  --font-mono: 'JetBrains Mono', 'Fira Code', monospace;
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg-primary: #0a0a0a;
    --bg-secondary: #1a1a1a;
    --text-primary: #e5e5e5;
    --text-secondary: #999999;
    --border: #333333;
    --code-bg: #1e293b;
  }
}
```

Toggle button in header to override system preference.

---

## Acceptance Criteria

| Test | Expected |
|------|----------|
| `mu --web "hello"` | Server starts, browser shows chat with response |
| `mu --web` (no prompt) | Opens interactive session in browser |
| SSE reconnect | Browser reconnects after network drop |
| Multiple browser tabs | All receive same SSE events |
| Permission prompt | Modal appears, blocks execution until resolved |
| Session resume | Previous messages loaded, conversation continues |
| Long output | Tool output truncated with "show more" button |
| Mobile viewport | Layout responsive, usable on phone |
| Dark mode | Follows system preference, manual toggle works |

---

## Estimated File Count

| Directory | Files | Purpose |
|-----------|-------|---------|
| `src/web/` | 3 | server.ts, stream.ts, sessions.ts |
| `src/web/public/` | 3 | index.html, style.css, app.js |
| **Total new** | **~6 files** | |

---

## Design Decisions

1. **No React/Vue/Svelte** — The UI is simple enough for vanilla JS. Avoids a build step, keeps the project lean. If the UI grows complex in the future, consider htmx or Alpine.js before reaching for a framework.

2. **Hono over Express** — Lighter, faster, modern API, built-in SSE support, works everywhere (Node, Bun, Deno, Cloudflare Workers).

3. **SSE over WebSocket** — Simpler, works through proxies, auto-reconnects, sufficient for server→client streaming. WebSocket only needed if we add real-time collaborative features later.

4. **Sessions as JSON files** — Simple, no database dependency. SQLite could be added later if session count grows large.
