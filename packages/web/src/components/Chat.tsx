import { useState, useRef, useEffect, type FormEvent, type KeyboardEvent } from "react";
import type { Workspace } from "../App";

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: Date;
}

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
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

export function Chat({ workspace }: { workspace: Workspace | null }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Auto-scroll on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Auto-focus input
  useEffect(() => {
    inputRef.current?.focus();
  }, [isLoading]);

  const send = async () => {
    const text = input.trim();
    if (!text || isLoading) return;

    const userMsg: Message = {
      id: generateId(),
      role: "user",
      content: text,
      timestamp: new Date(),
    };

    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setIsLoading(true);

    try {
      const allMessages = [...messages, userMsg].map(({ role, content }) => ({
        role,
        content,
      }));

      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: allMessages }),
      });

      if (!res.ok) throw new Error(`Server error: ${res.status}`);

      const data = await res.json();

      const assistantMsg: Message = {
        id: generateId(),
        role: "assistant",
        content: data.content,
        timestamp: new Date(),
      };

      setMessages((prev) => [...prev, assistantMsg]);
    } catch (err) {
      const errorMsg: Message = {
        id: generateId(),
        role: "assistant",
        content: `**Error** — ${err instanceof Error ? err.message : "Connection lost"}`,
        timestamp: new Date(),
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

  const formatTime = (date: Date) =>
    date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

  const stats = workspace?.stats;

  // ── Welcome screen ────────────────────────────────────────────────
  if (messages.length === 0) {
    return (
      <div className="chat-container">
        <div className="welcome">
          <div className="welcome-icon">⚡</div>
          <h1 className="welcome-title">TCC</h1>
          <p className="welcome-subtitle">Transcript, Classify &amp; Chat</p>

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
              <div className="stat-chip">
                <span className={`stat-dot ${stats.indexed ? "stat-dot-ok" : "stat-dot-off"}`} />
                <span className="stat-label">{stats.indexed ? "INDEX.md" : "no index"}</span>
              </div>
              <div className="stat-chip">
                <span className={`stat-dot ${stats.hasDomainContext ? "stat-dot-ok" : "stat-dot-off"}`} />
                <span className="stat-label">{stats.hasDomainContext ? "domain.md" : "no domain"}</span>
              </div>
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
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ask a question..."
              rows={1}
              disabled={isLoading}
            />
            <button
              type="submit"
              className="send-button"
              disabled={!input.trim() || isLoading}
              aria-label="Send"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="22" y1="2" x2="11" y2="13" />
                <polygon points="22 2 15 22 11 13 2 9 22 2" />
              </svg>
            </button>
          </div>
          <div className="input-footer">
            <span>Release 2 — Echo mode + workspace</span>
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
            <div className="message-avatar">
              {msg.role === "user" ? (
                <div className="avatar-user">V</div>
              ) : (
                <div className="avatar-assistant">⚡</div>
              )}
            </div>
            <div className="message-body">
              <div className="message-meta">
                <span className="message-sender">
                  {msg.role === "user" ? "You" : "TCC"}
                </span>
                <span className="message-time">{formatTime(msg.timestamp)}</span>
              </div>
              <div className="message-content">{renderMarkdown(msg.content)}</div>
            </div>
          </div>
        ))}

        {isLoading && (
          <div className="message message-assistant">
            <div className="message-avatar">
              <div className="avatar-assistant">⚡</div>
            </div>
            <div className="message-body">
              <div className="typing-indicator">
                <span /><span /><span />
              </div>
            </div>
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
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask a question..."
            rows={1}
            disabled={isLoading}
          />
          <button
            type="submit"
            className="send-button"
            disabled={!input.trim() || isLoading}
            aria-label="Send"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="22" y1="2" x2="11" y2="13" />
              <polygon points="22 2 15 22 11 13 2 9 22 2" />
            </svg>
          </button>
        </div>
        <div className="input-footer">
          <span>Release 2 — Echo mode + workspace</span>
          <span>Shift+Enter for line break</span>
        </div>
      </form>
    </div>
  );
}
