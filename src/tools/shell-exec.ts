import { z } from 'zod';
import { execFile } from 'node:child_process';
import { buildTool } from './build-tool.js';

const InputSchema = z.object({
  command: z.string().describe('The shell command to execute'),
  cwd: z.string().optional().describe('Working directory for the command'),
  timeoutMs: z.number().int().optional().describe('Timeout in milliseconds (default: 30000)'),
});

export const shellExec = buildTool({
  name: 'shell_exec',
  description: 'Execute a shell command on the host machine. Returns stdout, stderr, and exit code.',
  inputSchema: InputSchema,
  isReadOnly: false,
  isDestructive: false,
  timeoutMs: 60_000,

  async execute(input: z.infer<typeof InputSchema>) {
    const timeout = input.timeoutMs ?? 30_000;

    return new Promise<{ output: unknown; error?: string; durationMs: number }>((resolve) => {
      const start = performance.now();

      const child = execFile(
        '/bin/bash',
        ['-c', input.command],
        {
          cwd: input.cwd ?? process.cwd(),
          timeout,
          maxBuffer: 1024 * 1024, // 1MB
          env: process.env,
        },
        (err, stdout, stderr) => {
          const durationMs = Math.round(performance.now() - start);
          const exitCode = err && 'code' in err ? (err as any).code : (err ? 1 : 0);

          resolve({
            output: {
              stdout: stdout.toString(),
              stderr: stderr.toString(),
              exitCode: typeof exitCode === 'number' ? exitCode : (err ? 1 : 0),
              durationMs,
            },
            error: err && (err as any).killed ? `Command timed out after ${timeout}ms` : undefined,
            durationMs,
          });
        },
      );
    });
  },
});
