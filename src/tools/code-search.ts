import { z } from 'zod';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { buildTool } from './build-tool.js';

const execFileAsync = promisify(execFile);

const InputSchema = z.object({
  pattern: z.string().describe(
    'Text pattern or regex to search for. Can be plain text, a regex, or a natural-language description of code you are looking for.',
  ),
  path: z.string().optional().describe(
    'Directory or file to search in (default: current directory)',
  ),
  include: z.string().optional().describe(
    'Glob pattern to filter files, e.g. "*.ts" or "src/**/*.js"',
  ),
  exclude: z.string().optional().describe(
    'Glob pattern to exclude files, e.g. "node_modules/**"',
  ),
  ignoreCase: z.boolean().optional().default(false).describe('Case-insensitive search'),
  maxResults: z.number().int().optional().default(50).describe(
    'Maximum number of match lines to return (default: 50)',
  ),
  contextLines: z.number().int().optional().default(2).describe(
    'Number of context lines around each match (default: 2)',
  ),
});

// Check if ripgrep (rg) is available
async function hasRipgrep(): Promise<boolean> {
  try {
    await execFileAsync('which', ['rg'], { timeout: 3_000 });
    return true;
  } catch {
    return false;
  }
}

// Run ripgrep and return output
async function searchWithRipgrep(input: z.infer<typeof InputSchema>): Promise<string> {
  const args: string[] = [
    '--line-number',
    '--no-heading',
    '--color=never',
    `--context=${input.contextLines ?? 2}`,
    `--max-count=${input.maxResults ?? 50}`,
  ];

  if (input.ignoreCase) args.push('--ignore-case');
  if (input.include) args.push(`--glob=${input.include}`);
  if (input.exclude) args.push(`--glob=!${input.exclude}`);

  // Treat pattern as regex (rg uses regex by default)
  args.push(input.pattern);
  args.push(input.path ?? '.');

  try {
    const { stdout } = await execFileAsync('rg', args, {
      cwd: process.cwd(),
      timeout: 30_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    return stdout;
  } catch (err: any) {
    // rg exits with code 1 when no matches (not an error)
    if (err.code === 1 && !err.stderr) return '';
    throw err;
  }
}

// Fallback: Node.js grep using child_process grep
async function searchWithGrep(input: z.infer<typeof InputSchema>): Promise<string> {
  const args: string[] = ['-rn', '--color=never'];

  if (input.ignoreCase) args.push('-i');
  if (input.include) args.push(`--include=${input.include}`);
  if (input.exclude) args.push(`--exclude-dir=node_modules`, `--exclude-dir=.git`);
  if ((input.contextLines ?? 2) > 0) args.push(`-C${input.contextLines ?? 2}`);

  args.push(input.pattern);
  args.push(input.path ?? '.');

  try {
    const { stdout } = await execFileAsync('grep', args, {
      cwd: process.cwd(),
      timeout: 30_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    return stdout;
  } catch (err: any) {
    // grep exits 1 = no matches
    if (err.code === 1) return '';
    throw err;
  }
}

function parseResults(raw: string, maxResults: number): Array<{
  file: string;
  line: number;
  content: string;
  context?: string;
}> {
  if (!raw.trim()) return [];

  const results: Array<{ file: string; line: number; content: string }> = [];
  const lines = raw.split('\n');

  for (const line of lines) {
    if (!line.trim()) continue;
    // rg/grep format: "file:linenum:content" or "file-linenum-context"
    const match = line.match(/^(.+?)[:-](\d+)[:-](.*)$/);
    if (match) {
      results.push({
        file: match[1],
        line: parseInt(match[2], 10),
        content: match[3],
      });
    }
  }

  return results.slice(0, maxResults);
}

export const codeSearch = buildTool({
  name: 'code_search',
  description:
    'Search for code patterns across files using regex or plain text. ' +
    'Uses ripgrep (rg) when available for fast results, falls back to grep. ' +
    'Returns matching lines with file path, line number, and surrounding context.',
  inputSchema: InputSchema,
  isReadOnly: true,
  isDestructive: false,
  timeoutMs: 30_000,
  categories: ['filesystem', 'code'],

  async execute(input: z.infer<typeof InputSchema>) {
    const start = performance.now();

    try {
      const useRg = await hasRipgrep();
      const raw = useRg
        ? await searchWithRipgrep(input)
        : await searchWithGrep(input);

      const results = parseResults(raw, input.maxResults ?? 50);
      const durationMs = Math.round(performance.now() - start);

      if (results.length === 0) {
        return {
          output: { matches: [], totalMatches: 0, engine: useRg ? 'ripgrep' : 'grep', durationMs },
          durationMs,
        };
      }

      return {
        output: {
          matches: results,
          totalMatches: results.length,
          engine: useRg ? 'ripgrep' : 'grep',
          durationMs,
        },
        durationMs,
      };
    } catch (err: any) {
      return {
        output: null,
        error: `Search failed: ${err.message}`,
        durationMs: Math.round(performance.now() - start),
      };
    }
  },
});
