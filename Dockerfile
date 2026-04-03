# ── Stage 1: Build ───────────────────────────────────────
FROM node:22-slim AS build

RUN corepack enable && corepack prepare pnpm@10.30.1 --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

# ── Stage 2: Production ─────────────────────────────────
FROM node:22-slim

# Common CLI tools the agent may need
RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl wget jq ripgrep tree python3 \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@10.30.1 --activate

# Create non-root user with home dir
RUN groupadd -r mu && useradd -r -g mu -m -d /home/mu mu

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod

COPY --from=build /app/dist ./dist
COPY --from=build /app/web/dist ./web/dist

# App code owned by root → read-only for mu user
RUN chown -R root:root /app && chmod -R 755 /app

# Writable dirs for mu user
RUN mkdir -p /home/mu/.mu/logs /home/mu/.mu/sessions /home/mu/.mu/memory \
    && chown -R mu:mu /home/mu

USER mu

# Working directory is system root — agent can browse the whole filesystem
# but cannot write to /app (its own code)
WORKDIR /

ENV MU_BOT_WEB_UI_ENABLED=true
EXPOSE 3141

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:3141/api/health || exit 1

ENTRYPOINT ["node", "/app/dist/index.js"]
CMD ["--web"]
