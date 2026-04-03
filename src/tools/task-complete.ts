import { z } from 'zod';
import { buildTool } from './build-tool.js';

const InputSchema = z.object({
  summary: z.string().describe('A brief summary of what was accomplished'),
});

export const taskComplete = buildTool({
  name: 'task_complete',
  description: 'Signal that the current task is complete. Provide a brief summary of what was accomplished.',
  inputSchema: InputSchema,
  isReadOnly: true,
  isDestructive: false,
  timeoutMs: 1_000,
  categories: ['agent'],

  async execute(input: z.infer<typeof InputSchema>) {
    return {
      output: { completed: true, summary: input.summary },
      durationMs: 0,
    };
  },
});
