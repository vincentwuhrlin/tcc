import { useState, useEffect } from "react";
import type { ChatMessage, DebugPayload } from "../App";

interface DebugPanelProps {
  messages: ChatMessage[];
  visible: boolean;
  onClose: () => void;
}

// ── Shared UI components ──────────────────────────────────────────────

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

function ColorBar({ label, value, max, color, tooltip }: { label: string; value: number; max: number; color: string; tooltip?: string }) {
  const pct = max > 0 ? (value / max) * 100 : 0;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "2px 0" }} title={tooltip}>
      <span style={{ width: 120, fontSize: 10, opacity: 0.7, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", cursor: tooltip ? "help" : "default" }}>{label}</span>
      <div style={{ flex: 1, height: 10, background: "var(--debug-bar-bg)", borderRadius: 3, overflow: "hidden" }}>
        <div style={{
          width: `${Math.max(pct, 1)}%`, height: "100%",
          background: color, borderRadius: 3,
        }} />
      </div>
      <span style={{ fontSize: 10, fontFamily: "monospace", width: 40, textAlign: "right" }}>
        {value}
      </span>
    </div>
  );
}

// ── Query debug components ─────────────────────────────────────────

function ChunkCard({ chunk, index }: { chunk: DebugPayload["rag"]["chunks"][0]; index: number }) {
  const [expanded, setExpanded] = useState(false);
  const scoreColor = chunk.score >= 0.7 ? "#22c55e" : chunk.score >= 0.5 ? "#eab308" : "#ef4444";
  const isQa = chunk.source.startsWith("QA:");

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
        <span style={{ fontWeight: 500, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", display: "flex", alignItems: "center", gap: 4 }}>
          {isQa && (
            <span style={{
              background: "#00857C", color: "#fff", borderRadius: 3,
              padding: "1px 4px", fontSize: 9, fontWeight: 700, flexShrink: 0,
            }}>QA</span>
          )}
          #{index + 1} {isQa ? chunk.source.slice(4) : chunk.source}
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

      {debug.deepSearch?.enabled && (
        <Section title="Deep Search" badge={`+${debug.deepSearch.pass2Count} new chunks via ${debug.deepSearch.subQueries.length} sub-queries`} defaultOpen>
          <KV k="Pass 1 (initial)" v={`${debug.deepSearch.pass1Count} chunks`} />
          <KV k="Pass 2 (deep)" v={`+${debug.deepSearch.pass2Count} new chunks`} />
          <KV k="Duplicates removed" v={debug.deepSearch.deduped} />
          <KV k="Final merged" v={`${debug.deepSearch.mergedCount} chunks`} />
          <div style={{ marginTop: 6, marginBottom: 2 }}>
            <span style={{ fontSize: 10, opacity: 0.6 }}>Timings</span>
          </div>
          <KV k="Sub-query gen" v={`${debug.deepSearch.timings.subQueryGenMs}ms`} />
          <KV k="Pass 2 embed" v={`${debug.deepSearch.timings.pass2EmbedMs}ms`} />
          <KV k="Pass 2 search" v={`${debug.deepSearch.timings.pass2SearchMs}ms`} />
          <KV k="Total deep search" v={`${debug.deepSearch.timings.totalMs}ms`} />
          {debug.deepSearch.subQueries.length > 0 && (
            <>
              <div style={{ marginTop: 6, marginBottom: 2 }}>
                <span style={{ fontSize: 10, opacity: 0.6 }}>LLM-generated sub-queries</span>
              </div>
              {debug.deepSearch.subQueries.map((sq, i) => (
                <div key={i} style={{
                  fontSize: 10, padding: "3px 8px", margin: "2px 0",
                  background: "var(--debug-pre-bg)", borderRadius: 4, lineHeight: 1.4,
                }}>
                  <span style={{ opacity: 0.4, marginRight: 4 }}>{i + 1}.</span> {sq}
                </div>
              ))}
            </>
          )}
        </Section>
      )}

      {!debug.deepSearch?.enabled && (
        <Section title="Deep Search" badge="OFF">
          <div style={{ opacity: 0.5, fontStyle: "italic", fontSize: 11 }}>
            Enable with CHAT_DEEP_SEARCH=true in .env
          </div>
        </Section>
      )}

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

// ── Queries Tab ─────────────────────────────────────────────────────

function QueriesTab({ messages }: { messages: ChatMessage[] }) {
  const debugMessages = messages
    .filter((m) => m.role === "assistant" && m.debug)
    .reverse();

  const [selectedIndex, setSelectedIndex] = useState(0);
  const selected = debugMessages[selectedIndex];

  return (
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
  );
}

// ── Workspace Stats Tab ─────────────────────────────────────────────

interface WorkspaceStats {
  workspace: { id: string; name: string; title: string };
  engine: { engine: string; model: string; dimensions: number; mode: string };
  rag: { ready: boolean; total: number; documents: number; qa: number; minScore: number; topK: number };
  sources: { source: string; cnt: number }[];
  qaList: { id: string; source: string; chars: number }[];
  categories: string[];
  categoryDistribution: { category: string; count: number }[];
  context: { hasInstructions: boolean; instructionsChars: number; hasDomain: boolean; domainChars: number; hasPlan: boolean; planChars: number; categoriesCount: number };
  sessions: { total: number; messages: number };
  compaction: { threshold: number; windowSize: number; interval: number };
}

function StatCard({ icon, label, value, sub }: { icon: string; label: string; value: string | number; sub?: string }) {
  return (
    <div style={{
      background: "var(--debug-card-bg)", border: "1px solid var(--debug-border)",
      borderRadius: 8, padding: "10px 12px", flex: "1 1 0",
      display: "flex", flexDirection: "column", alignItems: "center", gap: 2, minWidth: 80,
    }}>
      <span style={{ fontSize: 18 }}>{icon}</span>
      <span style={{ fontSize: 20, fontWeight: 700, fontFamily: "monospace", color: "var(--debug-text)" }}>{value}</span>
      <span style={{ fontSize: 10, opacity: 0.6, textAlign: "center" }}>{label}</span>
      {sub && <span style={{ fontSize: 9, opacity: 0.4 }}>{sub}</span>}
    </div>
  );
}

function WorkspaceTab() {
  const [stats, setStats] = useState<WorkspaceStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/workspace/stats");
        if (!res.ok) throw new Error(`${res.status}`);
        setStats(await res.json() as WorkspaceStats);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load stats");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  if (loading) {
    return (
      <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", opacity: 0.5 }}>
        Loading workspace stats...
      </div>
    );
  }

  if (error || !stats) {
    return (
      <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "#ef4444" }}>
        ❌ {error}
      </div>
    );
  }

  const maxSourceCount = stats.sources[0]?.cnt ?? 1;
  const sourceColors = ["#8b5cf6", "#06b6d4", "#f59e0b", "#ec4899", "#84cc16", "#6366f1", "#ef4444", "#14b8a6"];
  const regularSources = stats.sources.filter((s) => !s.source.startsWith("QA:"));

  return (
    <div style={{ flex: 1, overflowY: "auto", padding: 14 }}>
      {/* Workspace header */}
      <div style={{
        marginBottom: 14, padding: "10px 14px",
        background: "var(--debug-card-bg)", border: "1px solid var(--debug-border)", borderRadius: 8,
      }}>
        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>
          {stats.workspace.name} — {stats.workspace.title}
        </div>
        <div style={{ fontSize: 11, opacity: 0.5 }}>
          {stats.engine.engine} · {stats.engine.model} · {stats.engine.dimensions}d · {stats.engine.mode}
        </div>
      </div>

      {/* Stat cards row */}
      <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
        <StatCard icon="🧠" label="RAG Chunks" value={stats.rag.total} sub={stats.rag.ready ? "ready" : "offline"} />
        <StatCard icon="📄" label="Documents" value={stats.rag.documents} />
        <StatCard icon="👍" label="Q&A" value={stats.rag.qa} />
        <StatCard icon="💬" label="Sessions" value={stats.sessions.total} sub={`${stats.sessions.messages} msgs`} />
      </div>

      {/* RAG composition bar */}
      <Section title="RAG Composition" badge={`${stats.rag.total} total`} defaultOpen>
        <div style={{ display: "flex", height: 20, borderRadius: 6, overflow: "hidden", marginBottom: 8 }}>
          <div style={{
            width: `${(stats.rag.documents / stats.rag.total) * 100}%`,
            background: "#8b5cf6", display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 9, fontWeight: 700, color: "#fff", minWidth: stats.rag.documents > 0 ? 30 : 0,
          }}>
            {stats.rag.documents > 0 && stats.rag.documents}
          </div>
          <div style={{
            width: `${(stats.rag.qa / stats.rag.total) * 100}%`,
            background: "#00857C", display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 9, fontWeight: 700, color: "#fff", minWidth: stats.rag.qa > 0 ? 30 : 0,
          }}>
            {stats.rag.qa > 0 && stats.rag.qa}
          </div>
        </div>
        <div style={{ display: "flex", gap: 14, fontSize: 10 }}>
          <span><span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2, background: "#8b5cf6", marginRight: 4 }} />Documents ({stats.rag.documents})</span>
          <span><span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2, background: "#00857C", marginRight: 4 }} />Q&A ({stats.rag.qa})</span>
        </div>
        <div style={{ marginTop: 8 }}>
          <KV k="Top-K" v={stats.rag.topK} />
          <KV k="Min Score" v={`${(stats.rag.minScore * 100).toFixed(0)}%`} />
        </div>
      </Section>

      {/* Source distribution */}
      <Section title="Source Distribution" badge={`${regularSources.length} sources`}>
        {regularSources.slice(0, 15).map((s, i) => (
          <ColorBar
            key={s.source}
            label={s.source.length > 25 ? s.source.slice(0, 24) + "…" : s.source}
            value={s.cnt}
            max={maxSourceCount}
            color={sourceColors[i % sourceColors.length]}
            tooltip={s.source}
          />
        ))}
        {regularSources.length > 15 && (
          <div style={{ fontSize: 10, opacity: 0.5, paddingTop: 4 }}>
            + {regularSources.length - 15} more sources
          </div>
        )}
      </Section>

      {/* QA entries */}
      <Section title="Q&A Entries" badge={`${stats.rag.qa} saved`}>
        {stats.qaList.length === 0 ? (
          <div style={{ opacity: 0.5, fontStyle: "italic", fontSize: 11 }}>No Q&A entries yet</div>
        ) : (
          stats.qaList.map((qa) => (
            <div key={qa.id} style={{
              display: "flex", alignItems: "center", gap: 6, padding: "3px 0",
              fontSize: 11, borderBottom: "1px solid var(--debug-border)",
            }}>
              <span style={{
                background: "#00857C", color: "#fff", borderRadius: 3,
                padding: "1px 4px", fontSize: 9, fontWeight: 700, flexShrink: 0,
              }}>QA</span>
              <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {qa.source.startsWith("QA:") ? qa.source.slice(4) : qa.id}
              </span>
              <span style={{ fontSize: 10, opacity: 0.4, fontFamily: "monospace" }}>
                {qa.chars > 1000 ? `${(qa.chars / 1000).toFixed(1)}k` : qa.chars}c
              </span>
            </div>
          ))
        )}
      </Section>

      {/* Context files */}
      <Section title="Context Files" defaultOpen>
        <ColorBar label="instructions.md" value={stats.context.instructionsChars} max={Math.max(stats.context.instructionsChars, stats.context.domainChars, stats.context.planChars)} color="#8b5cf6" />
        <ColorBar label="domain.md" value={stats.context.domainChars} max={Math.max(stats.context.instructionsChars, stats.context.domainChars, stats.context.planChars)} color="#06b6d4" />
        <ColorBar label="PLAN.md headers" value={stats.context.planChars} max={Math.max(stats.context.instructionsChars, stats.context.domainChars, stats.context.planChars)} color="#84cc16" />
      </Section>

      {/* Categories distribution — grouped by main category */}
      <Section title="Categories" badge={`${stats.categories.length} from PLAN.md · ${stats.categoryDistribution.reduce((s, c) => s + c.count, 0)} chunks`} defaultOpen>
        {stats.categoryDistribution.length > 0 ? (
          (() => {
            const globalMax = Math.max(...stats.categoryDistribution.map((c) => c.count));

            // Heat color: green (low) → orange (mid) → red (high)
            const heatColor = (value: number) => {
              const t = globalMax > 0 ? value / globalMax : 0;
              if (t < 0.5) {
                // green → orange
                const r = Math.round(34 + (t * 2) * (234 - 34));
                const g = Math.round(197 + (t * 2) * (179 - 197));
                const b = Math.round(94 + (t * 2) * (8 - 94));
                return `rgb(${r},${g},${b})`;
              }
              // orange → red
              const t2 = (t - 0.5) * 2;
              const r = Math.round(234 + t2 * (239 - 234));
              const g = Math.round(179 - t2 * 179);
              const b = Math.round(8 + t2 * (68 - 8));
              return `rgb(${r},${g},${b})`;
            };

            // Group by main letter
            const groups = new Map<string, { main: string; subs: { category: string; count: number }[]; total: number }>();
            const mainCatNames = new Map(stats.categories.map((c) => {
              const m = c.match(/^([A-Z])\./);
              return [m?.[1] ?? "", c] as [string, string];
            }));

            for (const item of stats.categoryDistribution) {
              const letter = item.category.charAt(0);
              if (!groups.has(letter)) {
                groups.set(letter, {
                  main: mainCatNames.get(letter) ?? `${letter}. Unknown`,
                  subs: [],
                  total: 0,
                });
              }
              const g = groups.get(letter)!;
              g.subs.push(item);
              g.total += item.count;
            }

            return Array.from(groups.entries()).map(([letter, group]) => (
              <div key={letter} style={{ marginBottom: 10 }}>
                {/* Main category header */}
                <div style={{
                  display: "flex", justifyContent: "space-between", alignItems: "center",
                  padding: "4px 0 2px", fontWeight: 700, fontSize: 11,
                  borderBottom: "1px solid var(--debug-border)", marginBottom: 4,
                }}>
                  <span>{group.main}</span>
                  <span style={{ fontFamily: "monospace", opacity: 0.6, fontSize: 10 }}>{group.total}</span>
                </div>
                {/* Subcategories */}
                {group.subs.map((sub) => {
                  // Strip code prefix for cleaner label: "A.1 Name" → "Name"
                  const name = sub.category.replace(/^[A-Z]\.\d+\s*/, "");
                  const code = sub.category.match(/^([A-Z]\.\d+)/)?.[1] ?? "";
                  const pct = globalMax > 0 ? (sub.count / globalMax) * 100 : 0;
                  return (
                    <div key={sub.category} style={{ display: "flex", alignItems: "center", gap: 6, padding: "2px 0", paddingLeft: 12 }} title={sub.category}>
                      <span style={{ width: 28, fontSize: 10, opacity: 0.4, fontFamily: "monospace", flexShrink: 0 }}>{code}</span>
                      <span style={{ width: "40%", flexShrink: 0, fontSize: 10, opacity: 0.7, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</span>
                      <div style={{ flex: 1, height: 10, background: "var(--debug-bar-bg)", borderRadius: 3, overflow: "hidden", minWidth: 40 }}>
                        <div style={{
                          width: `${Math.max(pct, 1)}%`, height: "100%",
                          background: heatColor(sub.count), borderRadius: 3,
                        }} />
                      </div>
                      <span style={{ fontSize: 10, fontFamily: "monospace", width: 36, textAlign: "right", flexShrink: 0 }}>
                        {sub.count}
                      </span>
                    </div>
                  );
                })}
              </div>
            ));
          })()
        ) : (
          stats.categories.map((cat, i) => (
            <div key={cat} style={{ fontSize: 11, padding: "2px 0", display: "flex", gap: 6 }}>
              <span style={{ opacity: 0.4, fontFamily: "monospace", width: 16 }}>{String.fromCharCode(65 + i)}.</span>
              <span>{cat.replace(/^[A-Z]\.\s*/, "")}</span>
            </div>
          ))
        )}
      </Section>

      {/* Compaction config */}
      <Section title="Compaction">
        <KV k="Threshold" v={`${stats.compaction.threshold} messages`} />
        <KV k="Window" v={`${stats.compaction.windowSize} recent`} />
        <KV k="Interval" v={`every ${stats.compaction.interval}`} />
      </Section>
    </div>
  );
}

// ── Main panel ──────────────────────────────────────────────────────

export function DebugPanel({ messages, visible, onClose }: DebugPanelProps) {
  const [activeTab, setActiveTab] = useState<"queries" | "workspace">("workspace");

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
          </div>

          {/* Tabs */}
          <div style={{ display: "flex", gap: 2, background: "var(--debug-bar-bg)", borderRadius: 6, padding: 2 }}>
            {(["workspace", "queries"] as const).map((tab) => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                style={{
                  padding: "4px 12px", borderRadius: 4, border: "none", cursor: "pointer",
                  fontSize: 11, fontWeight: 600,
                  background: activeTab === tab ? "var(--debug-card-bg)" : "transparent",
                  color: "var(--debug-text)",
                  opacity: activeTab === tab ? 1 : 0.5,
                  transition: "all 0.15s",
                }}
              >
                {tab === "queries" ? "🔍 Queries" : "📊 Workspace"}
              </button>
            ))}
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

        {/* Body — switch on tab */}
        {activeTab === "queries" ? (
          <QueriesTab messages={messages} />
        ) : (
          <WorkspaceTab />
        )}
      </div>
    </>
  );
}
