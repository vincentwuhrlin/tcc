import { useEffect, useState } from "react";

// ── Types ─────────────────────────────────────────────────────────────
interface UsageTotal {
  totalInput: number;
  totalOutput: number;
  callCount: number;
}
interface UsageByKind extends UsageTotal {
  kind: string;
}
interface UsageByProvider extends UsageTotal {
  provider: string;
  baseUrl: string | null;
  model: string;
}
interface UsageByDay extends UsageTotal {
  date: string;
}
interface UsagePayload {
  total: UsageTotal;
  byKind: UsageByKind[];
  byProvider: UsageByProvider[];
  byDay: UsageByDay[];
}

// ── Helpers ───────────────────────────────────────────────────────────
function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// Colors for each kind
const KIND_COLORS: Record<string, string> = {
  chat:        "#6ECEB2",  // merck teal light
  focus:       "#00857C",  // merck teal
  deep_search: "#6F2DA8",  // merck purple
  compaction:  "#8b5cf6",
  qa_prepare:  "#f59e0b",
  discover:    "#06b6d4",
  classify:    "#84cc16",
  synthesize:  "#ec4899",
  split:       "#ef4444",
  toc_parse:   "#6366f1",
  embed_bench: "#64748b",
  chat_cli:    "#14b8a6",
};
const kindColor = (kind: string) => KIND_COLORS[kind] ?? "#888";

// ── Sub-components ────────────────────────────────────────────────────

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div style={{
      background: "var(--bg-elevated)",
      border: "1px solid var(--border-medium)",
      borderRadius: 10,
      padding: "16px 20px",
      flex: 1,
      minWidth: 140,
    }}>
      <div style={{ fontSize: 11, color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: 0.5, fontWeight: 600 }}>
        {label}
      </div>
      <div style={{ fontSize: 26, fontWeight: 700, color: "var(--text-primary)", marginTop: 4, fontFamily: "var(--font-mono, monospace)" }}>
        {value}
      </div>
      {sub && (
        <div style={{ fontSize: 10, color: "var(--text-tertiary)", marginTop: 2 }}>
          {sub}
        </div>
      )}
    </div>
  );
}

function KindBar({ kind, totalInput, totalOutput, callCount, maxTotal }: UsageByKind & { maxTotal: number }) {
  const total = totalInput + totalOutput;
  const pct = maxTotal > 0 ? (total / maxTotal) * 100 : 0;
  const color = kindColor(kind);

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0" }}>
      <div style={{ width: 110, fontSize: 11, fontWeight: 600, color: "var(--text-primary)" }}>
        <span style={{
          display: "inline-block", width: 8, height: 8, borderRadius: 2,
          background: color, marginRight: 6, verticalAlign: "middle",
        }} />
        {kind}
      </div>
      <div style={{ flex: 1, height: 20, background: "var(--bg-tertiary)", borderRadius: 4, overflow: "hidden", position: "relative" }}>
        <div style={{
          width: `${Math.max(pct, 1)}%`,
          height: "100%",
          background: color,
          borderRadius: 4,
          transition: "width 0.3s",
        }} />
      </div>
      <div style={{ width: 110, fontSize: 10, fontFamily: "var(--font-mono, monospace)", color: "var(--text-secondary)", textAlign: "right" }}>
        {formatTokens(totalInput)} ↑ / {formatTokens(totalOutput)} ↓
      </div>
      <div style={{ width: 40, fontSize: 10, color: "var(--text-tertiary)", textAlign: "right" }}>
        ×{callCount}
      </div>
    </div>
  );
}

function DayBar({ date, totalInput, totalOutput, callCount, maxTotal }: UsageByDay & { maxTotal: number }) {
  const total = totalInput + totalOutput;
  const pctInput = maxTotal > 0 ? (totalInput / maxTotal) * 100 : 0;
  const pctOutput = maxTotal > 0 ? (totalOutput / maxTotal) * 100 : 0;

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "3px 0" }}>
      <div style={{ width: 70, fontSize: 10, color: "var(--text-secondary)", fontFamily: "var(--font-mono, monospace)" }}>
        {formatDate(date)}
      </div>
      <div style={{ flex: 1, height: 14, background: "var(--bg-tertiary)", borderRadius: 3, overflow: "hidden", display: "flex" }}>
        <div style={{
          width: `${Math.max(pctInput, 0.5)}%`,
          height: "100%",
          background: "var(--merck-teal)",
        }} />
        <div style={{
          width: `${Math.max(pctOutput, 0.5)}%`,
          height: "100%",
          background: "var(--merck-teal-light)",
        }} />
      </div>
      <div style={{ width: 120, fontSize: 10, fontFamily: "var(--font-mono, monospace)", color: "var(--text-secondary)", textAlign: "right" }}>
        {formatTokens(total)} <span style={{ opacity: 0.5 }}>({callCount})</span>
      </div>
    </div>
  );
}

function ProviderRow({ provider, baseUrl, model, totalInput, totalOutput, callCount }: UsageByProvider) {
  // Shorten the URL for display: keep host + first path segment
  const shortUrl = baseUrl
    ? (() => {
        try {
          const u = new URL(baseUrl);
          return u.host + (u.pathname.length > 1 ? u.pathname : "");
        } catch {
          return baseUrl;
        }
      })()
    : null;

  return (
    <tr style={{ borderBottom: "1px solid var(--border-subtle)" }}>
      <td style={{ padding: "8px 12px 8px 0", fontSize: 12, color: "var(--text-primary)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <span style={{
            display: "inline-block",
            padding: "2px 6px",
            borderRadius: 4,
            fontSize: 10,
            fontWeight: 700,
            background: provider === "anthropic" ? "rgba(111, 45, 168, 0.2)" : "rgba(0, 133, 124, 0.2)",
            color: provider === "anthropic" ? "#c084fc" : "var(--merck-teal-light)",
          }}>
            {provider}
          </span>
          <span style={{ fontFamily: "var(--font-mono, monospace)", fontSize: 11, color: "var(--text-secondary)" }}>
            {model}
          </span>
        </div>
        {shortUrl && (
          <div style={{
            fontSize: 9,
            color: "var(--text-tertiary)",
            fontFamily: "var(--font-mono, monospace)",
            marginTop: 2,
            paddingLeft: 2,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            maxWidth: 380,
          }} title={baseUrl ?? ""}>
            → {shortUrl}
          </div>
        )}
      </td>
      <td style={{ padding: "8px 12px", fontSize: 11, fontFamily: "var(--font-mono, monospace)", color: "var(--text-secondary)", textAlign: "right" }}>
        {formatTokens(totalInput)}
      </td>
      <td style={{ padding: "8px 12px", fontSize: 11, fontFamily: "var(--font-mono, monospace)", color: "var(--text-secondary)", textAlign: "right" }}>
        {formatTokens(totalOutput)}
      </td>
      <td style={{ padding: "8px 0 8px 12px", fontSize: 11, fontFamily: "var(--font-mono, monospace)", color: "var(--text-tertiary)", textAlign: "right" }}>
        {callCount}
      </td>
    </tr>
  );
}

function Section({ title, children, subtitle }: { title: string; children: React.ReactNode; subtitle?: string }) {
  return (
    <div style={{ marginBottom: 32 }}>
      <div style={{ marginBottom: 12 }}>
        <h3 style={{ fontSize: 14, fontWeight: 700, color: "var(--text-primary)", margin: 0 }}>
          {title}
        </h3>
        {subtitle && (
          <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 2 }}>
            {subtitle}
          </div>
        )}
      </div>
      {children}
    </div>
  );
}

// ── Memory types ──────────────────────────────────────────────────────
interface Memory {
  id: number;
  content: string;
  category: string | null;
  sourceSessionId: string | null;
  active: number;
  createdAt: string;
  updatedAt: string;
}
interface MemoriesPayload {
  memories: Memory[];
  stats: { total: number; active: number };
}

// ── Main component ────────────────────────────────────────────────────

type Tab = "usage" | "memories";

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<Tab>("usage");
  const [usage, setUsage] = useState<UsagePayload | null>(null);
  const [memories, setMemories] = useState<MemoriesPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [memLoading, setMemLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [memoriesEnabled, setMemoriesEnabled] = useState(true);
  const [settingsLoading, setSettingsLoading] = useState(true);

  // Fetch usage data
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/usage?days=30");
        if (!res.ok) throw new Error(`Server error: ${res.status}`);
        const data = (await res.json()) as UsagePayload;
        setUsage(data);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load usage");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // Fetch memories
  const loadMemories = async () => {
    try {
      const res = await fetch("/api/memories");
      if (!res.ok) throw new Error(`Server error: ${res.status}`);
      const data = (await res.json()) as MemoriesPayload;
      setMemories(data);
    } catch (err) {
      console.error("Failed to load memories:", err);
    } finally {
      setMemLoading(false);
    }
  };

  useEffect(() => { loadMemories(); }, []);

  // Fetch app settings (memoriesEnabled)
  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((data: { memoriesEnabled?: boolean }) => {
        if (typeof data.memoriesEnabled === "boolean") {
          setMemoriesEnabled(data.memoriesEnabled);
        }
      })
      .catch(() => {})
      .finally(() => setSettingsLoading(false));
  }, []);

  const toggleMemoriesEnabled = async (enabled: boolean) => {
    setMemoriesEnabled(enabled); // optimistic
    try {
      await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ memories_enabled: enabled }),
      });
    } catch (err) {
      console.error("Failed to update settings:", err);
      setMemoriesEnabled(!enabled); // rollback
    }
  };

  // Memory actions
  const toggleMemory = async (id: number, active: boolean) => {
    await fetch(`/api/memories/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ active }),
    });
    loadMemories();
  };

  const removeMemory = async (id: number) => {
    if (!confirm("Delete this memory permanently?")) return;
    await fetch(`/api/memories/${id}`, { method: "DELETE" });
    loadMemories();
  };

  // ESC to close
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const maxKindTotal = usage
    ? Math.max(1, ...usage.byKind.map((k) => k.totalInput + k.totalOutput))
    : 1;
  const maxDayTotal = usage
    ? Math.max(1, ...usage.byDay.map((d) => d.totalInput + d.totalOutput))
    : 1;

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        background: "rgba(0, 0, 0, 0.6)",
        backdropFilter: "blur(4px)",
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        padding: "40px 20px",
        overflowY: "auto",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--bg-secondary)",
          border: "1px solid var(--border-medium)",
          borderRadius: 14,
          width: "100%",
          maxWidth: 880,
          boxShadow: "0 20px 60px rgba(0,0,0,0.5)",
          overflow: "hidden",
        }}
      >
        {/* Header */}
        <div style={{
          padding: "16px 24px",
          borderBottom: "1px solid var(--border-medium)",
          background: "var(--bg-elevated)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 18 }}>⚙️</span>
            <h2 style={{ fontSize: 16, fontWeight: 700, color: "var(--text-primary)", margin: 0 }}>
              Settings
            </h2>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{
              background: "none",
              border: "none",
              color: "var(--text-secondary)",
              cursor: "pointer",
              fontSize: 22,
              lineHeight: 1,
              padding: 4,
            }}
          >
            ×
          </button>
        </div>

        {/* Tabs */}
        <div style={{
          display: "flex",
          gap: 4,
          padding: "0 24px",
          borderBottom: "1px solid var(--border-medium)",
          background: "var(--bg-elevated)",
        }}>
          {([
            { id: "usage" as Tab, label: "Token usage" },
            { id: "memories" as Tab, label: `Memories${memories ? ` (${memories.stats.active}/${memories.stats.total})` : ""}` },
          ]).map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              style={{
                background: "none",
                border: "none",
                padding: "12px 16px",
                fontSize: 13,
                fontWeight: 600,
                color: tab === t.id ? "var(--merck-teal-light)" : "var(--text-secondary)",
                borderBottom: tab === t.id ? "2px solid var(--merck-teal-light)" : "2px solid transparent",
                marginBottom: -1,
                cursor: "pointer",
                transition: "color 0.15s",
              }}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Body */}
        <div style={{ padding: "24px 32px", maxHeight: "calc(100vh - 220px)", overflowY: "auto" }}>
          {tab === "usage" && (
            <>
          <h1 style={{
            fontSize: 20, fontWeight: 700, color: "var(--text-primary)",
            margin: "0 0 6px",
          }}>
            Token usage
          </h1>
          <p style={{ fontSize: 12, color: "var(--text-tertiary)", margin: "0 0 24px" }}>
            LLM consumption for this workspace. Includes chat, focus, deep search, and pipeline commands.
          </p>

          {loading && (
            <div style={{ padding: 40, textAlign: "center", color: "var(--text-tertiary)" }}>
              Loading usage data…
            </div>
          )}

          {error && (
            <div style={{
              padding: 16,
              background: "rgba(239, 68, 68, 0.1)",
              border: "1px solid rgba(239, 68, 68, 0.3)",
              borderRadius: 8,
              color: "#ef4444",
              fontSize: 12,
            }}>
              ❌ {error}
            </div>
          )}

          {usage && (
            <>
              {/* Top stats */}
              <Section title="Overview">
                <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                  <StatCard
                    label="Input tokens"
                    value={formatTokens(usage.total.totalInput)}
                    sub={`${usage.total.totalInput.toLocaleString()} total`}
                  />
                  <StatCard
                    label="Output tokens"
                    value={formatTokens(usage.total.totalOutput)}
                    sub={`${usage.total.totalOutput.toLocaleString()} total`}
                  />
                  <StatCard
                    label="Total calls"
                    value={usage.total.callCount.toLocaleString()}
                    sub="all LLM requests"
                  />
                  <StatCard
                    label="Grand total"
                    value={formatTokens(usage.total.totalInput + usage.total.totalOutput)}
                    sub="in + out tokens"
                  />
                </div>
              </Section>

              {/* Breakdown by kind */}
              <Section title="By category" subtitle="Which features consume the most">
                {usage.byKind.length === 0 ? (
                  <div style={{ fontSize: 11, color: "var(--text-tertiary)", fontStyle: "italic" }}>
                    No data yet
                  </div>
                ) : (
                  usage.byKind.map((k) => (
                    <KindBar key={k.kind} {...k} maxTotal={maxKindTotal} />
                  ))
                )}
              </Section>

              {/* Breakdown by provider/model */}
              <Section title="By provider and model" subtitle="Useful when switching between providers">
                {usage.byProvider.length === 0 ? (
                  <div style={{ fontSize: 11, color: "var(--text-tertiary)", fontStyle: "italic" }}>
                    No data yet
                  </div>
                ) : (
                  <table style={{ width: "100%", borderCollapse: "collapse" }}>
                    <thead>
                      <tr style={{ borderBottom: "1px solid var(--border-medium)" }}>
                        <th style={{ textAlign: "left", padding: "6px 12px 6px 0", fontSize: 10, fontWeight: 600, color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: 0.5 }}>
                          Provider / Model
                        </th>
                        <th style={{ textAlign: "right", padding: "6px 12px", fontSize: 10, fontWeight: 600, color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: 0.5 }}>
                          Input
                        </th>
                        <th style={{ textAlign: "right", padding: "6px 12px", fontSize: 10, fontWeight: 600, color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: 0.5 }}>
                          Output
                        </th>
                        <th style={{ textAlign: "right", padding: "6px 0 6px 12px", fontSize: 10, fontWeight: 600, color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: 0.5 }}>
                          Calls
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {usage.byProvider.map((p, i) => (
                        <ProviderRow key={`${p.provider}-${p.baseUrl ?? ""}-${p.model}-${i}`} {...p} />
                      ))}
                    </tbody>
                  </table>
                )}
              </Section>

              {/* Daily usage */}
              <Section title="Last 30 days" subtitle="Daily token consumption (input ▮ / output ▮)">
                {usage.byDay.length === 0 ? (
                  <div style={{ fontSize: 11, color: "var(--text-tertiary)", fontStyle: "italic" }}>
                    No data yet
                  </div>
                ) : (
                  usage.byDay.map((d) => (
                    <DayBar key={d.date} {...d} maxTotal={maxDayTotal} />
                  ))
                )}
              </Section>
            </>
          )}
          </>
          )}

          {tab === "memories" && (
            <>
              <h1 style={{ fontSize: 20, fontWeight: 700, color: "var(--text-primary)", margin: "0 0 6px" }}>
                Memories
              </h1>
              <p style={{ fontSize: 12, color: "var(--text-tertiary)", margin: "0 0 20px" }}>
                Persistent facts extracted from your conversations. Active memories are injected into every new chat. Disable individual memories if they become wrong or outdated.
              </p>

              {/* Master toggle card */}
              <div style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 16,
                padding: "14px 16px",
                marginBottom: 20,
                background: "var(--bg-elevated)",
                border: "1px solid var(--border-medium)",
                borderRadius: 10,
              }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)", marginBottom: 2 }}>
                    Enable memories for this workspace
                  </div>
                  <div style={{ fontSize: 11, color: "var(--text-tertiary)", lineHeight: 1.4 }}>
                    When enabled, durable facts are automatically extracted after long conversations and injected into every new chat. A manual 🧠 Memories button also appears in the chat footer.
                  </div>
                </div>
                <button
                  onClick={() => toggleMemoriesEnabled(!memoriesEnabled)}
                  disabled={settingsLoading}
                  aria-label={memoriesEnabled ? "Disable memories" : "Enable memories"}
                  style={{
                    width: 44,
                    height: 24,
                    borderRadius: 12,
                    background: memoriesEnabled ? "var(--merck-teal)" : "var(--bg-tertiary)",
                    border: "1px solid var(--border-medium)",
                    cursor: settingsLoading ? "wait" : "pointer",
                    position: "relative",
                    padding: 0,
                    flexShrink: 0,
                    transition: "background 0.2s",
                    opacity: settingsLoading ? 0.5 : 1,
                  }}
                >
                  <div style={{
                    width: 18,
                    height: 18,
                    borderRadius: "50%",
                    background: "#fff",
                    position: "absolute",
                    top: 2,
                    left: memoriesEnabled ? 23 : 2,
                    transition: "left 0.2s",
                    boxShadow: "0 1px 3px rgba(0,0,0,0.3)",
                  }} />
                </button>
              </div>

              {memories && (
                <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginBottom: 16 }}>
                  {memories.stats.active} active · {memories.stats.total} total
                </div>
              )}

              {memLoading && (
                <div style={{ padding: 40, textAlign: "center", color: "var(--text-tertiary)" }}>
                  Loading memories…
                </div>
              )}

              {memories && memories.memories.length === 0 && (
                <div style={{
                  padding: 40,
                  textAlign: "center",
                  color: "var(--text-tertiary)",
                  fontSize: 12,
                  background: "var(--bg-elevated)",
                  border: "1px dashed var(--border-medium)",
                  borderRadius: 10,
                }}>
                  No memories yet. They will appear automatically after a long conversation, or use the 🧠 Memories button in the chat footer to extract them on demand.
                </div>
              )}

              {memories && memories.memories.length > 0 && (
                <div style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 8,
                  opacity: memoriesEnabled ? 1 : 0.45,
                  pointerEvents: memoriesEnabled ? "auto" : "none",
                  transition: "opacity 0.2s",
                }}>
                  {memories.memories.map((m) => (
                    <div
                      key={m.id}
                      style={{
                        display: "flex",
                        alignItems: "flex-start",
                        gap: 12,
                        padding: "12px 14px",
                        background: "var(--bg-elevated)",
                        border: "1px solid var(--border-medium)",
                        borderRadius: 8,
                        opacity: m.active ? 1 : 0.5,
                      }}
                    >
                      {/* Toggle */}
                      <button
                        onClick={() => toggleMemory(m.id, !m.active)}
                        aria-label={m.active ? "Disable" : "Enable"}
                        title={m.active ? "Disable this memory" : "Enable this memory"}
                        style={{
                          width: 32,
                          height: 18,
                          borderRadius: 9,
                          background: m.active ? "var(--merck-teal)" : "var(--bg-tertiary)",
                          border: "1px solid var(--border-medium)",
                          cursor: "pointer",
                          position: "relative",
                          padding: 0,
                          flexShrink: 0,
                          marginTop: 2,
                          transition: "background 0.15s",
                        }}
                      >
                        <div style={{
                          width: 12,
                          height: 12,
                          borderRadius: "50%",
                          background: "#fff",
                          position: "absolute",
                          top: 2,
                          left: m.active ? 17 : 2,
                          transition: "left 0.15s",
                        }} />
                      </button>

                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, color: "var(--text-primary)", lineHeight: 1.4 }}>
                          {m.content}
                        </div>
                        <div style={{ display: "flex", gap: 8, marginTop: 4, fontSize: 10, color: "var(--text-tertiary)" }}>
                          {m.category && (
                            <span style={{
                              padding: "1px 6px",
                              background: "rgba(0, 133, 124, 0.15)",
                              color: "var(--merck-teal-light)",
                              borderRadius: 3,
                              fontWeight: 600,
                            }}>
                              {m.category}
                            </span>
                          )}
                          <span>
                            {new Date(m.createdAt).toLocaleDateString()}
                          </span>
                          {m.sourceSessionId && (
                            <span style={{ fontFamily: "var(--font-mono, monospace)", opacity: 0.6 }}>
                              · from session {m.sourceSessionId.slice(0, 8)}
                            </span>
                          )}
                        </div>
                      </div>

                      {/* Delete */}
                      <button
                        onClick={() => removeMemory(m.id)}
                        aria-label="Delete"
                        title="Delete permanently"
                        style={{
                          background: "none",
                          border: "none",
                          color: "var(--text-tertiary)",
                          cursor: "pointer",
                          fontSize: 16,
                          padding: 4,
                          flexShrink: 0,
                        }}
                      >
                        🗑
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div style={{
          padding: "10px 24px",
          borderTop: "1px solid var(--border-medium)",
          background: "var(--bg-elevated)",
          fontSize: 10,
          color: "var(--text-tertiary)",
          textAlign: "center",
        }}>
          Token counts are reported by the LLM provider after each call. Press ESC or click outside to close.
        </div>
      </div>
    </div>
  );
}
