import { z } from 'zod';
import { writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { buildTool } from './build-tool.js';

const InputSchema = z.object({
  path: z.string().describe('Absolute or relative path to write the file to'),
  content: z.string().describe('The content to write to the file'),
});

export const fileWrite = buildTool({
  name: 'file_write',
  description: 'Write content to a file. Creates parent directories if needed.',
  inputSchema: InputSchema,
  isReadOnly: false,
  isDestructive: true,
  timeoutMs: 10_000,

  async execute(input: z.infer<typeof InputSchema>) {
    const start = performance.now();
    const filePath = resolve(input.path);

    try {
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, input.content, 'utf-8');
      const bytesWritten = Buffer.byteLength(input.content, 'utf-8');

      return {
        output: { path: filePath, bytesWritten },
        durationMs: Math.round(performance.now() - start),
      };
    } catch (err: any) {
      return {
        output: null,
        error: err.message,
        durationMs: Math.round(performance.now() - start),
      };
    }
  },
});
