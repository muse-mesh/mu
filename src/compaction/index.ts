import { generateText, type LanguageModel } from 'ai';
import { COMPACTION_PROMPT } from './prompts.js';
import { getContextWindow, estimateTokens } from '../context.js';

export interface CompactableMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export type CompactionAction = 'none' | 'summarize' | 'reset';

export function shouldCompact(messages: CompactableMessage[], model: string): CompactionAction {
  const tokenEstimate = estimateTokens(messages.map((m) => m.content).join('\n'));
  const contextWindow = getContextWindow(model);
  const ratio = tokenEstimate / contextWindow;

  if (ratio > 0.9) return 'reset';
  if (ratio > 0.7) return 'summarize';
  return 'none';
}

export function truncateToolOutput(output: string, maxLen: number): string {
  if (output.length <= maxLen) return output;
  const headLen = Math.floor(maxLen * 0.4);
  const tailLen = Math.floor(maxLen * 0.4);
  const head = output.slice(0, headLen);
  const tail = output.slice(-tailLen);
  const omitted = output.length - headLen - tailLen;
  return `${head}\n\n[… ${omitted} chars truncated …]\n\n${tail}`;
}

export async function compactConversation(
  messages: CompactableMessage[],
  model: LanguageModel,
): Promise<CompactableMessage[]> {
  // Keep last 4 messages intact
  const keepCount = Math.min(4, messages.length);
  const toSummarize = messages.slice(0, messages.length - keepCount);
  const toKeep = messages.slice(-keepCount);

  if (toSummarize.length === 0) return messages;

  const { text: summary } = await generateText({
    model,
    system: COMPACTION_PROMPT,
    messages: toSummarize.map((m) => ({ role: m.role === 'system' ? 'user' as const : m.role, content: m.content })),
  });

  return [
    { role: 'system', content: `[Previous conversation summary]\n${summary}` },
    ...toKeep,
  ];
}

export async function resetConversation(
  messages: CompactableMessage[],
  model: LanguageModel,
): Promise<CompactableMessage[]> {
  const { text: facts } = await generateText({
    model,
    system: 'Extract only the key facts from this conversation as a bullet list. Be extremely concise. Include file paths, commands, and decisions.',
    messages: messages.map((m) => ({ role: m.role === 'system' ? 'user' as const : m.role, content: m.content })),
  });

  return [
    { role: 'system', content: `[Context recovered from previous conversation]\n${facts}` },
  ];
}
