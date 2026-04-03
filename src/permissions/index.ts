import type { MuToolDef, ToolContext } from '../types.js';
import { promptUser } from './prompt.js';

// ── Permission System ──────────────────────────────────────────────
// 4-mode permission model:
//   auto              — all tools execute without prompting
//   default           — read-only auto-approved; destructive prompted once, then remembered
//   approve-destructive — read-only auto-approved; every destructive call prompts
//   plan              — read-only only; destructive tools blocked

export class PermissionDeniedError extends Error {
  constructor(toolName: string) {
    super(`Permission denied for tool: ${toolName}`);
    this.name = 'PermissionDeniedError';
  }
}

// Session-scoped approvals (tool names the user said "always" for)
const sessionApprovals = new Set<string>();

export function clearSessionApprovals() {
  sessionApprovals.clear();
}

export async function checkPermission(
  def: MuToolDef,
  mode: 'auto' | 'default' | 'approve-destructive' | 'plan',
): Promise<void> {
  // Auto mode — everything passes
  if (mode === 'auto') return;

  // Read-only tools always pass in all modes
  if (def.isReadOnly) return;

  // Plan mode — only read-only allowed
  if (mode === 'plan') {
    throw new PermissionDeniedError(def.name);
  }

  // Default mode — prompt once, remember if "always"
  if (mode === 'default') {
    if (sessionApprovals.has(def.name)) return;
    const answer = await promptUser(`Allow tool "${def.name}"?`);
    if (answer === 'always') {
      sessionApprovals.add(def.name);
      return;
    }
    if (answer === 'yes') return;
    throw new PermissionDeniedError(def.name);
  }

  // Approve-destructive — prompt every destructive call
  if (mode === 'approve-destructive') {
    if (!def.isDestructive) return;
    const answer = await promptUser(`Allow destructive tool "${def.name}"?`);
    if (answer === 'yes' || answer === 'always') return;
    throw new PermissionDeniedError(def.name);
  }
}
