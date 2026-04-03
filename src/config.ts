import { z } from 'zod';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';

// ── Schema ─────────────────────────────────────────────────────────

const ConfigSchema = z.object({
  apiBaseUrl: z.url().default('https://api.openai.com/v1'),
  apiKey: z.string().min(1, 'API key is required (set MU_BOT_API_KEY or --api-key)'),
  model: z.string().default('gpt-4o'),
  maxSteps: z.number().int().min(1).max(500).default(50),
  loopMode: z.enum(['agent', 'manual']).default('agent'),
  temperature: z.number().min(0).max(2).default(0),
  logLevel: z.enum(['quiet', 'normal', 'verbose', 'debug']).default('verbose'),
  logDir: z.string().default(join(homedir(), '.mu', 'logs')),
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
  mcpServers: z.array(z.object({
    name: z.string(),
    transport: z.enum(['stdio', 'sse', 'http']),
    config: z.object({
      command: z.string().optional(),
      args: z.array(z.string()).optional(),
      url: z.string().optional(),
    }),
  })).optional(),
});

export type MuConfig = z.infer<typeof ConfigSchema>;

// ── Env Loader ─────────────────────────────────────────────────────

function envOverrides(): Record<string, unknown> {
  const env = process.env;
  const overrides: Record<string, unknown> = {};

  if (env.MU_BOT_API_KEY) overrides.apiKey = env.MU_BOT_API_KEY;
  if (env.MU_BOT_API_BASE_URL) overrides.apiBaseUrl = env.MU_BOT_API_BASE_URL;
  if (env.MU_BOT_MODEL) overrides.model = env.MU_BOT_MODEL;
  if (env.MU_BOT_MAX_STEPS) overrides.maxSteps = Number(env.MU_BOT_MAX_STEPS);
  if (env.MU_BOT_LOOP_MODE) overrides.loopMode = env.MU_BOT_LOOP_MODE;
  if (env.MU_BOT_TEMPERATURE) overrides.temperature = Number(env.MU_BOT_TEMPERATURE);
  if (env.MU_BOT_LOG_LEVEL) overrides.logLevel = env.MU_BOT_LOG_LEVEL;
  if (env.MU_BOT_LOG_DIR) overrides.logDir = env.MU_BOT_LOG_DIR;
  if (env.MU_BOT_LOG_TO_FILE) overrides.logToFile = env.MU_BOT_LOG_TO_FILE === 'true';
  if (env.MU_BOT_OUTPUT_FORMAT) overrides.outputFormat = env.MU_BOT_OUTPUT_FORMAT;
  if (env.MU_BOT_PERMISSION_MODE) overrides.permissionMode = env.MU_BOT_PERMISSION_MODE;
  if (env.MU_BOT_WEB_UI_ENABLED) overrides.webUiEnabled = env.MU_BOT_WEB_UI_ENABLED === 'true';
  if (env.MU_BOT_WEB_UI_PORT) overrides.webUiPort = Number(env.MU_BOT_WEB_UI_PORT);
  if (env.MU_BOT_MAX_OUTPUT_LENGTH) overrides.maxOutputLength = Number(env.MU_BOT_MAX_OUTPUT_LENGTH);
  if (env.MU_BOT_COST_LIMIT_USD) overrides.costLimitUsd = Number(env.MU_BOT_COST_LIMIT_USD);
  if (env.MU_BOT_SYSTEM_PROMPT) overrides.systemPrompt = env.MU_BOT_SYSTEM_PROMPT;
  if (env.MU_BOT_SYSTEM_PROMPT_FILE) overrides.systemPromptFile = env.MU_BOT_SYSTEM_PROMPT_FILE;

  return overrides;
}

// ── Config File Loader ─────────────────────────────────────────────

function loadConfigFile(explicitPath?: string): Record<string, unknown> {
  const candidates = explicitPath
    ? [resolve(explicitPath)]
    : [
        resolve(process.cwd(), '.mu.json'),
        resolve(homedir(), '.mu.json'),
      ];

  for (const p of candidates) {
    if (existsSync(p)) {
      try {
        return JSON.parse(readFileSync(p, 'utf-8'));
      } catch {
        // Skip malformed config files
      }
    }
  }
  return {};
}

// ── System Prompt Loader ───────────────────────────────────────────

function resolveSystemPrompt(config: MuConfig): string {
  if (config.systemPrompt) return config.systemPrompt;
  if (config.systemPromptFile && existsSync(config.systemPromptFile)) {
    return readFileSync(config.systemPromptFile, 'utf-8');
  }
  return DEFAULT_SYSTEM_PROMPT;
}

export const DEFAULT_SYSTEM_PROMPT = `You are mu, an AI agent with full access to the local machine via tools.

## Capabilities
- Execute shell commands (shell_exec)
- Read, write, and edit files (file_read, file_write, file_edit)
- Search code and files (grep, glob)
- List directory contents (list_dir)
- Fetch URLs (http_fetch)
- Get system information (system_info)

## Guidelines
- Think step by step before acting. Use the "think" tool to plan complex tasks.
- Read files before modifying them. Understand the current state first.
- Prefer small, incremental changes over large rewrites.
- Verify your changes work (run tests, check output).
- When done, use task_complete to signal completion with a summary.
- If you're unsure, ask the user rather than guessing.
- Never modify files outside the working directory without explicit permission.

## Error Handling
- If a command fails, read the error output carefully.
- Try a different approach rather than repeating the same failing command.
- Report persistent failures to the user with context.

## Environment
- Working directory: ${process.cwd()}
- Platform: ${process.platform} ${process.arch}
- Node.js: ${process.version}`;

// ── Main Loader ────────────────────────────────────────────────────

export interface CliFlags {
  model?: string;
  baseUrl?: string;
  maxSteps?: string;
  verbose?: boolean;
  debug?: boolean;
  web?: boolean;
  port?: string;
  permission?: string;
  output?: string;
  tools?: string;
  config?: string;
  apiKey?: string;
}

export function loadConfig(flags: CliFlags = {}): MuConfig {
  const fileConfig = loadConfigFile(flags.config);
  const envConfig = envOverrides();

  // CLI flags → highest priority
  const cliConfig: Record<string, unknown> = {};
  if (flags.model) cliConfig.model = flags.model;
  if (flags.baseUrl) cliConfig.apiBaseUrl = flags.baseUrl;
  if (flags.maxSteps) cliConfig.maxSteps = Number(flags.maxSteps);
  if (flags.verbose) cliConfig.logLevel = 'verbose';
  if (flags.debug) cliConfig.logLevel = 'debug';
  if (flags.web) cliConfig.webUiEnabled = true;
  if (flags.port) cliConfig.webUiPort = Number(flags.port);
  if (flags.permission) cliConfig.permissionMode = flags.permission;
  if (flags.output) cliConfig.outputFormat = flags.output;
  if (flags.apiKey) cliConfig.apiKey = flags.apiKey;
  if (flags.tools) cliConfig.enabledTools = flags.tools.split(',').map((s: string) => s.trim());

  // Merge: defaults ← config file ← env vars ← CLI flags
  const merged = { ...fileConfig, ...envConfig, ...cliConfig };

  const config = ConfigSchema.parse(merged);
  config.systemPrompt = resolveSystemPrompt(config);
  return config;
}
