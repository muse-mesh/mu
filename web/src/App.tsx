import { Component, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport, type UIMessage } from 'ai';
import { Marked } from 'marked';
import hljs from 'highlight.js';

// crypto.randomUUID() is only available in secure contexts (HTTPS/localhost).
// Fallback for plain HTTP access (e.g. Pi on LAN).
const genId = (): string =>
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = (Math.random() * 16) | 0;
        return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
      });

// ── Markdown Setup ──────────────────────────────────────────────────

function escapeHtml(str: string): string {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const marked = new Marked({
  renderer: {
    code(this: unknown, ...args: unknown[]) {
      // marked v12+ passes { text, lang } object; types lag behind
      const { text, lang } = (typeof args[0] === 'object' && args[0] !== null
        ? args[0]
        : { text: args[0], lang: args[1] }) as { text: string; lang?: string };
      if (!text) return '<pre><code></code></pre>';
      let highlighted: string;
      if (lang && hljs.getLanguage(lang)) {
        highlighted = hljs.highlight(text, { language: lang }).value;
      } else {
        highlighted = hljs.highlightAuto(text).value;
      }
      const langLabel = lang
        ? `<span class="code-lang-label">${escapeHtml(lang)}</span>`
        : '';
      return `<pre>${langLabel}<code class="hljs">${highlighted}</code></pre>`;
    },
  },
  gfm: true,
  breaks: true,
});

function renderMarkdown(text: string): string {
  if (!text) return '';
  try {
    const result = marked.parse(text, { async: false });
    return typeof result === 'string' ? result : '';
  } catch {
    return `<p>${escapeHtml(text)}</p>`;
  }
}

// ── Tool Helpers ────────────────────────────────────────────────────

function truncate(str: string, len: number) {
  return str.length > len ? str.slice(0, len) + '…' : str;
}

const TOOL_DISPLAY_NAMES: Record<string, string> = {
  shell_exec: 'Shell',
  shell_exec_bg: 'Background Process',
  file_read: 'Read File',
  file_write: 'Write File',
  file_edit: 'Edit File',
  multi_file_edit: 'Multi-File Edit',
  glob: 'Find Files',
  grep: 'Search',
  code_search: 'Code Search',
  list_dir: 'List Directory',
  http_fetch: 'HTTP Fetch',
  system_info: 'System Info',
  think: 'Thinking',
  task_complete: 'Task Complete',
};

function getToolDisplayName(toolName: string): string {
  if (TOOL_DISPLAY_NAMES[toolName]) return TOOL_DISPLAY_NAMES[toolName];
  // Fallback: snake_case → Title Case
  return toolName
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

// Tools that should auto-expand when complete
const AUTO_EXPAND_TOOLS = new Set(['task_complete', 'think']);

function getToolSummary(toolName: string, input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const data = input as Record<string, unknown>;
  switch (toolName) {
    case 'shell_exec':
      return data.command ? truncate(String(data.command), 80) : '';
    case 'shell_exec_bg': {
      if (!data.action) return '';
      if (data.action === 'start') return `start: ${truncate(String(data.command || ''), 60)}`;
      if (data.action === 'status' || data.action === 'stop') return `${data.action} PID ${data.pid}`;
      return String(data.action);
    }
    case 'file_read': {
      const p = String(data.path || data.file_path || '');
      const lines = data.startLine && data.endLine ? ` L${data.startLine}–${data.endLine}` : '';
      return p + lines;
    }
    case 'file_write':
      return String(data.path || data.file_path || '');
    case 'file_edit':
      return String(data.path || data.file_path || '');
    case 'glob':
      return String(data.pattern || '');
    case 'grep':
      return data.pattern ? `"${truncate(String(data.pattern), 40)}"` : '';
    case 'code_search':
      return data.pattern ? `"${truncate(String(data.pattern), 40)}"` : '';
    case 'multi_file_edit': {
      const edits = data.edits as Array<{ path: string }> | undefined;
      if (!edits?.length) return '';
      return edits.length === 1 ? edits[0].path : `${edits.length} files`;
    }
    case 'list_dir':
      return String(data.path || '.');
    case 'http_fetch':
      return `${data.method || 'GET'} ${data.url ? truncate(String(data.url), 60) : ''}`;
    case 'think':
      return truncate(String(data.thought || ''), 60);
    case 'task_complete':
      return '';
    case 'system_info':
      return '';
    default:
      return '';
  }
}

// ── Session Types ───────────────────────────────────────────────────

interface SessionInfo {
  sessionId: string;
  status: string;
  model: string;
  createdAt: string;
  messageCount: number;
}

// ── Model Types ─────────────────────────────────────────────────────

interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  contextLength: number;
  pricing: { prompt: number; completion: number };
}

// ── Error Boundary ──────────────────────────────────────────────────

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 24, color: 'var(--error, red)' }}>
          <p>Something went wrong: {this.state.error.message}</p>
          <button onClick={() => this.setState({ error: null })}>Retry</button>
        </div>
      );
    }
    return this.props.children;
  }
}

// ── App Component ───────────────────────────────────────────────────

interface GatewayInfo {
  rateLimitLimit: number;
  rateLimitRemaining: number;
  modelId: string;
}

function AppInner() {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [activeSession, setActiveSession] = useState<string | null>(null);
  const [chatId, setChatId] = useState(genId);
  const [modelName, setModelName] = useState('—');
  const [selectedModel, setSelectedModel] = useState<string>(
    () => localStorage.getItem('mu-selected-model') || '',
  );
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [selectorOpen, setSelectorOpen] = useState(false);
  const [modelSearch, setModelSearch] = useState('');
  const [input, setInput] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [gateway, setGateway] = useState<GatewayInfo>({ rateLimitLimit: 0, rateLimitRemaining: 0, modelId: '' });
  const [theme, setTheme] = useState(
    () => localStorage.getItem('mu-theme') || 'dark',
  );
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const selectorRef = useRef<HTMLDivElement>(null);
  const selectedModelRef = useRef(selectedModel);
  selectedModelRef.current = selectedModel;

  // Transport with dynamic model injection via body function
  const chatTransport = useMemo(
    () => new DefaultChatTransport({
      api: '/api/chat',
      body: () => ({ model: selectedModelRef.current }),
    }),
    [],
  );

  // Apply theme
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('mu-theme', theme);
  }, [theme]);

  // Fetch config
  useEffect(() => {
    fetch('/api/config')
      .then((r) => r.json())
      .then((c) => {
        setModelName(c.model);
        // If no saved model, use the config default
        if (!localStorage.getItem('mu-selected-model')) {
          setSelectedModel(c.model);
        }
      })
      .catch(() => {});
  }, []);

  // Fetch models from OpenRouter (via server)
  useEffect(() => {
    fetch('/api/models')
      .then((r) => r.json())
      .then((data: ModelInfo[]) => {
        if (Array.isArray(data) && data.length > 0) setModels(data);
      })
      .catch(() => {});
  }, []);

  // Persist selected model
  useEffect(() => {
    if (selectedModel) {
      localStorage.setItem('mu-selected-model', selectedModel);
    }
  }, [selectedModel]);

  // Close model selector on click outside
  useEffect(() => {
    if (!selectorOpen) return;
    const handler = (e: MouseEvent) => {
      if (selectorRef.current && !selectorRef.current.contains(e.target as Node)) {
        setSelectorOpen(false);
        setModelSearch('');
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [selectorOpen]);

  // Derived: display model name
  const displayModelName = useMemo(() => {
    if (!selectedModel) return modelName;
    const found = models.find((m) => m.id === selectedModel);
    return found ? found.name : selectedModel;
  }, [selectedModel, models, modelName]);

  // Derived: grouped & filtered models
  const groupedModels = useMemo(() => {
    const search = modelSearch.toLowerCase();
    const filtered = search
      ? models.filter((m) => m.name.toLowerCase().includes(search) || m.id.toLowerCase().includes(search) || m.provider.toLowerCase().includes(search))
      : models;
    const groups: Record<string, ModelInfo[]> = {};
    for (const m of filtered) {
      (groups[m.provider] ??= []).push(m);
    }
    return groups;
  }, [models, modelSearch]);

  // Poll gateway info (rate limits etc)
  const refreshGateway = useCallback(() => {
    fetch('/api/gateway').then(r => r.json()).then(setGateway).catch(() => {});
  }, []);

  // Load sessions
  const loadSessions = useCallback(async () => {
    try {
      const res = await fetch('/api/sessions');
      setSessions(await res.json());
    } catch {}
  }, []);

  useEffect(() => {
    loadSessions();
  }, [loadSessions]);

  // Active session ref for use in callbacks
  const activeSessionRef = useRef(activeSession);
  activeSessionRef.current = activeSession;

  // useChat hook — stable id, decoupled from session management
  const { messages, sendMessage, setMessages, status, stop, error } = useChat({
    id: chatId,
    transport: chatTransport,
    onFinish: ({ messages: msgs }) => {
      const sid = activeSessionRef.current;
      if (sid) {
        fetch(`/api/sessions/${sid}/save`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messages: msgs }),
        }).catch(() => {});
        loadSessions();
      }
      refreshGateway();
    },
  });

  const isActive = status === 'streaming' || status === 'submitted';

  // Poll for pending permission requests while agent is running
  const [pendingPermissions, setPendingPermissions] = useState<PendingPermission[]>([]);
  useEffect(() => {
    if (!isActive && pendingPermissions.length === 0) return;
    const interval = setInterval(() => {
      fetch('/api/permissions/pending')
        .then((r) => r.json())
        .then((data) => { if (Array.isArray(data)) setPendingPermissions(data); })
        .catch(() => {});
    }, 600);
    return () => clearInterval(interval);
  }, [isActive, pendingPermissions.length]);

  const handlePermissionResponse = useCallback(async (id: string, decision: 'yes' | 'no' | 'always') => {
    await fetch(`/api/permissions/${id}/respond`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision }),
    }).catch(() => {});
    setPendingPermissions((prev) => prev.filter((p) => p.id !== id));
  }, []);

  // Compute session-level usage from message metadata
  const sessionStats = useMemo(() => {
    let inputTokens = 0;
    let outputTokens = 0;
    let totalLatency = 0;
    let steps = 0;
    let totalCost = 0;
    for (const msg of messages) {
      const meta = (msg as any).metadata as MuMetadata | undefined;
      if (meta?.usage) {
        inputTokens += meta.usage.inputTokens;
        outputTokens += meta.usage.outputTokens;
      }
      if (meta?.cost) totalCost += meta.cost;
      if (meta?.latencyMs) totalLatency += meta.latencyMs;
      if (meta?.steps) steps += meta.steps;
    }
    const totalTokens = inputTokens + outputTokens;
    return totalTokens > 0
      ? { inputTokens, outputTokens, totalTokens, totalLatency, steps, totalCost }
      : null;
  }, [messages]);

  // Auto-scroll
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, status]);

  // Create new session
  const createSession = useCallback(async () => {
    const res = await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    const { sessionId } = await res.json();
    setActiveSession(sessionId);
    setChatId(genId());
    setMessages([]);
    loadSessions();
    textareaRef.current?.focus();
  }, [loadSessions, setMessages]);

  // Open session
  const openSession = useCallback(
    async (id: string) => {
      setActiveSession(id);
      setChatId(genId());
      try {
        const res = await fetch(`/api/sessions/${id}`);
        const session = await res.json();
        if (session.uiMessages?.length) {
          setMessages(session.uiMessages);
        } else {
          setMessages([]);
        }
      } catch {
        setMessages([]);
      }
      loadSessions();
    },
    [loadSessions, setMessages],
  );

  // Delete session
  const deleteSessionById = useCallback(
    async (id: string) => {
      await fetch(`/api/sessions/${id}`, { method: 'DELETE' });
      if (activeSessionRef.current === id) {
        setActiveSession(null);
        setMessages([]);
      }
      loadSessions();
    },
    [loadSessions, setMessages],
  );

  // Submit message
  const handleSubmit = useCallback(
    async (e?: React.FormEvent) => {
      e?.preventDefault();
      const text = input.trim();
      if (!text || isActive) return;

      if (!activeSessionRef.current) {
        const res = await fetch('/api/sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        });
        const data = await res.json();
        activeSessionRef.current = data.sessionId;
        setActiveSession(data.sessionId);
        loadSessions();
      }

      setInput('');
      if (textareaRef.current) textareaRef.current.style.height = 'auto';
      sendMessage({ text });
    },
    [input, isActive, loadSessions, sendMessage],
  );

  // Quick prompt from empty state
  const handleQuickPrompt = useCallback(
    async (text: string) => {
      if (!activeSessionRef.current) {
        const res = await fetch('/api/sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        });
        const data = await res.json();
        activeSessionRef.current = data.sessionId;
        setActiveSession(data.sessionId);
        loadSessions();
      }
      sendMessage({ text });
    },
    [loadSessions, sendMessage],
  );

  // Textarea auto-resize
  const handleTextareaChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    e.target.style.height = 'auto';
    e.target.style.height = Math.min(e.target.scrollHeight, 150) + 'px';
  };

  // Enter to submit
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  // Global keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isActive) stop();
      if ((e.ctrlKey || e.metaKey) && e.key === 'n') {
        e.preventDefault();
        createSession();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [isActive, stop, createSession]);

  return (
    <div id="app">
      {/* Permission approval modal — shown when agent is waiting for browser approval */}
      {pendingPermissions.length > 0 && (
        <PermissionModal
          permission={pendingPermissions[0]}
          onRespond={handlePermissionResponse}
        />
      )}
      <div id="main">
        {/* Sidebar */}
        <aside id="sidebar" className={sidebarOpen ? '' : 'sidebar-collapsed'}>
          <div className="sidebar-header">
            <h1 className="sidebar-logo">μ</h1>
            <button
              className="sidebar-toggle"
              onClick={() => setSidebarOpen(false)}
              title="Collapse sidebar"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <rect x="1" y="2" width="14" height="12" rx="2" stroke="currentColor" strokeWidth="1.5" fill="none"/>
                <line x1="5.5" y1="2" x2="5.5" y2="14" stroke="currentColor" strokeWidth="1.5"/>
              </svg>
            </button>
          </div>
          <div className="sidebar-section-label">Sessions</div>
          <div id="session-list">
            {sessions.length === 0 ? (
              <div
                style={{
                  color: 'var(--text-muted)',
                  fontSize: 12,
                  padding: '12px 8px',
                  fontFamily: 'var(--font-mono)',
                }}
              >
                No sessions yet
              </div>
            ) : (
              sessions.map((s) => (
                <div
                  key={s.sessionId}
                  className={`session-item${s.sessionId === activeSession ? ' active' : ''}`}
                  onClick={() => openSession(s.sessionId)}
                >
                  <div className="session-title">
                    <span>
                      {s.status === 'completed'
                        ? '✓'
                        : s.status === 'error'
                          ? '✗'
                          : s.status === 'running'
                            ? '●'
                            : '○'}
                    </span>
                    <span>{s.model}</span>
                  </div>
                  <div className="session-meta">
                    {new Date(s.createdAt).toLocaleDateString([], {
                      month: 'short',
                      day: 'numeric',
                    })}{' '}
                    {new Date(s.createdAt).toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                    {' · '}
                    {s.messageCount} msg{s.messageCount !== 1 ? 's' : ''}
                  </div>
                  <button
                    className="session-delete"
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteSessionById(s.sessionId);
                    }}
                    title="Delete"
                  >
                    ✕
                  </button>
                </div>
              ))
            )}
          </div>
        </aside>

        {/* Content area */}
        <div id="content-area">
          <header id="header">
            <div className="header-left">
              {!sidebarOpen && (
                <button
                  className="sidebar-toggle"
                  onClick={() => setSidebarOpen(true)}
                  title="Expand sidebar"
                >
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                    <rect x="1" y="2" width="14" height="12" rx="2" stroke="currentColor" strokeWidth="1.5" fill="none"/>
                    <line x1="5.5" y1="2" x2="5.5" y2="14" stroke="currentColor" strokeWidth="1.5"/>
                  </svg>
                </button>
              )}
              {!sidebarOpen && <h1 className="header-logo">μ</h1>}
              <span className="badge">{gateway.modelId || displayModelName}</span>
              <span className={`badge badge-${isActive ? 'running' : 'idle'}`}>
                {isActive ? 'running' : 'ready'}
              </span>
              {sessionStats && (
                <div className="header-stats">
                  {sessionStats.totalCost > 0 && (
                    <span className="badge badge-stats badge-cost" title="Cost">${formatCost(sessionStats.totalCost)}</span>
                  )}
                  <span className="badge badge-stats" title="Input tokens">↓{formatTokens(sessionStats.inputTokens)}</span>
                  <span className="badge badge-stats" title="Output tokens">↑{formatTokens(sessionStats.outputTokens)}</span>
                  <span className="badge badge-stats" title="Total tokens">Σ{formatTokens(sessionStats.totalTokens)}</span>
                  {sessionStats.totalLatency > 0 && (
                    <span className="badge badge-stats" title="Total latency">{formatLatency(sessionStats.totalLatency)}</span>
                  )}
                  {sessionStats.steps > 0 && (
                    <span className="badge badge-stats" title="Total steps">{sessionStats.steps} steps</span>
                  )}
                </div>
              )}
              {gateway.rateLimitLimit > 0 && (
                <div className="header-stats">
                  <span className="badge badge-stats badge-ratelimit" title="Rate limit remaining / total">
                    ⧗ {gateway.rateLimitRemaining}/{gateway.rateLimitLimit}
                  </span>
                </div>
              )}
            </div>
            <div className="header-right">
              <button
                id="theme-toggle"
                onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
                title="Toggle theme"
              >
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                  <circle cx="8" cy="8" r="3.5" stroke="currentColor" strokeWidth="1.5" />
                  <path
                    d="M8 1v2m0 10v2m-5-7H1m14 0h-2M3.17 3.17l1.42 1.42m6.82 6.82l1.42 1.42M3.17 12.83l1.42-1.42m6.82-6.82l1.42-1.42"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
              <button id="new-session-btn" onClick={createSession}>
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                  <path
                    d="M7 1v12M1 7h12"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                  />
                </svg>
                <span>New</span>
              </button>
            </div>
          </header>

          {/* Chat area */}
          <div id="chat-area">
            <div id="messages">
              {messages.length === 0 ? (
                <EmptyState onPrompt={handleQuickPrompt} />
              ) : (
                messages.map((msg) => (
                  <MessageRow key={msg.id} message={msg} />
                ))
              )}

              {isActive && (
                <div className="mu-indicator">
                  <span className="mu-indicator-symbol">μ</span>
                  <span className="mu-indicator-label shimmer-text">
                    {status === 'submitted' ? 'thinking' : 'working'}
                  </span>
              </div>
            )}

            {error && (
              <div className="message-row">
                <div
                  style={{
                    color: 'var(--error)',
                    fontSize: 13,
                    padding: '8px 0',
                  }}
                >
                  ✗ {error.message}
                </div>
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>

          {/* Composer */}
          <div id="composer" className={isActive ? 'composer-active' : ''}>
            <form id="message-form" onSubmit={handleSubmit}>
              <textarea
                ref={textareaRef}
                id="message-input"
                placeholder="Ask anything..."
                rows={1}
                value={input}
                onChange={handleTextareaChange}
                onKeyDown={handleKeyDown}
                disabled={isActive}
              />
              <div className="composer-toolbar">
                <div className="composer-toolbar-left">
                  <div className="model-selector-wrap" ref={selectorRef}>
                    <button
                      type="button"
                      className="composer-model"
                      onClick={() => { setSelectorOpen(!selectorOpen); setModelSearch(''); }}
                    >
                      <span className="composer-model-dot" />
                      <span>{displayModelName}</span>
                      <svg className={`model-chevron${selectorOpen ? ' open' : ''}`} width="10" height="10" viewBox="0 0 10 10" fill="none">
                        <path d="M2.5 4L5 6.5L7.5 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                    </button>
                    {selectorOpen && (
                      <div className="model-selector-dropdown">
                        <input
                          className="model-selector-search"
                          placeholder="Search models…"
                          value={modelSearch}
                          onChange={(e) => setModelSearch(e.target.value)}
                          autoFocus
                        />
                        <div className="model-selector-list">
                          {Object.keys(groupedModels).length === 0 ? (
                            <div className="model-selector-empty">No models found</div>
                          ) : (
                            Object.entries(groupedModels).map(([provider, providerModels]) => (
                              <div key={provider} className="model-selector-group">
                                <div className="model-selector-provider">{provider}</div>
                                {providerModels.map((m) => (
                                  <button
                                    key={m.id}
                                    type="button"
                                    className={`model-selector-item${m.id === selectedModel ? ' selected' : ''}`}
                                    onClick={() => {
                                      setSelectedModel(m.id);
                                      setSelectorOpen(false);
                                      setModelSearch('');
                                    }}
                                  >
                                    <span className="model-selector-name">{m.name}</span>
                                    <span className="model-selector-meta">
                                      <span title="Context window">{formatContext(m.contextLength)}</span>
                                      <span className="model-selector-price" title="Input / Output per 1M tokens">
                                        ${formatPrice(m.pricing.prompt * 1_000_000)} / ${formatPrice(m.pricing.completion * 1_000_000)}
                                      </span>
                                    </span>
                                  </button>
                                ))}
                              </div>
                            ))
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
                <div className="composer-toolbar-right">
                  {isActive ? (
                    <button
                      type="button"
                      id="stop-btn"
                      onClick={() => stop()}
                      title="Stop (Esc)"
                    >
                      <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                        <rect
                          x="2"
                          y="2"
                          width="10"
                          height="10"
                          rx="2"
                          fill="currentColor"
                        />
                      </svg>
                    </button>
                  ) : (
                    <button
                      type="submit"
                      id="send-btn"
                      disabled={!input.trim()}
                      title="Send (Enter)"
                    >
                      <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
                        <path
                          d="M9 14V4m0 0L4.5 8.5M9 4l4.5 4.5"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    </button>
                  )}
                </div>
              </div>
            </form>
          </div>
        </div>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <AppInner />
    </ErrorBoundary>
  );
}

// ── Metadata types ──────────────────────────────────────────────────

interface MuMetadata {
  usage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    reasoningTokens?: number;
    cachedInputTokens?: number;
  };
  cost?: number;
  latencyMs?: number;
  steps?: number;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
  return String(n);
}

function formatLatency(ms: number): string {
  if (ms >= 60_000) return (ms / 60_000).toFixed(1) + 'm';
  if (ms >= 1_000) return (ms / 1_000).toFixed(1) + 's';
  return ms + 'ms';
}

function formatCost(cost: number): string {
  if (cost >= 1) return cost.toFixed(2);
  if (cost >= 0.01) return cost.toFixed(4);
  return cost.toFixed(6);
}

function formatContext(tokens: number): string {
  if (tokens >= 1_000_000) return (tokens / 1_000_000).toFixed(1) + 'M';
  if (tokens >= 1_000) return Math.round(tokens / 1_000) + 'k';
  return String(tokens);
}

function formatPrice(perMillion: number): string {
  if (perMillion === 0) return '0';
  if (perMillion >= 1) return perMillion.toFixed(2);
  if (perMillion >= 0.01) return perMillion.toFixed(3);
  return perMillion.toFixed(4);
}

// ── Message Row ─────────────────────────────────────────────────────

function MessageRow({ message }: { message: UIMessage }) {
  if (message.role === 'user') {
    const text = message.parts
      .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
      .map((p) => p.text)
      .join('');
    return (
      <div className="message-row message-row-user">
        <div className="message-user">{text}</div>
      </div>
    );
  }

  const meta = (message as any).metadata as MuMetadata | undefined;

  // Assistant message
  return (
    <div className="message-row">
      <div className="message-assistant">
        {message.parts.map((part, i) => {
          try {
            if (part.type === 'text') {
              return <TextPart key={i} text={part.text ?? ''} />;
            }
            if (part.type === 'step-start') {
              return i > 0 ? (
                <div key={i} className="step-divider">
                  Step
                </div>
              ) : null;
            }
            // Tool parts: dynamic-tool has toolName, typed tool-* has name in type
            const partType = part.type as string;
            if (partType === 'dynamic-tool' || partType.startsWith('tool-')) {
              const tp = part as any;
              const toolName: string = tp.toolName ?? partType.slice(5);
              if (!toolName) return null;
              return <ToolPart key={i} part={{ ...tp, toolName }} />;
            }
          } catch (err) {
            console.error('Error rendering part', part, err);
          }
          return null;
        })}
        <StepTimeline parts={message.parts as any} />
      </div>
      {meta?.usage && (
        <div className="message-meta">
          {(meta.cost ?? 0) > 0 && (
            <span className="meta-cost" title="Cost">${formatCost(meta.cost!)}</span>
          )}
          <span title="Input tokens">↓{formatTokens(meta.usage.inputTokens)}</span>
          <span title="Output tokens">↑{formatTokens(meta.usage.outputTokens)}</span>
          {(meta.usage.reasoningTokens ?? 0) > 0 && (
            <span title="Reasoning tokens">◉{formatTokens(meta.usage.reasoningTokens!)}</span>
          )}
          {(meta.usage.cachedInputTokens ?? 0) > 0 && (
            <span title="Cached input tokens">⚡{formatTokens(meta.usage.cachedInputTokens!)}</span>
          )}
          <span title="Total tokens">Σ{formatTokens(meta.usage.totalTokens)}</span>
          {meta.latencyMs != null && (
            <span title="Response time">{formatLatency(meta.latencyMs)}</span>
          )}
          {meta.steps != null && meta.steps > 1 && (
            <span title="Steps">{meta.steps} steps</span>
          )}
        </div>
      )}
    </div>
  );
}

// ── Text Part ───────────────────────────────────────────────────────

function TextPart({ text }: { text: string }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ref.current) return;
    ref.current.querySelectorAll('pre').forEach((pre) => {
      if (pre.querySelector('.code-copy-btn')) return;
      const btn = document.createElement('button');
      btn.className = 'code-copy-btn';
      btn.textContent = 'Copy';
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const code =
          pre.querySelector('code')?.textContent || pre.textContent || '';
        try {
          await navigator.clipboard.writeText(code);
          btn.textContent = 'Copied!';
          btn.classList.add('copied');
          setTimeout(() => {
            btn.textContent = 'Copy';
            btn.classList.remove('copied');
          }, 2000);
        } catch {}
      });
      pre.style.position = 'relative';
      pre.appendChild(btn);
    });
  }, [text]);

  return (
    <div ref={ref} dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />
  );
}

// ── Tool Part ───────────────────────────────────────────────────────

interface DynamicToolPart {
  type: string;
  toolName: string;
  toolCallId: string;
  state: string;
  input?: unknown;
  output?: unknown;
  errorText?: string;
}

function ToolPart({ part }: { part: DynamicToolPart }) {
  const { toolName, state, input: toolInput, output, errorText } = part;
  const isPending = state === 'input-streaming' || state === 'input-available';
  const hasOutput = state === 'output-available';
  const hasError = state === 'output-error';
  const shouldAutoExpand = AUTO_EXPAND_TOOLS.has(toolName);
  const [expanded, setExpanded] = useState(shouldAutoExpand);
  const summary = getToolSummary(toolName, toolInput);
  const displayName = getToolDisplayName(toolName);

  // Parse output once
  const parsedOutput = useMemo(() => {
    if (!hasOutput || output == null) return null;
    if (typeof output === 'string') {
      try { return JSON.parse(output); } catch { return output; }
    }
    return output;
  }, [hasOutput, output]);

  // Render custom detail content based on tool type
  const renderDetail = () => {
    if (hasError) {
      return <pre className="tool-error-output">{errorText}</pre>;
    }
    if (!hasOutput) return null;

    const data = parsedOutput as Record<string, unknown> | null;
    const inputData = (toolInput || {}) as Record<string, unknown>;

    switch (toolName) {
      case 'task_complete': {
        const summaryText = String(inputData.summary || data?.summary || '');
        if (!summaryText) return null;
        return (
          <div className="tool-custom-content">
            <div
              className="tool-markdown-output"
              dangerouslySetInnerHTML={{ __html: renderMarkdown(summaryText) }}
            />
          </div>
        );
      }

      case 'think': {
        const thought = String(inputData.thought || '');
        if (!thought) return null;
        return (
          <div className="tool-custom-content">
            <div className="tool-think-output">{thought}</div>
          </div>
        );
      }

      case 'shell_exec': {
        const stdout = String(data?.stdout || '');
        const stderr = String(data?.stderr || '');
        const exitCode = data?.exitCode as number | undefined;
        const duration = data?.durationMs as number | undefined;
        return (
          <div className="tool-custom-content">
            {exitCode != null && (
              <div className="tool-shell-meta">
                <span className={exitCode === 0 ? 'tool-exit-ok' : 'tool-exit-fail'}>
                  exit {exitCode}
                </span>
                {duration != null && <span className="tool-duration">{duration < 1000 ? `${Math.round(duration)}ms` : `${(duration / 1000).toFixed(1)}s`}</span>}
              </div>
            )}
            {stdout && <pre className="tool-shell-output">{stdout.length > 5000 ? stdout.slice(0, 5000) + '\n… [truncated]' : stdout}</pre>}
            {stderr && <pre className="tool-shell-stderr">{stderr.length > 3000 ? stderr.slice(0, 3000) + '\n… [truncated]' : stderr}</pre>}
          </div>
        );
      }

      case 'file_read': {
        const content = String(data?.content || '');
        const totalLines = data?.totalLines as number | undefined;
        return (
          <div className="tool-custom-content">
            {totalLines != null && <div className="tool-file-meta">{totalLines} lines</div>}
            {content && <pre className="tool-file-output">{content.length > 5000 ? content.slice(0, 5000) + '\n… [truncated]' : content}</pre>}
          </div>
        );
      }

      case 'file_write': {
        const bytesWritten = data?.bytesWritten as number | undefined;
        return (
          <div className="tool-custom-content">
            {bytesWritten != null && <div className="tool-file-meta">{bytesWritten} bytes written</div>}
          </div>
        );
      }

      case 'file_edit': {
        const diff = String(data?.diff || '');
        return (
          <div className="tool-custom-content">
            {diff && <pre className="tool-diff-output">{diff.length > 5000 ? diff.slice(0, 5000) + '\n… [truncated]' : diff}</pre>}
          </div>
        );
      }

      case 'grep': {
        const matches = data?.matches as Array<{ file: string; line: number; content: string }> | undefined;
        const count = data?.count as number | undefined;
        return (
          <div className="tool-custom-content">
            {count != null && <div className="tool-file-meta">{count} match{count !== 1 ? 'es' : ''}</div>}
            {matches && matches.length > 0 && (
              <div className="tool-grep-results">
                {matches.slice(0, 50).map((m, i) => (
                  <div key={i} className="tool-grep-line">
                    <span className="tool-grep-file">{m.file}</span>
                    <span className="tool-grep-linenum">:{m.line}</span>
                    <span className="tool-grep-content">{m.content}</span>
                  </div>
                ))}
                {matches.length > 50 && <div className="tool-file-meta">… and {matches.length - 50} more</div>}
              </div>
            )}
          </div>
        );
      }

      case 'glob': {
        const matches = data?.matches as string[] | undefined;
        const count = data?.count as number | undefined;
        return (
          <div className="tool-custom-content">
            {count != null && <div className="tool-file-meta">{count} file{count !== 1 ? 's' : ''}</div>}
            {matches && matches.length > 0 && (
              <pre className="tool-file-output">{matches.slice(0, 100).join('\n')}{matches.length > 100 ? '\n… [truncated]' : ''}</pre>
            )}
          </div>
        );
      }

      case 'list_dir': {
        const entries = data?.entries as Array<{ name: string; type: string; size?: number }> | undefined;
        const count = data?.count as number | undefined;
        return (
          <div className="tool-custom-content">
            {count != null && <div className="tool-file-meta">{count} entr{count !== 1 ? 'ies' : 'y'}</div>}
            {entries && entries.length > 0 && (
              <div className="tool-dir-entries">
                {entries.slice(0, 100).map((e, i) => (
                  <div key={i} className="tool-dir-entry">
                    <span className={`tool-dir-icon${e.type === 'directory' ? ' dir' : ''}`}>{e.type === 'directory' ? '📁' : '📄'}</span>
                    <span className="tool-dir-name">{e.name}</span>
                    {e.size != null && <span className="tool-dir-size">{e.size > 1024 ? `${(e.size / 1024).toFixed(1)}KB` : `${e.size}B`}</span>}
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      }

      case 'http_fetch': {
        const respStatus = data?.status as number | undefined;
        const statusText = String(data?.statusText || '');
        const body = String(data?.body || '');
        return (
          <div className="tool-custom-content">
            {respStatus != null && (
              <div className="tool-shell-meta">
                <span className={respStatus < 400 ? 'tool-exit-ok' : 'tool-exit-fail'}>
                  {respStatus} {statusText}
                </span>
              </div>
            )}
            {body && <pre className="tool-file-output">{body.length > 5000 ? body.slice(0, 5000) + '\n… [truncated]' : body}</pre>}
          </div>
        );
      }

      case 'shell_exec_bg': {
        const pid = data?.pid as number | undefined;
        const action = inputData.action as string | undefined;
        const running = data?.running as boolean | undefined;
        const stdout = String(data?.stdout || '');
        const stderr = String(data?.stderr || '');
        return (
          <div className="tool-custom-content">
            {pid != null && (
              <div className="tool-shell-meta">
                <span>PID {pid}</span>
                {running != null && (
                  <span className={running ? 'tool-exit-ok' : 'tool-exit-fail'}>
                    {running ? 'running' : 'stopped'}
                  </span>
                )}
              </div>
            )}
            {stdout && <pre className="tool-shell-output">{stdout.length > 3000 ? stdout.slice(0, 3000) + '\n… [truncated]' : stdout}</pre>}
            {stderr && <pre className="tool-shell-stderr">{stderr.length > 1000 ? stderr.slice(0, 1000) + '\n… [truncated]' : stderr}</pre>}
          </div>
        );
      }

      case 'code_search': {
        const matches = data?.matches as Array<{ file: string; line: number; content: string }> | undefined;
        const totalMatches = data?.totalMatches as number | undefined;
        const engine = String(data?.engine || '');
        return (
          <div className="tool-custom-content">
            {totalMatches != null && (
              <div className="tool-file-meta">
                {totalMatches} match{totalMatches !== 1 ? 'es' : ''}
                {engine && <span style={{ opacity: 0.6, marginLeft: 8 }}> via {engine}</span>}
              </div>
            )}
            {matches && matches.length > 0 && (
              <div className="tool-grep-results">
                {matches.slice(0, 50).map((m, i) => (
                  <div key={i} className="tool-grep-line">
                    <span className="tool-grep-file">{m.file}</span>
                    <span className="tool-grep-linenum">:{m.line}</span>
                    <span className="tool-grep-content">{m.content}</span>
                  </div>
                ))}
                {matches.length > 50 && <div className="tool-file-meta">… and {matches.length - 50} more</div>}
              </div>
            )}
          </div>
        );
      }

      case 'multi_file_edit': {
        const results = data?.results as Array<{ path: string; success: boolean; diff?: string; error?: string }> | undefined;
        const filesModified = data?.filesModified as number | undefined;
        return (
          <div className="tool-custom-content">
            {filesModified != null && (
              <div className="tool-file-meta">{filesModified} file{filesModified !== 1 ? 's' : ''} modified</div>
            )}
            {results && results.map((r, i) => (
              <div key={i} className="tool-multi-edit-file">
                <div className={`tool-multi-edit-path ${r.success ? 'ok' : 'fail'}`}>
                  {r.success ? '✓' : '✗'} {r.path}
                </div>
                {r.diff && (
                  <pre className="tool-diff-output">{r.diff.length > 2000 ? r.diff.slice(0, 2000) + '\n…' : r.diff}</pre>
                )}
                {r.error && <div className="tool-error-output">{r.error}</div>}
              </div>
            ))}
          </div>
        );
      }

      case 'system_info': {
        if (!data || typeof data !== 'object') return null;
        const entries = Object.entries(data as Record<string, unknown>);
        return (
          <div className="tool-custom-content">
            <div className="tool-sysinfo">
              {entries.map(([k, v]) => (
                <div key={k} className="tool-sysinfo-row">
                  <span className="tool-sysinfo-key">{k}</span>
                  <span className="tool-sysinfo-val">{String(v)}</span>
                </div>
              ))}
            </div>
          </div>
        );
      }

      default: {
        // Generic fallback: JSON dump
        const outputStr = typeof output === 'string' ? output : JSON.stringify(output, null, 2);
        const truncated = outputStr.length > 5000 ? outputStr.slice(0, 5000) + '\n… [truncated]' : outputStr;
        return (
          <div className="tool-custom-content">
            <pre className="tool-file-output">{truncated}</pre>
          </div>
        );
      }
    }
  };

  return (
    <div className={`tool-inline${shouldAutoExpand && hasOutput ? ' tool-auto-expanded' : ''}`}>
      <div className="tool-inline-row" onClick={() => setExpanded(!expanded)}>
        <span className="tool-inline-status">
          {isPending && <span className="mu-spin" />}
          {hasOutput && <span className="tool-status-done">✓</span>}
          {hasError && <span className="tool-status-error">✗</span>}
        </span>
        {isPending && <span className="tool-inline-label">running</span>}
        <span className="tool-inline-name">{displayName}</span>
        {summary && <span className="tool-inline-summary">{summary}</span>}
        {(hasOutput || hasError) && (
          <span className={`tool-expand-icon${expanded ? ' open' : ''}`}>
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
              <path d="M2.5 4L5 6.5L7.5 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </span>
        )}
      </div>
      {expanded && (hasOutput || hasError) && (
        <div className="tool-inline-detail">
          {renderDetail()}
        </div>
      )}
    </div>
  );
}

// ── Empty State ─────────────────────────────────────────────────────

const EXAMPLE_PROMPTS = [
  { label: 'List files', prompt: 'What files are in the current directory?' },
  { label: 'System info', prompt: 'What OS am I running?' },
  {
    label: 'Analyze project',
    prompt: 'Read the package.json and summarize this project',
  },
  {
    label: 'Find TODOs',
    prompt: 'Find all TODO comments in the codebase',
  },
];

function EmptyState({ onPrompt }: { onPrompt: (text: string) => void }) {
  return (
    <div className="empty-state">
      <div className="logo">μ</div>
      <div className="tagline">AI agent with full local machine access</div>
      <div className="example-prompts">
        {EXAMPLE_PROMPTS.map((ex) => (
          <button
            key={ex.label}
            className="example-prompt"
            onClick={() => onPrompt(ex.prompt)}
          >
            {ex.label}
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Permission Modal ────────────────────────────────────────────────

interface PendingPermission {
  id: string;
  toolName: string;
  description: string;
  input?: unknown;
  createdAt: string;
}

function PermissionModal({ permission, onRespond }: {
  permission: PendingPermission;
  onRespond: (id: string, decision: 'yes' | 'no' | 'always') => void;
}) {
  const inputStr = permission.input
    ? JSON.stringify(permission.input, null, 2)
    : null;

  return (
    <div className="permission-overlay">
      <div className="permission-modal">
        <div className="permission-header">
          <span className="permission-icon">🔐</span>
          <span className="permission-title">Permission Required</span>
        </div>
        <div className="permission-body">
          <div className="permission-tool-name">{permission.toolName}</div>
          <div className="permission-description">{permission.description}</div>
          {inputStr && (
            <pre className="permission-input">{
              inputStr.length > 500 ? inputStr.slice(0, 500) + '\n…' : inputStr
            }</pre>
          )}
        </div>
        <div className="permission-actions">
          <button
            className="permission-btn permission-deny"
            onClick={() => onRespond(permission.id, 'no')}
          >
            Deny
          </button>
          <button
            className="permission-btn permission-allow-once"
            onClick={() => onRespond(permission.id, 'yes')}
          >
            Allow Once
          </button>
          <button
            className="permission-btn permission-allow-always"
            onClick={() => onRespond(permission.id, 'always')}
          >
            Allow Always
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Step Timeline ───────────────────────────────────────────────────

interface StepInfo {
  index: number;
  toolCalls: Array<{ toolName: string; state: string; errorText?: string }>;
  hasText: boolean;
}

function buildSteps(parts: Array<{ type: string; [key: string]: unknown }>): StepInfo[] {
  const steps: StepInfo[] = [];
  let current: StepInfo | null = null;

  for (const part of parts) {
    if (part.type === 'step-start') {
      current = { index: steps.length + 1, toolCalls: [], hasText: false };
      steps.push(current);
    } else if (current) {
      const partType = part.type as string;
      if (partType === 'dynamic-tool' || partType.startsWith('tool-')) {
        const tp = part as any;
        const toolName: string = tp.toolName ?? partType.slice(5);
        if (toolName) {
          current.toolCalls.push({ toolName, state: tp.state ?? '', errorText: tp.errorText });
        }
      } else if (part.type === 'text' && typeof part.text === 'string' && (part.text as string).trim()) {
        current.hasText = true;
      }
    }
  }
  return steps;
}

function StepTimeline({ parts }: { parts: Array<{ type: string; [key: string]: unknown }> }) {
  const [open, setOpen] = useState(false);
  const steps = buildSteps(parts);
  if (steps.length < 2) return null; // only meaningful for multi-step

  return (
    <div className="step-timeline">
      <button className="step-timeline-toggle" onClick={() => setOpen((o) => !o)}>
        <svg
          className={`timeline-chevron${open ? ' open' : ''}`}
          width="10" height="10" viewBox="0 0 10 10" fill="none"
        >
          <path d="M2.5 4L5 6.5L7.5 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
        <span>{steps.length} steps</span>
      </button>
      {open && (
        <div className="step-timeline-body">
          {steps.map((step) => (
            <div key={step.index} className="step-timeline-row">
              <span className="step-timeline-num">Step {step.index}</span>
              <div className="step-timeline-calls">
                {step.toolCalls.map((tc, i) => (
                  <span
                    key={i}
                    className={`step-timeline-tool${tc.state === 'output-error' ? ' error' : ''}`}
                  >
                    {getToolDisplayName(tc.toolName)}
                  </span>
                ))}
                {step.hasText && step.toolCalls.length === 0 && (
                  <span className="step-timeline-tool text">text response</span>
                )}
                {step.hasText && step.toolCalls.length > 0 && (
                  <span className="step-timeline-tool text">+ response</span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

