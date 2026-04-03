# μ (mu)

> AI agent harness with full local machine access. Wraps any OpenAI-compatible model behind Vercel AI SDK v6, executing tool calls directly on the host system with verbose step-by-step logging.

Built by [Muse Mesh](https://github.com/muse-mesh).

## Table of Contents

- [Quick Start](#quick-start)
- [Installation](#installation)
  - [Local (bare metal)](#local-bare-metal)
  - [Docker](#docker)
  - [Raspberry Pi / ARM64](#raspberry-pi--arm64)
- [Configuration](#configuration)
  - [Environment Variables](#environment-variables)
  - [Config File](#config-file)
  - [CLI Flags](#cli-flags)
- [Usage](#usage)
  - [Headless Mode](#headless-mode)
  - [Interactive REPL](#interactive-repl)
  - [Web UI](#web-ui)
  - [NDJSON Output](#ndjson-output)
- [Tools](#tools)
- [Permission Modes](#permission-modes)
- [Provider Compatibility](#provider-compatibility)
- [MCP Integration](#mcp-integration)
- [Deployment](#deployment)
  - [Docker Desktop](#docker-desktop)
  - [Raspberry Pi (native)](#raspberry-pi-native)
  - [Security Model](#security-model)
- [Audit Logging](#audit-logging)
- [Project Structure](#project-structure)
- [Development](#development)

---

## Quick Start

```bash
# Clone and install
git clone https://github.com/muse-mesh/mu.git && cd mu
pnpm install

# Configure
cp .env.example .env
# Edit .env — set MU_BOT_API_KEY at minimum

# Run interactively (CLI REPL)
pnpm dev

# Run with web UI
pnpm dev -- --web
# Open http://localhost:3141
```

## Installation

### Requirements

- **Node.js 22+**
- **pnpm** (corepack-managed, v10.30.1)

### Local (bare metal)

```bash
git clone https://github.com/muse-mesh/mu.git && cd mu
corepack enable && corepack prepare pnpm@10.30.1 --activate
pnpm install

# Copy and configure environment
cp .env.example .env
# Edit .env with your API key and model settings

# Development mode (tsx, hot reload)
pnpm dev

# Production build
pnpm build
pnpm start        # CLI mode
pnpm start:web    # Web UI mode
```

### Docker

```bash
cd mu

# Build the image
docker build -t mu:latest .

# Run with docker compose
cp .env.example .env   # configure first
docker compose up -d

# Or run directly
docker run -d \
  --name mu \
  -p 3141:3141 \
  --env-file .env \
  -e MU_BOT_WEB_UI_ENABLED=true \
  mu:latest
```

The Docker image:
- Uses `node:22-slim` with common CLI tools (git, curl, wget, jq, ripgrep, tree, python3)
- Runs as non-root `mu` user
- Application code at `/app` is read-only (owned by root)
- Agent working directory is `/` — full filesystem read access
- Persists data at `/home/mu/.mu` (mount a volume to retain across restarts)
- Health check at `GET /api/health`

### Raspberry Pi / ARM64

For resource-constrained devices (1 GB RAM), run natively without Docker:

```bash
# On the Pi — install Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash -
sudo apt-get install -y nodejs

# Transfer the built project (from your dev machine)
# On dev machine:
pnpm build
rsync -avz --exclude node_modules --exclude .git . user@pi-ip:~/mu

# On the Pi:
cd ~/mu
corepack enable && corepack prepare pnpm@10.30.1 --activate
pnpm install --frozen-lockfile --prod

# Configure
cp .env.example .env
# Edit .env

# Run
MU_BOT_WEB_UI_ENABLED=true node dist/index.js --web
# Access at http://<pi-ip>:3141
```

**Optional**: Create a systemd service for auto-start:

```bash
sudo tee /etc/systemd/system/mu.service > /dev/null << 'EOF'
[Unit]
Description=mu AI Agent
After=network.target

[Service]
Type=simple
User=pi
WorkingDirectory=/home/pi/mu
EnvironmentFile=/home/pi/mu/.env
ExecStart=/usr/bin/node /home/pi/mu/dist/index.js --web
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl enable mu
sudo systemctl start mu
```

---

## Configuration

Configuration loads from multiple sources (highest priority first):

1. **CLI flags** (`--model`, `--web`, etc.)
2. **Environment variables** (`MU_BOT_*`)
3. **Config file** (`.mu.json` in cwd or `~/.mu.json`)
4. **Defaults**

### Environment Variables

Copy `.env.example` to `.env` and customise:

| Variable | Description | Default |
|----------|-------------|---------|
| `MU_BOT_API_KEY` | API key for the LLM provider | — (**required**) |
| `MU_BOT_API_BASE_URL` | OpenAI-compatible API endpoint | `https://api.openai.com/v1` |
| `MU_BOT_MODEL` | Model identifier | `gpt-4o` |
| `MU_BOT_MAX_STEPS` | Max agentic loop iterations per turn | `50` |
| `MU_BOT_TEMPERATURE` | Sampling temperature (0–2) | `0` |
| `MU_BOT_PERMISSION_MODE` | `auto`, `default`, `approve-destructive`, `plan` | `auto` |
| `MU_BOT_WEB_UI_ENABLED` | Enable web UI server | `false` |
| `MU_BOT_WEB_UI_PORT` | Web UI port | `3141` |
| `MU_BOT_LOG_LEVEL` | `quiet`, `normal`, `verbose`, `debug` | `verbose` |
| `MU_BOT_LOG_DIR` | Audit log directory | `~/.mu/logs` |
| `MU_BOT_LOG_TO_FILE` | Write JSONL audit logs | `true` |
| `MU_BOT_OUTPUT_FORMAT` | CLI output: `text`, `json`, `ndjson` | `text` |
| `MU_BOT_MAX_OUTPUT_LENGTH` | Truncate tool output beyond this length | `50000` |
| `MU_BOT_COST_LIMIT_USD` | Spending limit per session (0 = unlimited) | `0` |
| `MU_BOT_SYSTEM_PROMPT` | Override system prompt (inline) | built-in |
| `MU_BOT_SYSTEM_PROMPT_FILE` | Override system prompt (from file) | — |
| `MU_BOT_MCP_SERVERS` | MCP servers config (JSON array) | — |

### Config File

Create `.mu.json` in your project root or `~/.mu.json`:

```json
{
  "apiBaseUrl": "http://localhost:11434/v1",
  "model": "llama3",
  "maxSteps": 100,
  "permissionMode": "default"
}
```

### CLI Flags

```
mu [prompt] [options]

Options:
  -m, --model <model>       Model identifier
  -b, --base-url <url>      API base URL
  -k, --api-key <key>       API key
  -s, --max-steps <n>       Max tool loop steps
  -v, --verbose             Verbose output
  -d, --debug               Debug output
  -w, --web                 Enable web UI
  -p, --port <port>         Web UI port (default: 3141)
  --permission <mode>       Permission mode
  --output <format>         Output format: text|json|ndjson
  --tools <tools>           Comma-separated list of enabled tools
  -c, --config <path>       Config file path
```

---

## Usage

### Headless Mode

Pass a prompt as an argument — mu executes the task and exits:

```bash
pnpm dev -- "list the files in the current directory"
pnpm dev -- -m gpt-4o "explain this codebase"
pnpm dev -- -s 5 "find all TODO comments in src/"
pnpm dev -- --tools file_read,grep "search for imports in src/"
```

### Interactive REPL

Run without a prompt for multi-turn conversation:

```bash
pnpm dev
```

### Web UI

Browser-based interface with real-time streaming:

```bash
pnpm dev -- --web
# Open http://localhost:3141
```

Features:
- Real-time streaming responses (AI SDK UI protocol)
- Session management (create, switch, resume, delete)
- Tool call visualization with collapsible detail panels
- Token usage and cost tracking
- Dark/light theme toggle
- Mobile-responsive layout with collapsible sidebar

### NDJSON Output

Machine-readable output for scripting:

```bash
pnpm dev -- --output ndjson "echo hello" | jq '.type'
```

---

## Tools

mu ships with 11 built-in tools:

| Tool | Description | Destructive |
|------|-------------|:-----------:|
| `shell_exec` | Execute shell commands | ✓ |
| `file_read` | Read file contents with optional line range | |
| `file_write` | Write content to files | ✓ |
| `file_edit` | Find-and-replace editing | ✓ |
| `glob` | Find files by glob pattern | |
| `grep` | Regex search across files (uses ripgrep if available) | |
| `list_dir` | List directory contents | |
| `http_fetch` | Fetch URLs (GET, POST, etc.) | |
| `system_info` | System info (OS, arch, memory, etc.) | |
| `think` | Reasoning scratchpad (no side effects) | |
| `task_complete` | Signal task completion | |

### Tool Filtering

```bash
# Read-only exploration
pnpm dev -- --tools file_read,grep,glob,list_dir "explore this codebase"

# File operations only
pnpm dev -- --tools file_read,file_write,file_edit "refactor the config module"
```

## Permission Modes

| Mode | Behavior |
|------|----------|
| `auto` | All tools execute without prompting (default) |
| `default` | Read-only auto-approved; destructive tools prompt once, then remembered |
| `approve-destructive` | Read-only auto-approved; every destructive call prompts |
| `plan` | Only read-only tools allowed; destructive tools blocked |

## Provider Compatibility

mu works with any OpenAI-compatible API endpoint:

```bash
# OpenAI
MU_BOT_API_BASE_URL=https://api.openai.com/v1
MU_BOT_MODEL=gpt-4o

# Ollama (local)
MU_BOT_API_BASE_URL=http://localhost:11434/v1
MU_BOT_MODEL=llama3

# OpenRouter
MU_BOT_API_BASE_URL=https://openrouter.ai/api/v1
MU_BOT_MODEL=anthropic/claude-sonnet-4-20250514

# LM Studio
MU_BOT_API_BASE_URL=http://localhost:1234/v1
MU_BOT_MODEL=local-model

# Mume Gateway
MU_BOT_API_BASE_URL=https://mume.ai/api/v1
MU_BOT_MODEL=z-ai/glm-5v-turbo
```

## MCP Integration

Connect external [MCP](https://modelcontextprotocol.io/) servers for additional tools:

```json
{
  "mcpServers": [
    {
      "name": "my-tools",
      "transport": "stdio",
      "config": { "command": "my-mcp-server", "args": [] }
    },
    {
      "name": "remote",
      "transport": "sse",
      "config": { "url": "https://mcp.example.com/sse" }
    }
  ]
}
```

Set via `.mu.json` or the `MU_BOT_MCP_SERVERS` env var (JSON string). MCP tools are namespaced as `mcp__{server}__{tool}`.

---

## Deployment

### Docker Desktop

```bash
cp .env.example .env   # configure API key & model
docker compose up -d   # builds, starts on port 3141
docker compose logs -f  # watch logs
docker compose down     # stop
```

### Raspberry Pi (native)

```bash
# Prerequisites: Node.js 22, pnpm
# Transfer built artifacts, install prod deps, run
# See "Raspberry Pi / ARM64" under Installation for full steps
```

### Security Model

When deployed in Docker:
- **Application code** (`/app`) is owned by `root:root` with `755` permissions — the agent user (`mu`) can read but **cannot modify its own code**
- **Working directory** is `/` — the agent can browse and read the entire filesystem
- **Writable storage** is limited to `/home/mu/.mu` (logs, sessions, memory)
- **Non-root execution** — the container runs as the unprivileged `mu` user

---

## Audit Logging

Every session creates a JSONL audit log at `~/.mu/logs/{sessionId}.jsonl`:

```bash
# View the latest log
cat ~/.mu/logs/$(ls -t ~/.mu/logs/ | head -1)

# Filter for tool calls
cat ~/.mu/logs/*.jsonl | jq 'select(.type == "tool_call_start")'
```

Event types: `session_start`, `session_end`, `user_message`, `step_start`, `step_finish`, `tool_call_start`, `tool_call_finish`, `model_response`.

---

## Project Structure

```
src/
├── index.ts              # CLI entry point (Commander)
├── agent.ts              # Agent loop (streamText + tools)
├── config.ts             # Zod-validated config loader
├── logger.ts             # Pino structured logger + JSONL audit
├── state.ts              # Reactive state store
├── types.ts              # Shared types (MuToolDef, LogEvent, etc.)
├── shutdown.ts           # Graceful SIGTERM/SIGINT shutdown
├── cost.ts               # Cost tracking with model pricing
├── retry.ts              # Retry with exponential backoff
├── context.ts            # Context window sizes + token estimation
├── cli/
│   ├── renderer.ts       # Terminal output formatter
│   └── repl.ts           # Interactive REPL mode
├── compaction/
│   ├── index.ts          # Context compaction pipeline
│   └── prompts.ts        # Compaction & memory extraction prompts
├── memory/
│   └── index.ts          # 3-tier memory system (MEMORY.md, entries, session)
├── tools/
│   ├── index.ts          # Tool registry + execution pipeline
│   ├── build-tool.ts     # buildTool() factory with safe defaults
│   ├── shell-exec.ts     # Shell command execution
│   ├── file-read.ts      # File reading with line ranges
│   ├── file-write.ts     # File writing
│   ├── file-edit.ts      # Find-and-replace editing
│   ├── glob.ts           # File glob matching
│   ├── grep.ts           # Regex search (ripgrep + fallback)
│   ├── list-dir.ts       # Directory listing
│   ├── http-fetch.ts     # HTTP requests
│   ├── system-info.ts    # System information
│   ├── think.ts          # Reasoning scratchpad
│   └── task-complete.ts  # Task completion signal
├── permissions/
│   ├── index.ts          # 4-mode permission system
│   └── prompt.ts         # CLI permission prompting
├── mcp/
│   └── client.ts         # MCP server client
└── web/
    ├── server.ts         # Hono API server + static serving
    └── sessions.ts       # Session store (JSON file-backed)

web/                      # React frontend (Vite)
├── src/
│   ├── App.tsx           # Main app component (useChat hook)
│   ├── main.tsx          # React entry point
│   └── app.css           # Styles (dark/light themes)
├── index.html
└── vite.config.ts
```

## Development

```bash
# Dev mode (tsx, auto-reload)
pnpm dev

# Dev with web UI
pnpm dev -- --web

# Frontend dev server (hot reload, proxied to backend)
pnpm dev:web

# Type-check
pnpm exec tsc --noEmit

# Production build (frontend + backend)
pnpm build

# Production run
pnpm start          # CLI mode
pnpm start:web      # Web UI mode (port 3141)
```

## License

Apache 2.0 — see [LICENSE](LICENSE) for details.

Copyright 2025 Muse Mesh.
