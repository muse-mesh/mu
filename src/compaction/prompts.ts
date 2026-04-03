export const COMPACTION_PROMPT = `You are a conversation summarizer. Given a conversation between a user and an AI agent, produce a concise summary covering:

1. What the user asked for
2. Key decisions made
3. Files created/modified and why
4. Important facts discovered
5. Current state of the task

Be factual and concise. Use bullet points. Preserve file paths, function names, and technical details exactly.`;

export const MEMORY_EXTRACTION_PROMPT = `You are a memory extraction system. Given a conversation between a user and an AI agent, extract persistent facts worth remembering for future sessions.

Extract ONLY:
- Project conventions and patterns
- Architecture decisions
- User preferences (coding style, tools, etc.)
- Key file locations and their purposes
- Gotchas, bugs found, and workarounds
- Build/run commands that work

Output as JSON array of objects with fields:
- "type": one of "fact", "preference", "convention", "decision"
- "content": the fact in one concise sentence

Do NOT extract:
- Transient information (specific error messages that were fixed)
- Obvious facts (e.g. "the project uses JavaScript")
- Anything already in standard docs`;
