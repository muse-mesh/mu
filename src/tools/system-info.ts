import { z } from 'zod';
import { hostname, platform, arch, release, cpus, totalmem, freemem } from 'node:os';
import { buildTool } from './build-tool.js';

const InputSchema = z.object({});

export const systemInfo = buildTool({
  name: 'system_info',
  description: 'Returns system information: OS, architecture, hostname, cwd, Node version, and resource usage.',
  inputSchema: InputSchema,
  isReadOnly: true,
  isDestructive: false,
  timeoutMs: 5_000,
  categories: ['system'],

  async execute() {
    const start = performance.now();

    return {
      output: {
        hostname: hostname(),
        platform: platform(),
        arch: arch(),
        release: release(),
        nodeVersion: process.version,
        cwd: process.cwd(),
        cpuCount: cpus().length,
        totalMemoryMB: Math.round(totalmem() / 1024 / 1024),
        freeMemoryMB: Math.round(freemem() / 1024 / 1024),
        uptime: Math.round(process.uptime()),
      },
      durationMs: Math.round(performance.now() - start),
    };
  },
});
