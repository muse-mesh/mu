import { z } from 'zod';
import { readdir, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { buildTool } from './build-tool.js';

const InputSchema = z.object({
  path: z.string().describe('Directory path to list'),
  depth: z.number().int().min(1).max(5).optional().describe('Recursion depth (default: 1, max: 5)'),
});

interface DirEntry {
  name: string;
  type: 'file' | 'directory' | 'symlink' | 'other';
  size?: number;
}

async function listDirectory(dir: string, depth: number, current = 0): Promise<DirEntry[]> {
  const entries: DirEntry[] = [];
  try {
    const dirEntries = await readdir(dir, { withFileTypes: true });
    for (const entry of dirEntries) {
      const fullPath = join(dir, entry.name);
      const type = entry.isDirectory() ? 'directory'
        : entry.isSymbolicLink() ? 'symlink'
        : entry.isFile() ? 'file'
        : 'other';

      const info: DirEntry = { name: entry.name, type };
      if (type === 'file') {
        try {
          const s = await stat(fullPath);
          info.size = s.size;
        } catch { /* skip */ }
      }

      entries.push(info);

      if (type === 'directory' && current < depth - 1) {
        const children = await listDirectory(fullPath, depth, current + 1);
        for (const child of children) {
          entries.push({ ...child, name: `${entry.name}/${child.name}` });
        }
      }
    }
  } catch {
    // Skip unreadable directories
  }
  return entries;
}

export const listDir = buildTool({
  name: 'list_dir',
  description: 'List contents of a directory with file type indicators. Supports recursive listing with depth parameter.',
  inputSchema: InputSchema,
  isReadOnly: true,
  isDestructive: false,
  timeoutMs: 10_000,
  categories: ['filesystem'],

  async execute(input: z.infer<typeof InputSchema>) {
    const start = performance.now();
    const dirPath = resolve(input.path);
    const depth = input.depth ?? 1;

    try {
      const entries = await listDirectory(dirPath, depth);
      return {
        output: { path: dirPath, entries, count: entries.length },
        durationMs: Math.round(performance.now() - start),
      };
    } catch (err: any) {
      return {
        output: null,
        error: err.code === 'ENOENT' ? `Directory not found: ${dirPath}` : err.message,
        durationMs: Math.round(performance.now() - start),
      };
    }
  },
});
