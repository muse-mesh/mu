import type { MuToolDef, ToolContext, ToolResult } from '../types.js';

// ── buildTool factory — safe defaults ──────────────────────────────

type BuildToolInput = Partial<MuToolDef> &
  Pick<MuToolDef, 'name' | 'description' | 'inputSchema' | 'execute'>;

export function buildTool(partial: BuildToolInput): MuToolDef {
  return {
    isReadOnly: false,
    isDestructive: false,
    isOpenWorld: false,
    isBackground: false,
    requiresApproval: false,
    timeoutMs: 30_000,
    ...partial,
  };
}
