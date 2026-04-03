import { z } from 'zod';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { buildTool } from './build-tool.js';

const InputSchema = z.object({
  path: z.string().describe('Absolute or relative path to the file to read'),
  startLine: z.number().int().min(1).optional().describe('First line to read (1-based, inclusive)'),
  endLine: z.number().int().min(1).optional().describe('Last line to read (1-based, inclusive)'),
});

export const fileRead = buildTool({
  name: 'file_read',
  description: 'Read the contents of a file. Supports optional line range.',
  inputSchema: InputSchema,
  isReadOnly: true,
  isDestructive: false,
  timeoutMs: 10_000,

  async execute(input: z.infer<typeof InputSchema>) {
    const start = performance.now();
    const filePath = resolve(input.path);

    try {
      const info = await stat(filePath);
      if (!info.isFile()) {
        return { output: null, error: `Not a file: ${filePath}`, durationMs: Math.round(performance.now() - start) };
      }

      const raw = await readFile(filePath, 'utf-8');
      const lines = raw.split('\n');
      const totalLines = lines.length;

      let content: string;
      if (input.startLine || input.endLine) {
        const s = (input.startLine ?? 1) - 1;
        const e = input.endLine ?? totalLines;
        content = lines.slice(s, e).join('\n');
      } else {
        content = raw;
      }

      return {
        output: { content, totalLines, path: filePath },
        durationMs: Math.round(performance.now() - start),
      };
    } catch (err: any) {
      return {
        output: null,
        error: err.code === 'ENOENT' ? `File not found: ${filePath}` : err.message,
        durationMs: Math.round(performance.now() - start),
      };
    }
  },
});
