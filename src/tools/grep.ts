import { z } from 'zod';
import { readdir, readFile } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';
import { execFile } from 'node:child_process';
import { buildTool } from './build-tool.js';

const InputSchema = z.object({
  pattern: z.string().describe('Regex pattern to search for'),
  path: z.string().optional().describe('Directory or file to search in (default: cwd)'),
  include: z.string().optional().describe('File glob to include (e.g. "*.ts")'),
  exclude: z.string().optional().describe('File glob to exclude (e.g. "*.test.ts")'),
  maxResults: z.number().int().optional().describe('Max results to return (default: 50)'),
});

interface GrepMatch {
  file: string;
  line: number;
  content: string;
}

// Try ripgrep first, fall back to Node.js implementation
async function tryRipgrep(
  pattern: string,
  searchPath: string,
  include?: string,
  exclude?: string,
  maxResults?: number,
): Promise<GrepMatch[] | null> {
  return new Promise((resolve) => {
    const args = ['--line-number', '--no-heading', '--color=never'];
    if (include) args.push('--glob', include);
    if (exclude) args.push('--glob', `!${exclude}`);
    args.push('--glob', '!node_modules', '--glob', '!.git');
    if (maxResults) args.push('--max-count', String(maxResults));
    args.push(pattern, searchPath);

    execFile('rg', args, { maxBuffer: 1024 * 1024, timeout: 10_000 }, (err, stdout) => {
      if (err && !stdout) {
        resolve(null); // rg not found or error
        return;
      }
      const matches: GrepMatch[] = stdout
        .split('\n')
        .filter(Boolean)
        .map(line => {
          const match = line.match(/^(.+?):(\d+):(.*)$/);
          if (!match) return null;
          return { file: match[1], line: Number(match[2]), content: match[3] };
        })
        .filter((m): m is GrepMatch => m !== null);
      resolve(matches);
    });
  });
}

async function nodeGrep(
  pattern: string,
  searchPath: string,
  include?: string,
  exclude?: string,
  maxResults = 50,
): Promise<GrepMatch[]> {
  const regex = new RegExp(pattern, 'gi');
  const matches: GrepMatch[] = [];
  const base = resolve(searchPath);

  async function walk(dir: string) {
    if (matches.length >= maxResults) return;
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (matches.length >= maxResults) return;
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(fullPath);
        } else {
          if (include && !new RegExp(include.replace(/\*/g, '.*')).test(entry.name)) continue;
          if (exclude && new RegExp(exclude.replace(/\*/g, '.*')).test(entry.name)) continue;
          try {
            const content = await readFile(fullPath, 'utf-8');
            const lines = content.split('\n');
            for (let i = 0; i < lines.length && matches.length < maxResults; i++) {
              if (regex.test(lines[i])) {
                matches.push({ file: relative(base, fullPath), line: i + 1, content: lines[i].trim() });
              }
              regex.lastIndex = 0;
            }
          } catch {
            // Skip binary/unreadable files
          }
        }
      }
    } catch {
      // Skip unreadable directories
    }
  }

  await walk(base);
  return matches;
}

export const grepTool = buildTool({
  name: 'grep',
  description: 'Search files for a regex pattern. Uses ripgrep if available, falls back to Node.js. Returns matches with file path, line number, and content.',
  inputSchema: InputSchema,
  isReadOnly: true,
  isDestructive: false,
  timeoutMs: 30_000,
  categories: ['filesystem'],

  async execute(input: z.infer<typeof InputSchema>) {
    const start = performance.now();
    const searchPath = resolve(input.path ?? process.cwd());
    const maxResults = input.maxResults ?? 50;

    try {
      // Try ripgrep first
      let matches = await tryRipgrep(input.pattern, searchPath, input.include, input.exclude, maxResults);

      // Fall back to Node.js
      if (matches === null) {
        matches = await nodeGrep(input.pattern, searchPath, input.include, input.exclude, maxResults);
      }

      return {
        output: { matches, count: matches.length, searchPath },
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
