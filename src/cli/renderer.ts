import type { MuConfig } from '../config.js';

// ── ANSI Helpers ───────────────────────────────────────────────────

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const ITALIC = '\x1b[3m';
const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const GRAY = '\x1b[90m';
const BLUE = '\x1b[34m';
const MAGENTA = '\x1b[35m';
const WHITE = '\x1b[37m';
const BG_RED = '\x1b[41m';

// Box-drawing chars
const TOP_LEFT = '╭';
const TOP_RIGHT = '╮';
const BOT_LEFT = '╰';
const BOT_RIGHT = '╯';
const HORIZ = '─';
const VERT = '│';

// Spinner frames
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

// ── Renderer ───────────────────────────────────────────────────────

export interface Renderer {
  banner(model: string, maxSteps: number, sessionId: string): void;
  stepStart(stepNumber: number): void;
  toolCall(toolName: string, input: unknown): void;
  toolResult(toolName: string, output: string, durationMs: number, error?: string): void;
  modelText(text: string): void;
  textStart(): void;
  textChunk(chunk: string): void;
  textEnd(): void;
  thinking(label?: string): void;
  stopThinking(): void;
  stepFinish(stepNumber: number, finishReason: string, usage: { inputTokens: number; outputTokens: number }): void;
  done(totalSteps: number, totalTokens: number, totalDurationMs: number, sessionId: string, logFile?: string): void;
  error(msg: string): void;
  info(msg: string): void;
  warn(msg: string): void;
}

export function createRenderer(config: MuConfig): Renderer {
  const level = config.logLevel;
  const isQuiet = level === 'quiet';
  const isVerbose = level === 'verbose' || level === 'debug';

  // NDJSON mode — structured output, no decorations
  if (config.outputFormat === 'ndjson') {
    return createNdjsonRenderer();
  }

  let spinnerTimer: ReturnType<typeof setInterval> | null = null;
  let spinnerFrame = 0;
  let spinnerLabel = '';

  return {
    banner(model, maxSteps, sessionId) {
      if (isQuiet) return;
      const w = 55;
      const title = ` mu `;
      const padLen = Math.max(0, w - title.length - 2);
      console.log();
      console.log(`  ${DIM}${TOP_LEFT}${HORIZ}${RESET}${BOLD}${CYAN}${title}${RESET}${DIM}${HORIZ.repeat(padLen)}${TOP_RIGHT}${RESET}`);
      console.log(`  ${DIM}${VERT}${RESET} Model: ${CYAN}${BOLD}${model}${RESET}${' '.repeat(Math.max(0, w - 10 - model.length))}${DIM}${VERT}${RESET}`);
      console.log(`  ${DIM}${VERT}${RESET} Steps: ${WHITE}${maxSteps}${RESET}  ${DIM}│${RESET}  Session: ${DIM}${sessionId.slice(0, 8)}${RESET}${' '.repeat(Math.max(0, w - 35 - String(maxSteps).length))}${DIM}${VERT}${RESET}`);
      console.log(`  ${DIM}${BOT_LEFT}${HORIZ.repeat(w)}${BOT_RIGHT}${RESET}`);
      console.log();
    },

    stepStart(stepNumber) {
      if (isQuiet) return;
      console.log(`  ${BLUE}${BOLD}Step ${stepNumber + 1}${RESET} ${DIM}${HORIZ.repeat(48)}${RESET}`);
    },

    toolCall(toolName, input) {
      if (isQuiet) return;
      // Stop any active spinner
      this.stopThinking();
      console.log(`  ${CYAN}⚡${RESET} ${BOLD}${toolName}${RESET}`);
      if (isVerbose) {
        const inputStr = typeof input === 'string' ? input : JSON.stringify(input ?? {}, null, 2);
        const indented = inputStr.split('\n').map(l => `     ${DIM}${l}${RESET}`).join('\n');
        console.log(indented);
      }
    },

    toolResult(_toolName, output, durationMs, error) {
      if (isQuiet) return;
      if (error) {
        console.log(`     ${RED}✗ Error: ${error}${RESET}  ${DIM}(${durationMs}ms)${RESET}`);
        return;
      }
      if (isVerbose) {
        const displayOutput = output.length > 2000
          ? output.slice(0, 2000) + `\n     ${DIM}...[truncated]${RESET}`
          : output;
        const indented = displayOutput.split('\n').map(l => `     ${DIM}${l}${RESET}`).join('\n');
        console.log(indented);
      }
      const durStr = durationMs > 0 ? ` ${DIM}(${durationMs}ms)${RESET}` : '';
      console.log(`     ${GREEN}✓${RESET}${durStr}`);
    },

    modelText(text) {
      if (isQuiet) {
        process.stdout.write(text);
        return;
      }
      this.stopThinking();
      console.log();
      console.log(`  ${GREEN}${BOLD}Response${RESET}`);
      console.log(`  ${DIM}${HORIZ.repeat(52)}${RESET}`);
      const indented = text.split('\n').map(l => `  ${l}`).join('\n');
      console.log(indented);
      console.log();
    },

    textStart() {
      if (isQuiet) return;
      this.stopThinking();
      console.log();
      console.log(`  ${GREEN}${BOLD}Response${RESET}`);
      console.log(`  ${DIM}${HORIZ.repeat(52)}${RESET}`);
      process.stdout.write('  ');
    },

    textChunk(chunk) {
      if (isQuiet) {
        process.stdout.write(chunk);
        return;
      }
      // Handle newlines in streaming output
      const formatted = chunk.replace(/\n/g, '\n  ');
      process.stdout.write(formatted);
    },

    textEnd() {
      if (isQuiet) return;
      console.log();
      console.log();
    },

    thinking(label = 'Thinking') {
      if (isQuiet) return;
      spinnerLabel = label;
      spinnerFrame = 0;
      if (spinnerTimer) clearInterval(spinnerTimer);
      process.stdout.write(`  ${DIM}${SPINNER_FRAMES[0]} ${spinnerLabel}...${RESET}`);
      spinnerTimer = setInterval(() => {
        spinnerFrame = (spinnerFrame + 1) % SPINNER_FRAMES.length;
        process.stdout.write(`\r  ${DIM}${SPINNER_FRAMES[spinnerFrame]} ${spinnerLabel}...${RESET}`);
      }, 80);
    },

    stopThinking() {
      if (spinnerTimer) {
        clearInterval(spinnerTimer);
        spinnerTimer = null;
        process.stdout.write('\r\x1b[2K'); // Clear the spinner line
      }
    },

    stepFinish(stepNumber, finishReason, usage) {
      if (isQuiet) return;
      console.log(`  ${DIM}  ↑ ${usage.inputTokens.toLocaleString()}  ↓ ${usage.outputTokens.toLocaleString()}  │  ${finishReason}${RESET}`);
      console.log();
    },

    done(totalSteps, totalTokens, totalDurationMs, sessionId, logFile) {
      if (isQuiet) {
        console.log();
        return;
      }
      this.stopThinking();
      const secs = (totalDurationMs / 1000).toFixed(1);
      const w = 55;
      console.log(`  ${DIM}${TOP_LEFT}${HORIZ} Done ${HORIZ.repeat(w - 7)}${TOP_RIGHT}${RESET}`);
      console.log(`  ${DIM}${VERT}${RESET} ${BOLD}${totalSteps}${RESET} steps ${DIM}│${RESET} ${BOLD}${totalTokens.toLocaleString()}${RESET} tokens ${DIM}│${RESET} ${BOLD}${secs}s${RESET}`);
      if (logFile) {
        console.log(`  ${DIM}${VERT} Log: ${logFile}${RESET}`);
      }
      console.log(`  ${DIM}${BOT_LEFT}${HORIZ.repeat(w)}${BOT_RIGHT}${RESET}`);
      console.log();
    },

    error(msg) {
      console.error(`  ${RED}${BOLD}✗${RESET} ${RED}${msg}${RESET}`);
    },

    info(msg) {
      if (isQuiet) return;
      console.log(`  ${BLUE}ℹ${RESET} ${msg}`);
    },

    warn(msg) {
      if (isQuiet) return;
      console.log(`  ${YELLOW}⚠${RESET} ${msg}`);
    },
  };
}

// ── NDJSON Renderer ────────────────────────────────────────────────

function createNdjsonRenderer(): Renderer {
  function emit(obj: Record<string, unknown>) {
    process.stdout.write(JSON.stringify(obj) + '\n');
  }

  return {
    banner(model, maxSteps, sessionId) {
      emit({ type: 'session_start', model, maxSteps, sessionId });
    },
    stepStart(stepNumber) {
      emit({ type: 'step_start', stepNumber });
    },
    toolCall(toolName, input) {
      emit({ type: 'tool_call', toolName, input });
    },
    toolResult(toolName, output, durationMs, error) {
      emit({ type: 'tool_result', toolName, output, durationMs, error });
    },
    modelText(text) {
      emit({ type: 'model_text', text });
    },
    textStart() { /* noop for ndjson */ },
    textChunk(text) {
      emit({ type: 'text_chunk', text });
    },
    textEnd() { /* noop for ndjson */ },
    thinking() { /* noop for ndjson */ },
    stopThinking() { /* noop for ndjson */ },
    stepFinish(stepNumber, finishReason, usage) {
      emit({ type: 'step_finish', stepNumber, finishReason, usage });
    },
    done(totalSteps, totalTokens, totalDurationMs, sessionId) {
      emit({ type: 'session_end', totalSteps, totalTokens, totalDurationMs, sessionId });
    },
    error(msg) {
      emit({ type: 'error', message: msg });
    },
    info(msg) {
      emit({ type: 'info', message: msg });
    },
    warn(msg) {
      emit({ type: 'warning', message: msg });
    },
  };
}
