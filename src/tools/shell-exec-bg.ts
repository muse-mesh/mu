import { z } from 'zod';
import { spawn } from 'node:child_process';
import { buildTool } from './build-tool.js';

// ── Background Process Registry ────────────────────────────────────
// Tracks running child processes so the agent can query/stop them later.

interface BgProcess {
  pid: number;
  command: string;
  startedAt: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
  running: boolean;
}

const bgProcesses = new Map<number, BgProcess>();

// ── shell_exec_bg ──────────────────────────────────────────────────

const StartSchema = z.object({
  action: z.literal('start').describe('Start a background process'),
  command: z.string().describe('Shell command to run in the background'),
  cwd: z.string().optional().describe('Working directory (default: current dir)'),
});

const StatusSchema = z.object({
  action: z.literal('status').describe('Get status/output of a background process'),
  pid: z.number().int().describe('PID returned when the process was started'),
});

const StopSchema = z.object({
  action: z.literal('stop').describe('Stop a background process'),
  pid: z.number().int().describe('PID of the process to stop'),
});

const ListSchema = z.object({
  action: z.literal('list').describe('List all background processes started in this session'),
});

const InputSchema = z.discriminatedUnion('action', [StartSchema, StatusSchema, StopSchema, ListSchema]);

export const shellExecBg = buildTool({
  name: 'shell_exec_bg',
  description:
    'Manage long-running background processes (servers, watchers, build daemons).\n' +
    '- action=start: Launches a command in the background, returns its PID.\n' +
    '- action=status: Retrieves accumulated stdout/stderr and running state for a PID.\n' +
    '- action=stop: Sends SIGTERM to the process.\n' +
    '- action=list: Lists all background processes started in this session.',
  inputSchema: InputSchema,
  isReadOnly: false,
  isDestructive: true,
  isBackground: true,
  timeoutMs: 10_000,
  categories: ['shell'],

  async execute(input: z.infer<typeof InputSchema>) {
    const start = performance.now();

    // ── start ──────────────────────────────────────────────────────
    if (input.action === 'start') {
      const child = spawn('/bin/bash', ['-c', input.command], {
        cwd: input.cwd ?? process.cwd(),
        env: process.env,
        detached: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      if (!child.pid) {
        return {
          output: null,
          error: 'Failed to spawn process (no PID assigned)',
          durationMs: Math.round(performance.now() - start),
        };
      }

      const rec: BgProcess = {
        pid: child.pid,
        command: input.command,
        startedAt: new Date().toISOString(),
        stdout: '',
        stderr: '',
        exitCode: null,
        signal: null,
        running: true,
      };
      bgProcesses.set(child.pid, rec);

      const MAX_BUF = 512 * 1024; // 512KB buffer per stream
      child.stdout!.on('data', (chunk: Buffer) => {
        rec.stdout += chunk.toString();
        if (rec.stdout.length > MAX_BUF) {
          rec.stdout = '…[truncated]\n' + rec.stdout.slice(-MAX_BUF);
        }
      });
      child.stderr!.on('data', (chunk: Buffer) => {
        rec.stderr += chunk.toString();
        if (rec.stderr.length > MAX_BUF) {
          rec.stderr = '…[truncated]\n' + rec.stderr.slice(-MAX_BUF);
        }
      });
      child.on('close', (code, signal) => {
        rec.exitCode = code;
        rec.signal = signal;
        rec.running = false;
      });
      child.on('error', (err) => {
        rec.stderr += `\nspawn error: ${err.message}`;
        rec.running = false;
      });

      return {
        output: {
          pid: child.pid,
          command: input.command,
          startedAt: rec.startedAt,
          message: `Process started with PID ${child.pid}. Use action=status to check output.`,
        },
        durationMs: Math.round(performance.now() - start),
      };
    }

    // ── status ─────────────────────────────────────────────────────
    if (input.action === 'status') {
      const rec = bgProcesses.get(input.pid);
      if (!rec) {
        return {
          output: null,
          error: `No background process with PID ${input.pid} found in this session.`,
          durationMs: Math.round(performance.now() - start),
        };
      }
      return {
        output: {
          pid: rec.pid,
          command: rec.command,
          running: rec.running,
          exitCode: rec.exitCode,
          signal: rec.signal,
          stdout: rec.stdout || '(no output yet)',
          stderr: rec.stderr || '',
          startedAt: rec.startedAt,
        },
        durationMs: Math.round(performance.now() - start),
      };
    }

    // ── stop ───────────────────────────────────────────────────────
    if (input.action === 'stop') {
      const rec = bgProcesses.get(input.pid);
      if (!rec) {
        return {
          output: null,
          error: `No background process with PID ${input.pid} found in this session.`,
          durationMs: Math.round(performance.now() - start),
        };
      }
      if (!rec.running) {
        return {
          output: { pid: rec.pid, message: 'Process already stopped', exitCode: rec.exitCode },
          durationMs: Math.round(performance.now() - start),
        };
      }
      try {
        process.kill(input.pid, 'SIGTERM');
        rec.running = false;
        return {
          output: { pid: input.pid, message: `SIGTERM sent to PID ${input.pid}` },
          durationMs: Math.round(performance.now() - start),
        };
      } catch (err: any) {
        return {
          output: null,
          error: `Failed to stop PID ${input.pid}: ${err.message}`,
          durationMs: Math.round(performance.now() - start),
        };
      }
    }

    // ── list ───────────────────────────────────────────────────────
    const all = [...bgProcesses.values()].map((r) => ({
      pid: r.pid,
      command: r.command,
      running: r.running,
      exitCode: r.exitCode,
      startedAt: r.startedAt,
    }));
    return {
      output: all.length ? all : 'No background processes started in this session.',
      durationMs: Math.round(performance.now() - start),
    };
  },
});
