import { z } from 'zod';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { buildTool } from './build-tool.js';

const InputSchema = z.object({
  path: z.string().describe('Absolute or relative path to the file to edit'),
  oldContent: z.string().describe('The exact text to find and replace (must appear exactly once)'),
  newContent: z.string().describe('The replacement text'),
});

export const fileEdit = buildTool({
  name: 'file_edit',
  description: 'Edit a file by replacing an exact string occurrence. oldContent must appear exactly once in the file. Returns a unified diff of the change.',
  inputSchema: InputSchema,
  isReadOnly: false,
  isDestructive: true,
  timeoutMs: 10_000,
  categories: ['filesystem'],

  async execute(input: z.infer<typeof InputSchema>) {
    const start = performance.now();
    const filePath = resolve(input.path);

    try {
      const original = readFileSync(filePath, 'utf-8');
      const occurrences = original.split(input.oldContent).length - 1;

      if (occurrences === 0) {
        return {
          output: null,
          error: `oldContent not found in ${filePath}`,
          durationMs: Math.round(performance.now() - start),
        };
      }
      if (occurrences > 1) {
        return {
          output: null,
          error: `oldContent found ${occurrences} times in ${filePath} — must appear exactly once`,
          durationMs: Math.round(performance.now() - start),
        };
      }

      const updated = original.replace(input.oldContent, input.newContent);
      writeFileSync(filePath, updated, 'utf-8');

      // Simple diff output
      const diff = [
        `--- a/${input.path}`,
        `+++ b/${input.path}`,
        ...input.oldContent.split('\n').map(l => `- ${l}`),
        ...input.newContent.split('\n').map(l => `+ ${l}`),
      ].join('\n');

      return {
        output: { path: filePath, diff },
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
