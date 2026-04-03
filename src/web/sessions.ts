import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';


// ── Session Types ──────────────────────────────────────────────────

export interface WebSession {
  sessionId: string;
  status: 'idle' | 'running' | 'completed' | 'error';
  model: string;
  maxSteps: number;
  createdAt: string;
  messages: SessionMessage[];
  totalTokens: { input: number; output: number };
  totalSteps: number;
}

export interface SessionMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

// ── Session Store ──────────────────────────────────────────────────

const SESSIONS_DIR = join(homedir(), '.mu', 'sessions');
const activeSessions = new Map<string, WebSession>();

function ensureSessionDir() {
  mkdirSync(SESSIONS_DIR, { recursive: true, mode: 0o700 });
}

export function createSession(model: string, maxSteps: number): WebSession {
  ensureSessionDir();
  const session: WebSession = {
    sessionId: randomUUID(),
    status: 'idle',
    model,
    maxSteps,
    createdAt: new Date().toISOString(),
    messages: [],
    totalTokens: { input: 0, output: 0 },
    totalSteps: 0,
  };
  activeSessions.set(session.sessionId, session);
  persistSession(session);
  return session;
}

export function getSession(sessionId: string): WebSession | undefined {
  if (activeSessions.has(sessionId)) return activeSessions.get(sessionId);
  // Try loading from disk
  return loadSessionFromDisk(sessionId);
}

export function listSessions(): Array<{ sessionId: string; status: string; createdAt: string; messageCount: number; model: string }> {
  ensureSessionDir();
  const results: Array<{ sessionId: string; status: string; createdAt: string; messageCount: number; model: string }> = [];

  // Active sessions first
  for (const s of activeSessions.values()) {
    results.push({
      sessionId: s.sessionId,
      status: s.status,
      createdAt: s.createdAt,
      messageCount: (s as any).uiMessages?.length ?? s.messages.length,
      model: s.model,
    });
  }

  // Load from disk (ones not already active)
  try {
    const files = readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json'));
    for (const file of files) {
      const id = file.replace('.json', '');
      if (activeSessions.has(id)) continue;
      try {
        const data = JSON.parse(readFileSync(join(SESSIONS_DIR, file), 'utf-8'));
        results.push({
          sessionId: data.sessionId,
          status: data.status,
          createdAt: data.createdAt,
          messageCount: data.uiMessages?.length ?? data.messages?.length ?? 0,
          model: data.model,
        });
      } catch { /* skip corrupt files */ }
    }
  } catch { /* dir may not exist yet */ }

  return results.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function deleteSession(sessionId: string): boolean {
  activeSessions.delete(sessionId);
  const filePath = join(SESSIONS_DIR, `${sessionId}.json`);
  try {
    if (existsSync(filePath)) unlinkSync(filePath);
    return true;
  } catch {
    return false;
  }
}

export function updateSession(sessionId: string, updater: (s: WebSession) => void) {
  const session = activeSessions.get(sessionId);
  if (!session) return;
  updater(session);
  persistSession(session);
}

// ── Persistence ────────────────────────────────────────────────────

function persistSession(session: WebSession) {
  ensureSessionDir();
  writeFileSync(
    join(SESSIONS_DIR, `${session.sessionId}.json`),
    JSON.stringify(session, null, 2),
  );
}

function loadSessionFromDisk(sessionId: string): WebSession | undefined {
  const filePath = join(SESSIONS_DIR, `${sessionId}.json`);
  try {
    if (!existsSync(filePath)) return undefined;
    const data = JSON.parse(readFileSync(filePath, 'utf-8'));
    activeSessions.set(sessionId, data);
    return data;
  } catch {
    return undefined;
  }
}
