#!/usr/bin/env node

import 'dotenv/config';
import { Command } from 'commander';
import { loadConfig, type CliFlags } from './config.js';
import { createLogger, sessionStartEvent, userMessageEvent, sessionEndEvent } from './logger.js';
import { createToolSet, addExternalTools } from './tools/index.js';
import { createAgent } from './agent.js';
import { createRenderer } from './cli/renderer.js';
import { runRepl } from './cli/repl.js';
import { loadMCPTools } from './mcp/client.js';
import { createWebServer } from './web/server.js';
import { setupGracefulShutdown } from './shutdown.js';

// ── CLI ────────────────────────────────────────────────────────────

const program = new Command()
  .name('mu')
  .description('AI agent with full local machine access')
  .version('0.1.0')
  .argument('[prompt]', 'Prompt to send to the agent')
  .option('-m, --model <model>', 'Model identifier')
  .option('-b, --base-url <url>', 'API base URL')
  .option('-k, --api-key <key>', 'API key')
  .option('-s, --max-steps <n>', 'Max tool loop steps')
  .option('-v, --verbose', 'Verbose output')
  .option('-d, --debug', 'Debug output')
  .option('-w, --web', 'Enable web UI')
  .option('-p, --port <port>', 'Web UI port')
  .option('--permission <mode>', 'Permission mode: default|auto|plan|approve-destructive')
  .option('--output <format>', 'Output format: text|json|ndjson')
  .option('--tools <tools>', 'Comma-separated list of tool names to enable')
  .option('-c, --config <path>', 'Config file path')
  .action(async (prompt: string | undefined, opts: CliFlags) => {
    try {
      const config = loadConfig(opts);
      const logger = createLogger(config);
      const tools = createToolSet(config, logger);

      // Load MCP tools if configured
      if (config.mcpServers && config.mcpServers.length > 0) {
        const mcpTools = await loadMCPTools(config, logger);
        addExternalTools(mcpTools, tools);
      }

      const agent = createAgent(config, tools, logger);
      const renderer = createRenderer(config);

      logger.log(sessionStartEvent(logger.sessionId, config.model, config.maxSteps));

      // Graceful shutdown with MCP cleanup
      setupGracefulShutdown(logger, async () => {
        if (config.mcpServers && config.mcpServers.length > 0) {
          logger.info('Cleaning up MCP connections…');
        }
      });

      // Start web UI if enabled
      if (config.webUiEnabled) {
        const webServer = createWebServer(config, tools, logger);
        webServer.start();
        if (!prompt) {
          // In web-only mode, keep the process alive
          console.log('\x1b[90mPress Ctrl+C to stop\x1b[0m');
          await new Promise(() => {}); // Block forever
          return;
        }
      }

      if (prompt) {
        await runHeadless(prompt, config, agent, logger, renderer);
      } else {
        await runRepl(config, agent, logger, renderer);
      }
    } catch (err: any) {
      console.error(`\x1b[31m❌ ${err.message}\x1b[0m`);
      process.exit(1);
    }
  });

program.parse();

// ── Headless Mode ──────────────────────────────────────────────────

async function runHeadless(
  prompt: string,
  config: ReturnType<typeof loadConfig>,
  agent: { generate: (prompt: string, callbacks?: any) => Promise<any> },
  logger: ReturnType<typeof createLogger>,
  renderer: ReturnType<typeof createRenderer>,
) {
  const sessionStart = performance.now();

  renderer.banner(config.model, config.maxSteps, logger.sessionId);
  logger.log(userMessageEvent(prompt));
  renderer.thinking();

  let hasText = false;

  const result = await agent.generate(prompt, {
    onToolCall(stepNumber: number, toolName: string, input: unknown) {
      renderer.stopThinking();
      renderer.toolCall(toolName, input);
      renderer.thinking('Running');
    },
    onToolResult(stepNumber: number, toolName: string, output: string) {
      renderer.stopThinking();
      renderer.toolResult(toolName, output, Math.round(performance.now() - sessionStart));
    },
    onStepFinish(stepNumber: number, finishReason: string, usage: { inputTokens: number; outputTokens: number }) {
      renderer.stepFinish(stepNumber, finishReason, usage);
    },
    onText(text: string) {
      renderer.stopThinking();
      if (!hasText) {
        renderer.modelText(text);
        hasText = true;
      }
    },
  });

  renderer.stopThinking();

  const usage = result.usage ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  const steps = result.steps?.length ?? 1;
  const totalDurationMs = Math.round(performance.now() - sessionStart);

  logger.log(sessionEndEvent(steps, usage.totalTokens, totalDurationMs));

  const logFile = config.logToFile ? `~/.mu/logs/${logger.sessionId}.jsonl` : undefined;
  renderer.done(steps, usage.totalTokens, totalDurationMs, logger.sessionId, logFile);

  process.exit(0);
}
