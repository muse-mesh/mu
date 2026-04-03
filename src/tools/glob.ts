import { z } from 'zod';
import { readdir, stat } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';
import { buildTool } from './build-tool.js';

const InputSchema = z.object({
  pattern: z.string().describe('Glob-like pattern to match files (e.g. "**/*.ts", "src/*.js")'),
  cwd: z.string().optional().describe('Base directory for the search (default: process.cwd())'),
  ignore: z.array(z.string()).optional().describe('Patterns to ignore (default: node_modules, .git)'),
});

// Simple glob matching without external deps
function matchGlob(pattern: string, filepath: string): boolean {
  // Convert glob to regex
  const regexStr = pattern
    .replace(/\./g, '\\.')
    .replace(/\*\*/g, '§DOUBLESTAR§')
    .replace(/\*/g, '[^/]*')
    .replace(/§DOUBLESTAR§/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${regexStr}$`).test(filepath);
}

async function walkDir(dir: string, base: string, ignoreSet: Set<string>): Promise<string[]> {
  const results: string[] = [];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const name = entry.name;
      if (ignoreSet.has(name)) continue;
      const fullPath = join(dir, name);
      const relPath = relative(base, fullPath);
      if (entry.isDirectory()) {
        results.push(...await walkDir(fullPath, base, ignoreSet));
      } else {
        results.push(relPath);
      }
    }
  } catch {
    // Skip unreadable directories
  }
  return results;
}

export const globTool = buildTool({
  name: 'glob',
  description: 'Find files matching a glob pattern. Returns a list of matching file paths.',
  inputSchema: InputSchema,
  isReadOnly: true,
  isDestructive: false,
  timeoutMs: 15_000,
  categories: ['filesystem'],

  async execute(input: z.infer<typeof InputSchema>) {
    const start = performance.now();
    const base = resolve(input.cwd ?? process.cwd());
    const ignoreSet = new Set(input.ignore ?? ['node_modules', '.git', 'dist', '.next']);

    try {
      const allFiles = await walkDir(base, base, ignoreSet);
      const matches = allFiles.filter(f => matchGlob(input.pattern, f));

      return {
        output: { matches, count: matches.length, cwd: base },
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
