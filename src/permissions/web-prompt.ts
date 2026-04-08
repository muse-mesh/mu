import { randomUUID } from 'node:crypto';
import type { PromptResult } from './prompt.js';

// ── Web Permission Prompter ────────────────────────────────────────
// Used when mu is running in web mode (--web). Instead of blocking
// on a CLI readline prompt, it parks the permission check as a
// "pending permission" that the browser can see (via polling) and
// respond to. The checkPermission() call blocks until the browser
// POSTs an approve/deny response.

export interface PendingPermission {
  id: string;
  toolName: string;
  description: string;
  input?: unknown;
  createdAt: string;
}

export interface WebPrompter {
  promptUser(toolName: string, description: string, input?: unknown): Promise<PromptResult>;
  getPending(): PendingPermission[];
  respond(id: string, result: PromptResult): boolean;
  rejectAll(reason: string): void;
}

export function createWebPrompter(): WebPrompter {
  const pending = new Map<
    string,
    {
      permission: PendingPermission;
      resolve: (r: PromptResult) => void;
      reject: (e: Error) => void;
    }
  >();

  function promptUser(
    toolName: string,
    description: string,
    input?: unknown,
  ): Promise<PromptResult> {
    const id = randomUUID();
    return new Promise<PromptResult>((resolve, reject) => {
      pending.set(id, {
        permission: {
          id,
          toolName,
          description,
          input,
          createdAt: new Date().toISOString(),
        },
        resolve,
        reject,
      });
    });
  }

  function getPending(): PendingPermission[] {
    return [...pending.values()].map((v) => v.permission);
  }

  function respond(id: string, result: PromptResult): boolean {
    const entry = pending.get(id);
    if (!entry) return false;
    pending.delete(id);
    entry.resolve(result);
    return true;
  }

  function rejectAll(reason: string): void {
    for (const entry of pending.values()) {
      entry.reject(new Error(reason));
    }
    pending.clear();
  }

  return { promptUser, getPending, respond, rejectAll };
}
