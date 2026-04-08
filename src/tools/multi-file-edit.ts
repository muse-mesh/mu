import { z } from 'zod';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildTool } from './build-tool.js';

const EditOperationSchema = z.object({
  path: z.string().describe('Absolute or relative path to the file'),
  oldContent: z.string().describe(
    'The exact text to find and replace (must appear exactly once in the file)',
  ),
  newContent: z.string().describe('The replacement text'),
});

const InputSchema = z.object({
  edits: z.array(EditOperationSchema).min(1).describe(
    'Array of edit operations to apply. All operations are validated before any are written. ' +
    'If any validation fails, no files are modified (transactional).',
  ),
});

interface EditResult {
  path: string;
  success: boolean;
  diff?: string;
  error?: string;
}

export const multiFileEdit = buildTool({
  name: 'multi_file_edit',
  description:
    'Apply multiple file edits in a single transactional operation. ' +
    'All edits are validated (each oldContent must appear exactly once) before any files are written. ' +
    'If any validation fails, no files are modified. ' +
    'Use this to make related changes across multiple files atomically and reduce round trips.',
  inputSchema: InputSchema,
  isReadOnly: false,
  isDestructive: true,
  timeoutMs: 30_000,
  categories: ['filesystem'],

  async execute(input: z.infer<typeof InputSchema>) {
    const start = performance.now();

    // ── Phase 1: Validate all edits (read-only) ───────────────────
    const validated: Array<{
      filePath: string;
      original: string;
      updated: string;
      diff: string;
      relativePath: string;
    }> = [];

    const validationErrors: Array<{ path: string; error: string }> = [];

    for (const edit of input.edits) {
      const filePath = resolve(edit.path);
      try {
        const original = readFileSync(filePath, 'utf-8');
        const occurrences = original.split(edit.oldContent).length - 1;

        if (occurrences === 0) {
          validationErrors.push({
            path: edit.path,
            error: `oldContent not found in file`,
          });
          continue;
        }
        if (occurrences > 1) {
          validationErrors.push({
            path: edit.path,
            error: `oldContent appears ${occurrences} times — must appear exactly once`,
          });
          continue;
        }

        const updated = original.replace(edit.oldContent, edit.newContent);
        const diff = [
          `--- a/${edit.path}`,
          `+++ b/${edit.path}`,
          ...edit.oldContent.split('\n').map((l) => `- ${l}`),
          ...edit.newContent.split('\n').map((l) => `+ ${l}`),
        ].join('\n');

        validated.push({ filePath, original, updated, diff, relativePath: edit.path });
      } catch (err: any) {
        validationErrors.push({
          path: edit.path,
          error: err.code === 'ENOENT' ? `File not found: ${filePath}` : err.message,
        });
      }
    }

    // ── If any validation failed, abort entirely ──────────────────
    if (validationErrors.length > 0) {
      return {
        output: null,
        error: [
          `Validation failed — no files were modified.`,
          ...validationErrors.map((e) => `  ${e.path}: ${e.error}`),
        ].join('\n'),
        durationMs: Math.round(performance.now() - start),
      };
    }

    // ── Phase 2: Write all validated edits ────────────────────────
    const results: EditResult[] = [];
    const written: typeof validated = [];

    for (const v of validated) {
      try {
        writeFileSync(v.filePath, v.updated, 'utf-8');
        written.push(v);
        results.push({ path: v.relativePath, success: true, diff: v.diff });
      } catch (err: any) {
        // Partial write failure — attempt to roll back already-written files
        const rollbackErrors: string[] = [];
        for (const w of written) {
          try {
            writeFileSync(w.filePath, w.original, 'utf-8');
          } catch (rbErr: any) {
            rollbackErrors.push(`${w.relativePath}: ${rbErr.message}`);
          }
        }
        const rollbackMsg = rollbackErrors.length
          ? ` Rollback failed for: ${rollbackErrors.join(', ')}`
          : ' All previously written files rolled back.';
        return {
          output: null,
          error: `Write failed for ${v.relativePath}: ${err.message}.${rollbackMsg}`,
          durationMs: Math.round(performance.now() - start),
        };
      }
    }

    return {
      output: {
        filesModified: results.length,
        results,
      },
      durationMs: Math.round(performance.now() - start),
    };
  },
});
