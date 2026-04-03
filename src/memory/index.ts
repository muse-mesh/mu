import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { generateText, type LanguageModel } from 'ai';
import { MEMORY_EXTRACTION_PROMPT } from '../compaction/prompts.js';

// ── Types ──────────────────────────────────────────────────────────

export interface MemoryEntry {
  id: string;
  type: 'fact' | 'preference' | 'convention' | 'decision';
  content: string;
  source: string; // session ID
  relevance: number; // 0-1
  createdAt: string;
  lastAccessedAt: string;
}

// ── Paths ──────────────────────────────────────────────────────────

const MEMORY_DIR = join(homedir(), '.mu', 'memory');

function ensureMemoryDir() {
  mkdirSync(MEMORY_DIR, { recursive: true, mode: 0o700 });
}

function projectMemoryDir(cwd: string): string {
  // Hash the project path for a stable directory name
  const safe = cwd.replace(/[^a-zA-Z0-9]/g, '_').slice(-80);
  const dir = join(MEMORY_DIR, safe);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

// ── MEMORY.md (Tier 1) ────────────────────────────────────────────

export function readProjectMemory(cwd: string): string | null {
  const memPath = join(cwd, 'MEMORY.md');
  if (existsSync(memPath)) {
    return readFileSync(memPath, 'utf-8');
  }
  return null;
}

// ── Typed Memory Entries (Tier 2) ─────────────────────────────────

export function loadMemoryEntries(cwd: string): MemoryEntry[] {
  const dir = projectMemoryDir(cwd);
  const entriesFile = join(dir, 'entries.json');
  if (!existsSync(entriesFile)) return [];
  try {
    return JSON.parse(readFileSync(entriesFile, 'utf-8'));
  } catch {
    return [];
  }
}

export function saveMemoryEntries(cwd: string, entries: MemoryEntry[]): void {
  const dir = projectMemoryDir(cwd);
  writeFileSync(join(dir, 'entries.json'), JSON.stringify(entries, null, 2));
}

export function addMemoryEntry(cwd: string, entry: Omit<MemoryEntry, 'id' | 'createdAt' | 'lastAccessedAt'>): void {
  const entries = loadMemoryEntries(cwd);
  entries.push({
    ...entry,
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    lastAccessedAt: new Date().toISOString(),
  });
  saveMemoryEntries(cwd, entries);
}

// ── Session Memory Extraction (Tier 3) ────────────────────────────

export async function extractSessionMemory(
  messages: Array<{ role: string; content: string }>,
  model: LanguageModel,
  sessionId: string,
): Promise<MemoryEntry[]> {
  try {
    const { text } = await generateText({
      model,
      system: MEMORY_EXTRACTION_PROMPT,
      messages: messages.map((m) => ({
        role: m.role === 'system' ? 'user' as const : m.role as 'user' | 'assistant',
        content: m.content,
      })),
    });

    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return [];

    return parsed
      .filter((e: any) => e.type && e.content)
      .map((e: any) => ({
        id: randomUUID(),
        type: e.type,
        content: e.content,
        source: sessionId,
        relevance: 1.0,
        createdAt: new Date().toISOString(),
        lastAccessedAt: new Date().toISOString(),
      }));
  } catch {
    return [];
  }
}

// ── Memory Injection ──────────────────────────────────────────────

export function selectRelevantMemory(prompt: string, entries: MemoryEntry[], k: number = 10): MemoryEntry[] {
  if (entries.length === 0) return [];

  const promptWords = new Set(prompt.toLowerCase().split(/\W+/).filter((w) => w.length > 2));

  return entries
    .map((e) => {
      const entryWords = e.content.toLowerCase().split(/\W+/).filter((w) => w.length > 2);
      const overlap = entryWords.filter((w) => promptWords.has(w)).length;
      const score = (overlap / Math.max(entryWords.length, 1)) * e.relevance;
      return { ...e, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

export function buildMemoryContext(cwd: string, prompt: string): string {
  const parts: string[] = [];

  // Tier 1: MEMORY.md
  const projectMem = readProjectMemory(cwd);
  if (projectMem) {
    parts.push(`## Project Memory\n${projectMem}`);
  }

  // Tier 2: Relevant entries
  const entries = loadMemoryEntries(cwd);
  const relevant = selectRelevantMemory(prompt, entries);
  if (relevant.length > 0) {
    const lines = relevant.map((e) => `- [${e.type}] ${e.content}`);
    parts.push(`## Remembered Context\n${lines.join('\n')}`);
  }

  return parts.join('\n\n');
}
