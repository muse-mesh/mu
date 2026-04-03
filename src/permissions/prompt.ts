import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

// ── CLI Permission Prompt ──────────────────────────────────────────

export type PromptResult = 'yes' | 'no' | 'always';

export async function promptUser(message: string): Promise<PromptResult> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await rl.question(`\x1b[33m⚠ ${message} [y/N/always] \x1b[0m`);
    const normalized = answer.trim().toLowerCase();
    if (normalized === 'y' || normalized === 'yes') return 'yes';
    if (normalized === 'a' || normalized === 'always') return 'always';
    return 'no';
  } finally {
    rl.close();
  }
}
