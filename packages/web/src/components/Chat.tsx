import { useState, useRef, useEffect, type FormEvent, type KeyboardEvent, type Dispatch, type SetStateAction } from "react";
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
        <code key={match.index} className="msg-inline-code" style={{
          background: "rgba(192,163,244,0.12)", color: "#6b24e3",
          borderRadius: 4, padding: "2px 6px", fontWeight: 500,
        }}>
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
  const [debugOpen, setDebugOpen] = useState(false);
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
                <span className="source-name" style={{ color: "var(--purple, #7B3FE4)", fontWeight: 600 }}>{s.source}</span>
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
            <span>Release 5 — SSE streaming + debug panel</span>
            <span>Shift+Enter for line break</span>
          </div>
        </form>
      </div>
    );
  }

  // ── Chat view ─────────────────────────────────────────────────────
  return (
    <div className="chat-container">
      <div className="messages" ref={messagesContainerRef}>
        {messages.map((msg) => (
          <div key={msg.id} className={`message message-${msg.role}`}>
            {/* Show loading indicator for empty streaming assistant message */}
            {msg.role === "assistant" && msg.content === "" && isLoading ? (
              <LoadingIndicator messageCount={messages.length} />
            ) : (
              <div className="message-content">{renderMarkdown(msg.content)}</div>
            )}
            {msg.role === "assistant" && msg.content !== "" && (
              <SourcesBlock sources={msg.sources} timing={msg.timing} context={msg.context} />
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
          <span>Release 5 — SSE streaming + debug panel</span>
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
