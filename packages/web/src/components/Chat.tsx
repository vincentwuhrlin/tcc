import { useState, useRef, useEffect, type FormEvent, type KeyboardEvent, type Dispatch, type SetStateAction } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Workspace, ChatMessage, DebugPayload } from "../App";
import { DebugPanel } from "./DebugPanel";

interface Source {
  source: string;
  score: number;
}

interface Timing {
  embed_ms: number;
  search_ms: number;
  llm_ms: number;
  total_ms: number;
}

interface ChatProps {
  workspace: Workspace | null;
  messages: ChatMessage[];
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  activeSessionId: string | null;
  ensureSession: () => Promise<string>;
  onMessageSent: () => void;
}

/* ── Markdown renderer using react-markdown + GFM ─────────────────── */
const remarkPlugins = [remarkGfm];

function MarkdownContent({ content }: { content: string }) {
  return (
    <Markdown
      remarkPlugins={remarkPlugins}
      components={{
        // Fenced code blocks: ```lang ... ```
        pre({ children }) {
          return <pre className="msg-code-block">{children}</pre>;
        },
        // Code: inline `code` or <code> inside <pre>
        code({ className, children, ...props }) {
          const isBlock = className?.startsWith("language-");
          if (isBlock) {
            const lang = className.replace("language-", "");
            return (
              <code className="msg-code-content" data-lang={lang} {...props}>
                {children}
              </code>
            );
          }
          // Inline code
          return (
            <code className="msg-inline-code" {...props}>
              {children}
            </code>
          );
        },
        // Blockquote
        blockquote({ children }) {
          return <blockquote className="msg-blockquote">{children}</blockquote>;
        },
        // Paragraphs
        p({ children }) {
          return <p className="msg-paragraph">{children}</p>;
        },
        // Headings
        h1({ children }) { return <h3 className="msg-heading msg-h1">{children}</h3>; },
        h2({ children }) { return <h4 className="msg-heading msg-h2">{children}</h4>; },
        h3({ children }) { return <h5 className="msg-heading msg-h3">{children}</h5>; },
        // Lists
        ul({ children }) { return <ul className="msg-list msg-ul">{children}</ul>; },
        ol({ children }) { return <ol className="msg-list msg-ol">{children}</ol>; },
        li({ children }) { return <li className="msg-li">{children}</li>; },
        // Tables
        table({ children }) { return <div className="msg-table-wrap"><table className="msg-table">{children}</table></div>; },
        thead({ children }) { return <thead className="msg-thead">{children}</thead>; },
        th({ children }) { return <th className="msg-th">{children}</th>; },
        td({ children }) { return <td className="msg-td">{children}</td>; },
        // Links
        a({ href, children }) {
          return <a className="msg-link" href={href} target="_blank" rel="noopener noreferrer">{children}</a>;
        },
        // Horizontal rule
        hr() { return <hr className="msg-hr" />; },
      }}
    >
      {content}
    </Markdown>
  );
}

/* ── Message toolbar (hover actions) ───────────────────────────────── */
function MessageToolbar({ content, role, onTag }: { content: string; role: "user" | "assistant"; onTag?: () => void }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(content);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = content;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className={`message-toolbar message-toolbar-${role}`}>
      <button
        className={`toolbar-action ${copied ? "toolbar-action-done" : ""}`}
        onClick={handleCopy}
        title={copied ? "Copied!" : "Copy"}
        aria-label={copied ? "Copied" : "Copy"}
      >
        {copied ? (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        ) : (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
          </svg>
        )}
      </button>
      {role === "assistant" && onTag && (
        <button
          className="toolbar-action"
          onClick={onTag}
          title="Save to Workspace"
          aria-label="Save to Workspace"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M7 10v12" /><path d="M15 5.88L14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2h0a3.13 3.13 0 0 1 3 3.88z" />
          </svg>
        </button>
      )}
    </div>
  );
}

/* ── QA Tag Modal ────────────────────────────────────────────────────── */
interface QaTagTarget {
  question: string;
  answer: string;
}

function QaTagModal({ target, sessionId, onClose, onSaved }: {
  target: QaTagTarget;
  sessionId: string | null;
  onClose: () => void;
  onSaved: (id: string) => void;
}) {
  const [phase, setPhase] = useState<"loading" | "editing" | "saving" | "error">("loading");
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState("");
  const [condensed, setCondensed] = useState("");
  const [categories, setCategories] = useState<string[]>([]);
  const [error, setError] = useState("");

  // Auto-call prepare on mount
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const res = await fetch("/api/qa/prepare", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ question: target.question, answer: target.answer }),
        });
        if (!res.ok) throw new Error(`Server error: ${res.status}`);
        const data = await res.json() as { title: string; category: string; condensed: string; categories: string[] };
        if (cancelled) return;
        setTitle(data.title);
        setCategory(data.category);
        setCondensed(data.condensed);
        setCategories(data.categories);
        setPhase("editing");
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Prepare failed");
        setPhase("error");
      }
    })();

    return () => { cancelled = true; };
  }, [target]);

  const handleSave = async () => {
    setPhase("saving");
    try {
      const res = await fetch("/api/qa/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question: target.question,
          answer: target.answer,
          title, category, condensed, sessionId,
        }),
      });
      if (!res.ok) throw new Error(`Server error: ${res.status}`);
      const data = await res.json() as { ok: boolean; id: string };
      onSaved(data.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
      setPhase("error");
    }
  };

  return (
    <div className="qa-modal-overlay" onClick={onClose}>
      <div className="qa-modal" onClick={(e) => e.stopPropagation()}>
        <div className="qa-modal-header">
          <span className="qa-modal-icon">👍</span>
          <span className="qa-modal-title">Save to Workspace</span>
          <button className="qa-modal-close" onClick={onClose}>×</button>
        </div>

        {phase === "loading" && (
          <div className="qa-modal-body qa-modal-center">
            <div className="qa-modal-spinner" />
            <p>Analyzing Q&A with LLM...</p>
          </div>
        )}

        {phase === "error" && (
          <div className="qa-modal-body qa-modal-center">
            <p className="qa-modal-error">❌ {error}</p>
            <button className="qa-btn qa-btn-secondary" onClick={onClose}>Close</button>
          </div>
        )}

        {(phase === "editing" || phase === "saving") && (
          <>
            <div className="qa-modal-body">
              <label className="qa-label">Title</label>
              <input
                className="qa-input"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                disabled={phase === "saving"}
              />

              <label className="qa-label">Category</label>
              <select
                className="qa-input qa-select"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                disabled={phase === "saving"}
              >
                {categories.map((cat) => (
                  <option key={cat} value={cat}>{cat}</option>
                ))}
                <option value="Uncategorized">Uncategorized</option>
              </select>

              <label className="qa-label">Condensed (for embedding)</label>
              <textarea
                className="qa-input qa-textarea"
                value={condensed}
                onChange={(e) => setCondensed(e.target.value)}
                rows={5}
                disabled={phase === "saving"}
              />

              <label className="qa-label">Preview</label>
              <div className="qa-preview">
                <div className="qa-preview-q">
                  <strong>Q:</strong> {target.question.length > 200 ? target.question.slice(0, 200) + "…" : target.question}
                </div>
                <div className="qa-preview-a">
                  <strong>A:</strong> {target.answer.length > 300 ? target.answer.slice(0, 300) + "…" : target.answer}
                </div>
              </div>
            </div>

            <div className="qa-modal-footer">
              <button className="qa-btn qa-btn-secondary" onClick={onClose} disabled={phase === "saving"}>
                Cancel
              </button>
              <button className="qa-btn qa-btn-primary" onClick={handleSave} disabled={phase === "saving" || !title.trim() || !condensed.trim()}>
                {phase === "saving" ? "Saving..." : "Save"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export function Chat({ workspace, messages, setMessages, activeSessionId, ensureSession, onMessageSent }: ChatProps) {
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [lastCompaction, setLastCompaction] = useState<{ totalMessages: number } | null>(null);
  const [debugOpen, setDebugOpen] = useState(false);
  const [qaTarget, setQaTarget] = useState<QaTagTarget | null>(null);
  const [toast, setToast] = useState<{ message: string; type: "success" | "error" } | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const userScrolledUpRef = useRef(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Only auto-scroll if user hasn't scrolled up during streaming
  useEffect(() => {
    if (!userScrolledUpRef.current) {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages]);

  // Detect user intentionally scrolling up (wheel or touch)
  useEffect(() => {
    const el = messagesContainerRef.current;
    if (!el) return;

    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0 && isLoading) {
        // Scrolling up while streaming → lock
        userScrolledUpRef.current = true;
      }
    };
    const onScroll = () => {
      if (!isLoading) return;
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 150;
      if (atBottom) {
        // User scrolled back to bottom → unlock
        userScrolledUpRef.current = false;
      }
    };

    el.addEventListener("wheel", onWheel, { passive: true });
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("scroll", onScroll);
    };
  }, [isLoading]);

  useEffect(() => {
    inputRef.current?.focus();
  }, [isLoading, activeSessionId]);

  // Auto-clear compaction banner after 5s
  useEffect(() => {
    if (!lastCompaction) return;
    const timer = setTimeout(() => setLastCompaction(null), 5000);
    return () => clearTimeout(timer);
  }, [lastCompaction]);

  // Ctrl+Shift+D to toggle debug panel
  useEffect(() => {
    const handler = (e: globalThis.KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && e.key === "D") {
        e.preventDefault();
        setDebugOpen((prev) => !prev);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // Auto-clear toast after 4s
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(timer);
  }, [toast]);

  // Find the user question preceding a given assistant message index
  const handleTag = (assistantMsgId: string | number) => {
    const idx = messages.findIndex((m) => m.id === assistantMsgId);
    if (idx < 1) return;
    // Walk backwards to find the preceding user message
    let question = "";
    for (let i = idx - 1; i >= 0; i--) {
      if (messages[i].role === "user") {
        question = messages[i].content;
        break;
      }
    }
    if (!question) return;
    setQaTarget({ question, answer: messages[idx].content });
  };

  const send = async () => {
    const text = input.trim();
    if (!text || isLoading) return;

    setInput("");
    setIsLoading(true);
    userScrolledUpRef.current = false; // snap back to bottom on new message

    // Reset textarea height
    if (inputRef.current) inputRef.current.style.height = "auto";

    try {
      // Ensure we have a session
      const sessionId = await ensureSession();

      // Optimistic: add user message to UI immediately
      const tempUserMsg: ChatMessage = {
        id: "temp-" + Date.now(),
        role: "user",
        content: text,
      };
      setMessages((prev) => [...prev, tempUserMsg]);

      // Create placeholder assistant message for streaming
      const assistantId = "resp-" + Date.now();
      const assistantMsg: ChatMessage = {
        id: assistantId,
        role: "assistant",
        content: "",
      };
      setMessages((prev) => [...prev, assistantMsg]);

      // SSE streaming fetch
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, message: text }),
      });

      if (!res.ok) {
        throw new Error(`Server error: ${res.status}`);
      }

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let streamedSources: Source[] | undefined;
      let streamedTiming: Timing | undefined;
      let streamedContext: { totalMessages: number; hasCompaction: boolean; windowSize: number } | undefined;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Parse SSE events from buffer
        const parts = buffer.split("\n\n");
        buffer = parts.pop()!; // keep incomplete event

        for (const part of parts) {
          for (const line of part.split("\n")) {
            if (!line.startsWith("data: ") && !line.startsWith("data:")) continue;
            const jsonStr = line.startsWith("data: ") ? line.slice(6) : line.slice(5);
            if (!jsonStr.trim()) continue;

            try {
              const event = JSON.parse(jsonStr) as Record<string, unknown>;

              if (event.type === "meta") {
                streamedSources = event.sources as Source[] | undefined;
                streamedContext = event.context as typeof streamedContext;
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === assistantId
                      ? { ...m, sources: streamedSources, context: streamedContext }
                      : m,
                  ),
                );
              } else if (event.type === "debug") {
                const debugData = event as unknown as { type: string } & DebugPayload;
                const { type: _, ...payload } = debugData;
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === assistantId
                      ? { ...m, debug: payload as DebugPayload }
                      : m,
                  ),
                );
              } else if (event.type === "delta") {
                const chunk = event.text as string;
                // Append text to assistant message
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === assistantId
                      ? { ...m, content: m.content + chunk }
                      : m,
                  ),
                );
              } else if (event.type === "done") {
                streamedTiming = event.timing as Timing | undefined;
                // Update with final timing
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === assistantId
                      ? { ...m, timing: streamedTiming }
                      : m,
                  ),
                );
              } else if (event.type === "error") {
                const errMsg = event.message as string;
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === assistantId
                      ? { ...m, content: `**Error** — ${errMsg}` }
                      : m,
                  ),
                );
              }
            } catch {
              // Ignore malformed JSON
            }
          }
        }
      }

      onMessageSent();

      // Show compaction banner if compaction happened
      if (streamedContext?.hasCompaction) {
        setLastCompaction({ totalMessages: streamedContext.totalMessages });
      }
    } catch (err) {
      const errorMsg: ChatMessage = {
        id: "err-" + Date.now(),
        role: "assistant",
        content: `**Error** — ${err instanceof Error ? err.message : "Connection lost"}`,
      };
      setMessages((prev) => [...prev, errorMsg]);
    } finally {
      setIsLoading(false);
    }
  };

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    send();
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const formatTime = (dateStr?: string) => {
    if (!dateStr) return "";
    return new Date(dateStr).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  };

  const stats = workspace?.stats;

  // ── Loading indicator with stages ──────────────────────────────────
  function LoadingIndicator({ messageCount }: { messageCount: number }) {
    const [phase, setPhase] = useState(0);
    const isLongSession = messageCount > 10;

    const phases = isLongSession
      ? ["Searching knowledge base", "Compacting session history", "Generating response"]
      : ["Searching knowledge base", "Generating response"];

    useEffect(() => {
      const timers: NodeJS.Timeout[] = [];
      for (let i = 1; i < phases.length; i++) {
        timers.push(setTimeout(() => setPhase(i), i * 1500));
      }
      return () => timers.forEach(clearTimeout);
    }, [phases.length]);

    return (
      <div className="loading-indicator">
        <div className="loading-progress">
          <div
            className="loading-bar"
            style={{ width: `${((phase + 1) / phases.length) * 100}%` }}
          />
        </div>
        <div className="loading-phases">
          {phases.map((label, i) => (
            <span
              key={label}
              className={`loading-phase ${i < phase ? "loading-phase-done" : ""} ${i === phase ? "loading-phase-active" : ""}`}
            >
              {i < phase ? "✓" : i === phase ? "›" : "·"} {label}
            </span>
          ))}
        </div>
      </div>
    );
  }

  // ── Sources component ──────────────────────────────────────────────
  function SourcesBlock({ sources, timing, context }: { sources?: Source[]; timing?: Timing; context?: { totalMessages: number; hasCompaction: boolean; windowSize: number } }) {
    const [expanded, setExpanded] = useState(false);

    if (!sources?.length && !timing) return null;

    return (
      <div className="msg-sources">
        <button className="sources-toggle" onClick={() => setExpanded(!expanded)}>
          <span className="sources-icon">{expanded ? "▾" : "▸"}</span>
          <span>{sources?.length ?? 0} sources</span>
          {timing && (
            <span className="sources-timing">{(timing.total_ms / 1000).toFixed(1)}s</span>
          )}
        </button>
        {expanded && (
          <div className="sources-list">
            {sources?.map((s, i) => (
              <div key={i} className="source-item">
                {s.source.startsWith("QA:") ? (
                  <span className="source-name source-name-qa">
                    <span className="source-qa-badge">QA</span>
                    {s.source.slice(4)}
                  </span>
                ) : (
                  <span className="source-name" style={{ color: "var(--purple, #7B3FE4)", fontWeight: 600 }}>{s.source}</span>
                )}
                <span className="source-score">{(s.score * 100).toFixed(0)}%</span>
              </div>
            ))}
            {timing && (
              <div className="source-timing-detail">
                embed {timing.embed_ms}ms · search {timing.search_ms}ms · LLM {timing.llm_ms}ms
              </div>
            )}
            {context && (
              <div className="source-timing-detail">
                {context.totalMessages} msgs in session{context.hasCompaction ? " · compacted" : ""} · window {context.windowSize}
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  // ── Auto-resize textarea ────────────────────────────────────────────
  const autoResize = (el: HTMLTextAreaElement) => {
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 200) + "px";
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    autoResize(e.target);
  };

  // ── Welcome screen ────────────────────────────────────────────────
  if (messages.length === 0 && !activeSessionId) {
    return (
      <div className="chat-container">
        <div className="welcome">
          <div className="welcome-icon">⚡</div>
          <h1 className="welcome-title">TCC</h1>
          <p className="welcome-subtitle">Transcript, Classify &amp; Chat!</p>

          {workspace && (
            <div className="welcome-workspace">
              <span className="welcome-workspace-dot" />
              {workspace.name} — {workspace.title}
            </div>
          )}

          {workspace?.description && (
            <p className="welcome-description">{workspace.description}</p>
          )}

          {stats && stats.documents > 0 && (
            <div className="welcome-stats">
              <div className="stat-chip">
                <span className="stat-value">{stats.documents}</span>
                <span className="stat-label">documents</span>
              </div>
              <div className="stat-chip">
                <span className="stat-value">{stats.planCategories}</span>
                <span className="stat-label">categories</span>
              </div>
              {stats.ragChunks != null && (
                <div className="stat-chip">
                  <span className="stat-value">{stats.ragChunks}</span>
                  <span className="stat-label">chunks</span>
                </div>
              )}
              <div className="stat-chip">
                <span className={`stat-dot ${stats.indexed ? "stat-dot-ok" : "stat-dot-off"}`} />
                <span className="stat-label">{stats.indexed ? "INDEX.md" : "no index"}</span>
              </div>
              {stats.ragReady != null && (
                <div className="stat-chip">
                  <span className={`stat-dot ${stats.ragReady ? "stat-dot-ok" : "stat-dot-off"}`} />
                  <span className="stat-label">RAG</span>
                </div>
              )}
            </div>
          )}

          <p className="welcome-hint">
            Ask a question about your knowledge base
          </p>
        </div>

        <form className="input-area" onSubmit={handleSubmit}>
          <div className="input-wrapper">
            <textarea
              ref={inputRef}
              className="input-field"
              value={input}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              placeholder="Ask a question..."
              rows={1}
              disabled={isLoading}
            />
            <button type="submit" className="send-button" disabled={!input.trim() || isLoading} aria-label="Send">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" />
              </svg>
            </button>
          </div>
          <div className="input-footer">
            <span>Release 6 — Markdown + Q&A tagging + debug stats</span>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <span>Shift+Enter for line break</span>
              <button
                type="button"
                onClick={() => setDebugOpen(!debugOpen)}
                title="Toggle debug panel (Ctrl+Shift+D)"
                style={{
                  background: debugOpen ? "var(--teal)" : "transparent",
                  color: debugOpen ? "#fff" : "inherit",
                  border: "1px solid var(--border)",
                  borderRadius: 4, padding: "2px 8px", cursor: "pointer",
                  fontSize: 11, fontWeight: 600, opacity: debugOpen ? 1 : 0.5,
                }}
              >
                🔬 Debug
              </button>
            </div>
          </div>
        </form>

        <DebugPanel messages={messages} visible={debugOpen} onClose={() => setDebugOpen(false)} />
      </div>
    );
  }

  // ── Chat view ─────────────────────────────────────────────────────
  return (
    <div className="chat-container">
      <div className="messages" ref={messagesContainerRef}>
        {messages.map((msg) => (
          <div key={msg.id} className={`message message-${msg.role}`}>
            {msg.role === "assistant" && msg.content === "" && isLoading ? (
              <div className="message-body">
                <LoadingIndicator messageCount={messages.length} />
              </div>
            ) : msg.role === "assistant" ? (
              <>
                <div className="message-body">
                  <div className="message-content">
                    <MarkdownContent content={msg.content} />
                  </div>
                  {msg.content !== "" && (
                    <SourcesBlock sources={msg.sources} timing={msg.timing} context={msg.context} />
                  )}
                </div>
                {msg.content !== "" && (
                  <MessageToolbar content={msg.content} role="assistant" onTag={() => handleTag(msg.id)} />
                )}
              </>
            ) : (
              <>
                <div className="message-content">
                  <MarkdownContent content={msg.content} />
                </div>
                {msg.content !== "" && (
                  <MessageToolbar content={msg.content} role="user" />
                )}
              </>
            )}
          </div>
        ))}

        {/* Compaction banner */}
        {lastCompaction && (
          <div className="compaction-banner">
            <span className="compaction-icon">⚡</span>
            Session history compacted ({lastCompaction.totalMessages} messages summarized)
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      <form className="input-area" onSubmit={handleSubmit}>
        <div className="input-wrapper">
          <textarea
            ref={inputRef}
            className="input-field"
            value={input}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            placeholder="Ask a question..."
            rows={1}
            disabled={isLoading}
          />
          <button type="submit" className="send-button" disabled={!input.trim() || isLoading} aria-label="Send">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" />
            </svg>
          </button>
        </div>
        <div className="input-footer">
          <span>Release 6 — Markdown + Q&A tagging + debug stats</span>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span>Shift+Enter for line break</span>
            <button
              type="button"
              onClick={() => setDebugOpen(!debugOpen)}
              title="Toggle debug panel (Ctrl+Shift+D)"
              style={{
                background: debugOpen ? "var(--teal)" : "transparent",
                color: debugOpen ? "#fff" : "inherit",
                border: "1px solid var(--border)",
                borderRadius: 4, padding: "2px 8px", cursor: "pointer",
                fontSize: 11, fontWeight: 600, opacity: debugOpen ? 1 : 0.5,
              }}
            >
              🔬 Debug
            </button>
          </div>
        </div>
      </form>

      <DebugPanel messages={messages} visible={debugOpen} onClose={() => setDebugOpen(false)} />

      {/* QA Tag Modal */}
      {qaTarget && (
        <QaTagModal
          target={qaTarget}
          sessionId={activeSessionId}
          onClose={() => setQaTarget(null)}
          onSaved={(id) => {
            setQaTarget(null);
            setToast({ message: `Saved: ${id}`, type: "success" });
          }}
        />
      )}

      {/* Toast notification */}
      {toast && (
        <div className={`qa-toast qa-toast-${toast.type}`}>
          <span>{toast.type === "success" ? "🏷️" : "❌"}</span>
          <span>{toast.message}</span>
        </div>
      )}
    </div>
  );
}
