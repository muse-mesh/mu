# Phase 4 — Containerisation & Deployment

**Goal:** Package mu as a production-ready Docker container with proper security boundaries, multiple deployment modes, and developer-friendly setup.

**Depends on:** Phase 1–3 (all features must work before containerising).
**Blocks:** Nothing — containerisation wraps what already works.

---

## Deliverables

| # | Deliverable | Description |
|---|-------------|-------------|
| 4.1 | Multi-stage Dockerfile | Minimal production image with Node.js 22 |
| 4.2 | docker-compose.yml | One-command local setup with env config |
| 4.3 | Container security | Non-root user, read-only fs, resource limits |
| 4.4 | Host access patterns | Volume mounts, network modes for local dev |
| 4.5 | .env.example | Documented environment variable template |
| 4.6 | Health check endpoint | HTTP health check for orchestrators |
| 4.7 | Graceful shutdown | SIGTERM/SIGINT handling inside container |
| 4.8 | CI/CD configuration | GitHub Actions for build, test, publish |
| 4.9 | Multi-arch builds | ARM64 + AMD64 images |
| 4.10 | README & quickstart | Setup documentation |

---

## 4.1 Multi-Stage Dockerfile

**File: `Dockerfile`**

```dockerfile
# Stage 1: Install dependencies
FROM node:22-slim AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile --prod=false

# Stage 2: Build
FROM deps AS build
COPY . .
RUN pnpm build

# Stage 3: Production
FROM node:22-slim AS production
WORKDIR /app

# Install common CLI tools the agent may need
RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl wget jq ripgrep fd-find tree \
    python3 python3-pip \
    && rm -rf /var/lib/apt/lists/*

# Create non-root user
RUN groupadd -r mu && useradd -r -g mu -m -d /home/mu mu

# Copy built app
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./

# Create directories with correct ownership
RUN mkdir -p /home/mu/.mu/logs /home/mu/.mu/sessions \
    && chown -R mu:mu /home/mu /app

USER mu

# Web UI port
EXPOSE 3141

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:3141/health || exit 1

ENTRYPOINT ["node", "dist/index.js"]
```

Image targets:
- `production` — Full image with CLI tools (~250MB)
- `minimal` — No extra CLI tools (~150MB, add with `--target minimal`)

---

## 4.2 docker-compose.yml

**File: `docker-compose.yml`**

```yaml
version: '3.8'

services:
  mu:
    build: .
    container_name: mu
    ports:
      - "${MU_BOT_PORT:-3141}:3141"
    environment:
      - MU_BOT_API_KEY=${MU_BOT_API_KEY}
      - MU_BOT_API_BASE_URL=${MU_BOT_API_BASE_URL:-https://api.openai.com/v1}
      - MU_BOT_MODEL=${MU_BOT_MODEL:-gpt-4o}
      - MU_BOT_MAX_STEPS=${MU_BOT_MAX_STEPS:-50}
      - MU_BOT_PERMISSION_MODE=${MU_BOT_PERMISSION_MODE:-auto}
      - MU_BOT_WEB_ENABLED=true
    volumes:
      # Project workspace (read-write)
      - ${MU_BOT_WORKSPACE:-./workspace}:/workspace
      # Persist logs and sessions
      - mu-data:/home/mu/.mu
    working_dir: /workspace
    restart: unless-stopped
    # Resource limits
    deploy:
      resources:
        limits:
          cpus: '2.0'
          memory: 2G
        reservations:
          cpus: '0.5'
          memory: 256M

volumes:
  mu-data:
```

Usage:
```bash
cp .env.example .env
# Edit .env with your API key
docker compose up -d
open http://localhost:3141
```

---

## 4.3 Container Security

### Non-root execution
- User `mu` (UID 1000) runs the process
- `/app` is owned by root (read-only runtime)
- `/home/mu/.mu/` is writable for logs/sessions
- `/workspace` is the mounted project directory

### Read-only root filesystem (optional hardened mode)
```yaml
# docker-compose.override.yml for hardened mode
services:
  mu:
    read_only: true
    tmpfs:
      - /tmp:size=100M
    security_opt:
      - no-new-privileges:true
```

### Resource limits
- CPU: 2 cores max
- Memory: 2GB max
- PIDs: 256 max (prevents fork bombs)
- No privileged mode
- No host network by default

### Considerations
The agent has shell access by design. Container isolation is the primary security boundary. The container should NOT mount sensitive host directories (like `/`, `/etc`, `~/.ssh`). The workspace mount should be scoped to the project directory only.

---

## 4.4 Host Access Patterns

### Local development (full access)
```bash
docker run -it --rm \
  -v $(pwd):/workspace \
  -e MU_BOT_API_KEY=$MU_BOT_API_KEY \
  mu "refactor this project"
```

### Sandboxed mode (restricted)
```bash
docker run -it --rm \
  --read-only \
  --tmpfs /tmp:size=100M \
  --network none \
  -v $(pwd):/workspace:ro \
  -e MU_BOT_API_KEY=$MU_BOT_API_KEY \
  mu "analyze this codebase"
```

### With host network (for accessing local services)
```bash
docker run -it --rm \
  --network host \
  -v $(pwd):/workspace \
  -e MU_BOT_API_KEY=$MU_BOT_API_KEY \
  mu --web
```

### Docker-in-Docker (agent can manage containers)
```bash
docker run -it --rm \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v $(pwd):/workspace \
  -e MU_BOT_API_KEY=$MU_BOT_API_KEY \
  mu "deploy this with docker compose"
```

---

## 4.5 .env.example

**File: `.env.example`**

```bash
# Required
MU_BOT_API_KEY=sk-your-api-key-here

# Optional - API Configuration
MU_BOT_API_BASE_URL=https://api.openai.com/v1
MU_BOT_MODEL=gpt-4o

# Optional - Agent Behavior
MU_BOT_MAX_STEPS=50
MU_BOT_TEMPERATURE=0
MU_BOT_PERMISSION_MODE=auto
# MU_BOT_SYSTEM_PROMPT="You are a helpful coding assistant."
# MU_BOT_SYSTEM_PROMPT_FILE=./system-prompt.md

# Optional - Web UI
MU_BOT_WEB_ENABLED=false
MU_BOT_PORT=3141

# Optional - Logging
MU_BOT_LOG_LEVEL=verbose
MU_BOT_LOG_DIR=~/.mu/logs

# Optional - Limits
MU_BOT_MAX_OUTPUT_LENGTH=50000
# MU_BOT_COST_LIMIT_USD=5.00

# Optional - MCP Servers (JSON array)
# MU_BOT_MCP_SERVERS='[{"name":"fs","transport":"stdio","config":{"command":"mcp-fs-server"}}]'
```

---

## 4.6 Health Check Endpoint

**File: `src/web/server.ts` (addition)**

```typescript
app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    uptime: process.uptime(),
    version: pkg.version,
    model: config.model,
    activeSessions: sessionStore.count(),
  });
});
```

Used by Docker HEALTHCHECK and external monitoring.

---

## 4.7 Graceful Shutdown

**File: `src/shutdown.ts`**

```typescript
export function setupGracefulShutdown(cleanup: () => Promise<void>) {
  let shutting = false;

  const handler = async (signal: string) => {
    if (shutting) return;
    shutting = true;
    logger.info(`Received ${signal}, shutting down...`);

    // 1. Stop accepting new requests
    // 2. Wait for in-flight tool calls (with timeout)
    // 3. Flush logs
    // 4. Close MCP connections
    await Promise.race([
      cleanup(),
      new Promise(resolve => setTimeout(resolve, 10_000)), // 10s max
    ]);

    process.exit(0);
  };

  process.on('SIGTERM', () => handler('SIGTERM'));
  process.on('SIGINT', () => handler('SIGINT'));
}
```

Handles:
- SIGTERM from Docker/Kubernetes
- SIGINT from Ctrl+C
- Ensures JSONL logs are flushed before exit
- Closes MCP client connections
- Aborts in-flight tool calls via AbortController

---

## 4.8 CI/CD Configuration

**File: `.github/workflows/ci.yml`**

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm build
      - run: pnpm test

  docker:
    needs: test
    runs-on: ubuntu-latest
    if: github.ref == 'refs/heads/main'
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-qemu-action@v3
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - uses: docker/build-push-action@v6
        with:
          push: true
          platforms: linux/amd64,linux/arm64
          tags: |
            ghcr.io/${{ github.repository }}:latest
            ghcr.io/${{ github.repository }}:${{ github.sha }}
          cache-from: type=gha
          cache-to: type=gha,mode=max
```

---

## 4.9 Multi-Arch Builds

Support both AMD64 (x86) and ARM64 (Apple Silicon, Graviton) via:
- Docker buildx with QEMU emulation
- `node:22-slim` base image (already multi-arch)
- No native dependencies that would break cross-compilation

---

## 4.10 README & Quickstart

**File: `README.md`**

Sections:
1. What is mu (one paragraph)
2. Quickstart (3 commands: install, configure, run)
3. CLI usage with examples
4. Web UI screenshot/description
5. Docker deployment
6. Configuration reference table
7. Tool list with descriptions
8. MCP integration
9. Architecture overview (link to PRD)
10. Contributing

---

## Acceptance Criteria

| Test | Expected |
|------|----------|
| `docker build .` | Builds successfully |
| `docker compose up` | Container starts, web UI accessible |
| `docker run mu "echo hello"` | Headless mode works in container |
| Container restart | Logs and sessions persisted via volume |
| SIGTERM | Graceful shutdown within 10s |
| `/health` endpoint | Returns 200 with status |
| No root processes | `ps` shows mu user |
| Resource limits | Container can't exceed 2GB RAM |
| Multi-arch | Image runs on both AMD64 and ARM64 |
| `docker compose down && docker compose up` | Sessions survive restart |

---

## Estimated File Count

| Directory | Files | Purpose |
|-----------|-------|---------|
| Root | 5 | Dockerfile, docker-compose.yml, .env.example, .dockerignore, README.md |
| `.github/workflows/` | 1 | ci.yml |
| `src/` | 1 | shutdown.ts |
| **Total new** | **~7 files** | |
