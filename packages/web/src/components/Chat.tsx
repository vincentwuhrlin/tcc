import { useState, useRef, useEffect, type FormEvent, type KeyboardEvent, type Dispatch, type SetStateAction } from "react";
import type { Workspace, ChatMessage } from "../App";

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

/** Minimal markdown: **bold**, _italic_, `code`, > blockquote, \n */
function renderMarkdown(text: string) {
  const lines = text.split("\n");
  const elements: React.ReactNode[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith("> ")) {
      elements.push(
        <blockquote key={i} className="msg-blockquote">
          {formatInline(line.slice(2))}
        </blockquote>,
      );
    } else if (line.trim() === "") {
      elements.push(<br key={i} />);
    } else {
      elements.push(
        <p key={i} className="msg-paragraph">
          {formatInline(line)}
        </p>,
      );
    }
  }

  return elements;
}

function formatInline(text: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  const regex = /(\*\*(.+?)\*\*)|(_(.+?)_)|(`(.+?)`)/g;
  let lastIndex = 0;
  let match;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }

    if (match[1]) {
      parts.push(<strong key={match.index}>{match[2]}</strong>);
    } else if (match[3]) {
      parts.push(<em key={match.index}>{match[4]}</em>);
    } else if (match[5]) {
      parts.push(
        <code key={match.index} className="msg-inline-code">
          {match[6]}
        </code>,
      );
    }

    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  return parts;
}

export function Chat({ workspace, messages, setMessages, activeSessionId, ensureSession, onMessageSent }: ChatProps) {
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [lastCompaction, setLastCompaction] = useState<{ totalMessages: number } | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    inputRef.current?.focus();
  }, [isLoading, activeSessionId]);

  // Auto-clear compaction banner after 5s
  useEffect(() => {
    if (!lastCompaction) return;
    const timer = setTimeout(() => setLastCompaction(null), 5000);
    return () => clearTimeout(timer);
  }, [lastCompaction]);

  const send = async () => {
    const text = input.trim();
    if (!text || isLoading) return;

    setInput("");
    setIsLoading(true);

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

      // Call API with sessionId
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, message: text }),
      });

      let data: Record<string, unknown>;
      try {
        data = await res.json();
      } catch {
        throw new Error(`Server error: ${res.status}`);
      }

      // Server returns error message in body even on 500
      if (!res.ok) {
        const msg = typeof data.content === "string"
          ? data.content.replace("**Error** — ", "")
          : `Server error: ${res.status}`;
        throw new Error(msg);
      }

      const assistantMsg: ChatMessage = {
        id: "resp-" + Date.now(),
        role: "assistant",
        content: data.content,
        sources: data.sources,
        timing: data.timing,
        context: data.context,
      };

      setMessages((prev) => [...prev, assistantMsg]);
      onMessageSent();

      // Show compaction banner if compaction happened
      if (data.context?.hasCompaction) {
        setLastCompaction({ totalMessages: data.context.totalMessages });
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
                <span className="source-name">{s.source}</span>
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
            <span>Release 4 — RAG + sessions + compaction</span>
            <span>Shift+Enter for line break</span>
          </div>
        </form>
      </div>
    );
  }

  // ── Chat view ─────────────────────────────────────────────────────
  return (
    <div className="chat-container">
      <div className="messages">
        {messages.map((msg) => (
          <div key={msg.id} className={`message message-${msg.role}`}>
            <div className="message-content">{renderMarkdown(msg.content)}</div>
            {msg.role === "assistant" && <SourcesBlock sources={msg.sources} timing={msg.timing} context={msg.context} />}
          </div>
        ))}

        {isLoading && (
          <div className="message message-assistant">
            <LoadingIndicator messageCount={messages.length} />
          </div>
        )}

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
          <span>Release 4 — RAG + sessions + compaction</span>
          <span>Shift+Enter for line break</span>
        </div>
      </form>
    </div>
  );
}
