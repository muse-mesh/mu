import type { MuToolDef, ToolContext } from '../types.js';
import { promptUser as cliPromptUser } from './prompt.js';
import type { WebPrompter } from './web-prompt.js';

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

// ── Web mode: injectable prompter ─────────────────────────────────
// When running in web UI mode, set a WebPrompter so permission checks
// block on browser approval instead of a CLI readline prompt.

let _webPrompter: WebPrompter | null = null;

export function setWebPrompter(prompter: WebPrompter | null) {
  _webPrompter = prompter;
}

// Internal: get a yes/no/always answer via whichever prompter is active
async function askPermission(toolName: string, input?: unknown): Promise<'yes' | 'no' | 'always'> {
  if (_webPrompter) {
    const description = `Allow ${toolName}?`;
    const result = await _webPrompter.promptUser(toolName, description, input);
    return result;
  }
  // CLI fallback
  const answer = await cliPromptUser(`Allow tool "${toolName}"?`);
  return answer;
}

async function askDestructivePermission(toolName: string, input?: unknown): Promise<'yes' | 'no' | 'always'> {
  if (_webPrompter) {
    const description = `Allow destructive tool: ${toolName}`;
    const result = await _webPrompter.promptUser(toolName, description, input);
    return result;
  }
  const answer = await cliPromptUser(`Allow destructive tool "${toolName}"?`);
  return answer;
}

export async function checkPermission(
  def: MuToolDef,
  mode: 'auto' | 'default' | 'approve-destructive' | 'plan',
  input?: unknown,
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
    const answer = await askPermission(def.name, input);
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
    const answer = await askDestructivePermission(def.name, input);
    if (answer === 'yes' || answer === 'always') return;
    throw new PermissionDeniedError(def.name);
  }
}
