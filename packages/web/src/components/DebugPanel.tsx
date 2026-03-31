import { useState } from "react";
import type { ChatMessage, DebugPayload } from "../App";

interface DebugPanelProps {
  messages: ChatMessage[];
  visible: boolean;
  onClose: () => void;
}

function Section({ title, badge, children, defaultOpen = false }: {
  title: string; badge?: string; children: React.ReactNode; defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div style={{ borderBottom: "1px solid var(--debug-border)", paddingBottom: 8, marginBottom: 8 }}>
      <button
        onClick={() => setOpen(!open)}
        style={{
          background: "none", border: "none", cursor: "pointer", width: "100%",
          textAlign: "left", padding: "4px 0", display: "flex", alignItems: "center",
          gap: 8, color: "var(--debug-text)", fontWeight: 600, fontSize: 12,
        }}
      >
        <span style={{ fontSize: 10 }}>{open ? "▾" : "▸"}</span>
        <span>{title}</span>
        {badge && <span style={{ fontSize: 10, opacity: 0.6, fontWeight: 400 }}>{badge}</span>}
      </button>
      {open && <div style={{ paddingLeft: 16, paddingTop: 4, fontSize: 11 }}>{children}</div>}
    </div>
  );
}

function KV({ k, v, mono = false }: { k: string; v: string | number; mono?: boolean }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "1px 0", gap: 8 }}>
      <span style={{ opacity: 0.6 }}>{k}</span>
      <span style={{ fontFamily: mono ? "monospace" : "inherit", fontWeight: 500 }}>{v}</span>
    </div>
  );
}

function ChunkCard({ chunk, index }: { chunk: DebugPayload["rag"]["chunks"][0]; index: number }) {
  const [expanded, setExpanded] = useState(false);
  const scoreColor = chunk.score >= 0.7 ? "#22c55e" : chunk.score >= 0.5 ? "#eab308" : "#ef4444";

  return (
    <div style={{
      background: "var(--debug-card-bg)", borderRadius: 6, padding: "6px 8px", marginBottom: 4,
      border: "1px solid var(--debug-border)", fontSize: 11,
    }}>
      <div
        onClick={() => setExpanded(!expanded)}
        style={{ cursor: "pointer", display: "flex", alignItems: "center", gap: 6 }}
      >
        <span style={{
          background: scoreColor, color: "#000", borderRadius: 3,
          padding: "1px 5px", fontSize: 10, fontWeight: 700, minWidth: 36, textAlign: "center",
        }}>
          {(chunk.score * 100).toFixed(0)}%
        </span>
        <span style={{ fontWeight: 500, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          #{index + 1} {chunk.source}
        </span>
        <span style={{ opacity: 0.5, fontSize: 10 }}>{chunk.chars}c</span>
      </div>
      {expanded && (
        <pre style={{
          marginTop: 4, padding: 6, background: "var(--debug-pre-bg)", borderRadius: 4,
          whiteSpace: "pre-wrap", wordBreak: "break-word", fontSize: 10, lineHeight: 1.4,
          maxHeight: 200, overflowY: "auto", color: "var(--debug-text)",
        }}>
          {chunk.preview}{chunk.preview.length >= 300 ? "…" : ""}
        </pre>
      )}
    </div>
  );
}

function PromptBar({ label, chars, total }: { label: string; chars: number; total: number }) {
  const pct = total > 0 ? (chars / total) * 100 : 0;
  const colors: Record<string, string> = {
    instructions: "#8b5cf6", domain: "#06b6d4", plan: "#84cc16",
    ragContext: "#f59e0b", history: "#ec4899", summary: "#6366f1",
  };

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "2px 0" }}>
      <span style={{ width: 80, fontSize: 10, opacity: 0.7 }}>{label}</span>
      <div style={{ flex: 1, height: 10, background: "var(--debug-bar-bg)", borderRadius: 3, overflow: "hidden" }}>
        <div style={{
          width: `${Math.max(pct, 1)}%`, height: "100%",
          background: colors[label] ?? "#888", borderRadius: 3,
        }} />
      </div>
      <span style={{ fontSize: 10, fontFamily: "monospace", width: 50, textAlign: "right" }}>
        {chars > 1000 ? `${(chars / 1000).toFixed(1)}k` : chars}
      </span>
    </div>
  );
}

function DebugEntry({ debug, timing }: { debug: DebugPayload; timing?: ChatMessage["timing"] }) {
  return (
    <div>
      <Section title="Query" defaultOpen>
        <pre style={{
          background: "var(--debug-pre-bg)", padding: 6, borderRadius: 4,
          whiteSpace: "pre-wrap", wordBreak: "break-word", fontSize: 11,
        }}>
          {debug.query}
        </pre>
      </Section>

      <Section title="RAG Chunks" badge={`${debug.rag.returned}/${debug.rag.totalChunks} (top-${debug.rag.topK}, min ${(debug.rag.minScore * 100).toFixed(0)}%)`} defaultOpen>
        {debug.rag.chunks.length === 0 ? (
          <div style={{ opacity: 0.5, fontStyle: "italic" }}>No chunks matched</div>
        ) : (
          debug.rag.chunks.map((chunk, i) => <ChunkCard key={chunk.id} chunk={chunk} index={i} />)
        )}
      </Section>

      <Section title="Prompt Breakdown" badge={`${(debug.prompt.totalChars / 1000).toFixed(1)}k chars ≈ ${Math.round(debug.prompt.totalChars / 4)}tok`}>
        {(["instructions", "domain", "plan", "ragContext", "history", "summary"] as const).map((key) => (
          <PromptBar key={key} label={key} chars={debug.prompt[key]} total={debug.prompt.totalChars} />
        ))}
      </Section>

      <Section title="Session">
        <KV k="ID" v={debug.session.id} mono />
        <KV k="Messages" v={debug.session.totalMessages} />
        <KV k="Window" v={`${debug.session.windowSize} recent`} />
        <KV k="Compacted" v={debug.session.hasCompaction ? "Yes" : "No"} />
      </Section>

      <Section title="Config">
        <KV k="Provider" v={debug.config.provider} />
        <KV k="Model" v={debug.config.model} mono />
        <KV k="Streaming" v={debug.config.streaming ? "ON" : "OFF"} />
        <KV k="Embed" v={debug.config.embedEngine} />
      </Section>

      {timing && (
        <Section title="Timing" defaultOpen>
          <KV k="Embed" v={`${timing.embed_ms}ms`} />
          <KV k="Search" v={`${timing.search_ms}ms`} />
          <KV k="LLM" v={`${timing.llm_ms}ms`} />
          <KV k="Total" v={`${timing.total_ms}ms`} />
        </Section>
      )}
    </div>
  );
}

// ── Query sidebar item ──────────────────────────────────────────────

function QueryItem({ msg, index, total, selected, onClick }: {
  msg: ChatMessage; index: number; total: number; selected: boolean; onClick: () => void;
}) {
  const debug = msg.debug;
  const topScore = debug?.rag.chunks[0]?.score;
  const queryPreview = debug?.query
    ? (debug.query.length > 50 ? debug.query.slice(0, 50) + "…" : debug.query)
    : "…";

  return (
    <button
      onClick={onClick}
      style={{
        display: "block", width: "100%", textAlign: "left", cursor: "pointer",
        padding: "8px 10px", borderRadius: 6, border: "none", marginBottom: 4,
        background: selected ? "var(--debug-card-bg)" : "transparent",
        borderLeft: selected ? "3px solid #8b5cf6" : "3px solid transparent",
        color: "var(--debug-text)", transition: "all 0.15s",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 3 }}>
        <span style={{ fontSize: 10, opacity: 0.5, fontWeight: 600 }}>#{total - index}</span>
        {topScore != null && (
          <span style={{
            fontSize: 9, padding: "1px 4px", borderRadius: 3, fontWeight: 600,
            background: topScore >= 0.7 ? "#22c55e22" : topScore >= 0.5 ? "#eab30822" : "#ef444422",
            color: topScore >= 0.7 ? "#22c55e" : topScore >= 0.5 ? "#eab308" : "#ef4444",
          }}>
            {(topScore * 100).toFixed(0)}%
          </span>
        )}
        {debug && (
          <span style={{ fontSize: 9, opacity: 0.4 }}>{debug.rag.returned}ch</span>
        )}
        {msg.timing && (
          <span style={{ fontSize: 9, opacity: 0.4, marginLeft: "auto" }}>
            {(msg.timing.total_ms / 1000).toFixed(1)}s
          </span>
        )}
      </div>
      <div style={{
        fontSize: 11, lineHeight: 1.3, opacity: selected ? 1 : 0.7,
        overflow: "hidden", textOverflow: "ellipsis",
        display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" as const,
      }}>
        {queryPreview}
      </div>
    </button>
  );
}

// ── Main panel ──────────────────────────────────────────────────────

export function DebugPanel({ messages, visible, onClose }: DebugPanelProps) {
  const debugMessages = messages
    .filter((m) => m.role === "assistant" && m.debug)
    .reverse();

  const [selectedIndex, setSelectedIndex] = useState(0);
  const selected = debugMessages[selectedIndex];

  if (!visible) return null;

  return (
    <>
      <style>{`
        .debug-panel {
          --debug-bg: #1a1a2e;
          --debug-text: #e2e8f0;
          --debug-border: #2d2d44;
          --debug-card-bg: #16162a;
          --debug-pre-bg: #0f0f1e;
          --debug-bar-bg: #2d2d44;
          --debug-header-bg: #12122a;
          --debug-sidebar-bg: #141428;
        }
        [data-theme="light"] .debug-panel {
          --debug-bg: #f8fafc;
          --debug-text: #1e293b;
          --debug-border: #e2e8f0;
          --debug-card-bg: #ffffff;
          --debug-pre-bg: #f1f5f9;
          --debug-bar-bg: #e2e8f0;
          --debug-header-bg: #f1f5f9;
          --debug-sidebar-bg: #f1f5f9;
        }
      `}</style>
      <div className="debug-panel" style={{
        position: "fixed", top: 0, right: 0, bottom: 0, width: 820,
        background: "var(--debug-bg)", color: "var(--debug-text)",
        borderLeft: "1px solid var(--debug-border)", zIndex: 1000,
        display: "flex", flexDirection: "column",
        fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif",
      }}>
        {/* Header */}
        <div style={{
          padding: "10px 14px", borderBottom: "1px solid var(--debug-border)",
          display: "flex", alignItems: "center", justifyContent: "space-between",
          background: "var(--debug-header-bg)", flexShrink: 0,
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 16 }}>🔬</span>
            <span style={{ fontWeight: 700, fontSize: 13 }}>Debug Panel</span>
            <span style={{ fontSize: 10, opacity: 0.5 }}>{debugMessages.length} exchanges</span>
          </div>
          <button
            onClick={onClose}
            style={{
              background: "none", border: "none", color: "var(--debug-text)",
              cursor: "pointer", fontSize: 18, lineHeight: 1, padding: 4,
            }}
          >
            ×
          </button>
        </div>

        {/* Body: sidebar + content */}
        <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>

          {/* Left sidebar — query list */}
          <div style={{
            width: 200, flexShrink: 0, borderRight: "1px solid var(--debug-border)",
            background: "var(--debug-sidebar-bg)", overflowY: "auto", padding: 6,
          }}>
            {debugMessages.length === 0 ? (
              <div style={{ padding: 12, opacity: 0.4, fontSize: 11, textAlign: "center" }}>
                No queries yet
              </div>
            ) : (
              debugMessages.map((msg, i) => (
                <QueryItem
                  key={msg.id}
                  msg={msg}
                  index={i}
                  total={debugMessages.length}
                  selected={i === selectedIndex}
                  onClick={() => setSelectedIndex(i)}
                />
              ))
            )}
          </div>

          {/* Right content — debug details */}
          <div style={{ flex: 1, overflowY: "auto", padding: 14 }}>
            {selected?.debug ? (
              <DebugEntry debug={selected.debug} timing={selected.timing} />
            ) : (
              <div style={{ textAlign: "center", opacity: 0.5, paddingTop: 60 }}>
                <div style={{ fontSize: 32, marginBottom: 8 }}>🔍</div>
                <div style={{ fontSize: 13 }}>Ask a question to see debug data</div>
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
