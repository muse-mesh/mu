import { z } from 'zod';
import { buildTool } from './build-tool.js';

const InputSchema = z.object({
  thought: z.string().describe('Your reasoning, analysis, or planning thought'),
});

export const think = buildTool({
  name: 'think',
  description: 'A scratchpad tool for reasoning and planning. Use this to think through complex problems before taking action. The thought is returned unchanged — it costs no actions.',
  inputSchema: InputSchema,
  isReadOnly: true,
  isDestructive: false,
  timeoutMs: 1_000,
  categories: ['agent'],

  async execute(input: z.infer<typeof InputSchema>) {
    return {
      output: input.thought,
      durationMs: 0,
    };
  },
});
