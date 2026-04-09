import { useState, useEffect, useRef, useCallback } from "react";

interface Session {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  message_count?: number;
}

interface WorkspaceItem {
  id: string;
  name: string;
  title: string;
  active: boolean;
}

interface HistorySearchResult {
  messageId: number;
  sessionId: string;
  sessionTitle: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  score: number;
}

interface SidebarProps {
  sessions: Session[];
  activeSessionId: string | null;
  workspace: { name: string; title: string } | null;
  workspaces: WorkspaceItem[];
  collapsed: boolean;
  onToggle: () => void;
  onNewSession: () => void;
  onSelectSession: (id: string) => void;
  onDeleteSession: (id: string) => void;
  onRenameSession: (id: string, title: string) => void;
  onSwitchWorkspace: (id: string) => void;
  onSelectSearchResult: (sessionId: string, messageId: number) => void;
}

function groupByDate(sessions: Session[]): { label: string; sessions: Session[] }[] {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 86400000);
  const lastWeek = new Date(today.getTime() - 7 * 86400000);

  const groups: { label: string; sessions: Session[] }[] = [
    { label: "Today", sessions: [] },
    { label: "Yesterday", sessions: [] },
    { label: "Last 7 days", sessions: [] },
    { label: "Older", sessions: [] },
  ];

  for (const s of sessions) {
    const d = new Date(s.updated_at);
    if (d >= today) groups[0].sessions.push(s);
    else if (d >= yesterday) groups[1].sessions.push(s);
    else if (d >= lastWeek) groups[2].sessions.push(s);
    else groups[3].sessions.push(s);
  }

  return groups.filter((g) => g.sessions.length > 0);
}

function formatSessionTime(dateStr: string): string {
  const d = new Date(dateStr);
  const now = new Date();
  const diffDays = Math.floor((now.getTime() - d.getTime()) / 86400000);
  if (diffDays < 2) {
    return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  }
  return d.toLocaleDateString("en-GB", { month: "short", day: "numeric" });
}

export function Sidebar({
  sessions,
  activeSessionId,
  workspace,
  workspaces,
  collapsed,
  onToggle,
  onNewSession,
  onSelectSession,
  onDeleteSession,
  onRenameSession,
  onSwitchWorkspace,
  onSelectSearchResult,
}: SidebarProps) {
  const [menuSessionId, setMenuSessionId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [showWorkspacePicker, setShowWorkspacePicker] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<HistorySearchResult[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Ctrl+K → focus search input
  useEffect(() => {
    const handler = (e: globalThis.KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "k") {
        e.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // Debounced search (300ms)
  useEffect(() => {
    const q = searchQuery.trim();
    if (q.length < 2) {
      setSearchResults([]);
      setSearchLoading(false);
      return;
    }
    setSearchLoading(true);
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/history/search?q=${encodeURIComponent(q)}&limit=30`);
        const data = await res.json() as { results?: HistorySearchResult[] };
        setSearchResults(data.results ?? []);
      } catch {
        setSearchResults([]);
      } finally {
        setSearchLoading(false);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  // Group search results by session for cleaner display
  const groupedResults = useCallback(() => {
    const map = new Map<string, { sessionTitle: string; sessionId: string; results: HistorySearchResult[] }>();
    for (const r of searchResults) {
      const existing = map.get(r.sessionId);
      if (existing) {
        existing.results.push(r);
      } else {
        map.set(r.sessionId, { sessionId: r.sessionId, sessionTitle: r.sessionTitle, results: [r] });
      }
    }
    return Array.from(map.values());
  }, [searchResults]);

  const handleRename = (sessionId: string, currentTitle: string) => {
    setRenamingId(sessionId);
    setRenameValue(currentTitle);
    setMenuSessionId(null);
  };

  const submitRename = (sessionId: string) => {
    if (renameValue.trim()) {
      onRenameSession(sessionId, renameValue.trim());
    }
    setRenamingId(null);
  };

  const groups = groupByDate(sessions);

  // ── Collapsed view ────────────────────────────────────────────────
  if (collapsed) {
    return (
      <aside className="sidebar sidebar-collapsed">
        <div className="sidebar-top">
          <button className="sidebar-toggle" onClick={onToggle} aria-label="Expand sidebar">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" />
            </svg>
          </button>
          <button className="sidebar-new-collapsed" onClick={onNewSession} aria-label="New session">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </button>
        </div>
        <div className="sidebar-bottom">
          {workspace && (
            <div className="workspace-pill-collapsed" title={`${workspace.name} — ${workspace.title}`}>
              {workspace.name}
            </div>
          )}
        </div>
      </aside>
    );
  }

  // ── Expanded view ─────────────────────────────────────────────────
  return (
    <aside className="sidebar sidebar-expanded">
      <div className="sidebar-header">
        <button className="sidebar-toggle" onClick={onToggle} aria-label="Collapse sidebar">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" />
          </svg>
        </button>
        <span className="sidebar-title">Sessions</span>
        <button className="sidebar-new" onClick={onNewSession} aria-label="New session">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
      </div>

      {/* Search bar */}
      <div style={{ padding: "8px 12px 4px", position: "relative" }}>
        <div style={{ position: "relative" }}>
          <svg
            width="14" height="14" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
            style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: "var(--text-tertiary)", pointerEvents: "none" }}
          >
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            ref={searchInputRef}
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search history… (Ctrl+K)"
            style={{
              width: "100%",
              padding: "7px 28px 7px 32px",
              background: "var(--bg-elevated)",
              border: "1px solid var(--border-medium)",
              borderRadius: 6,
              color: "var(--text-primary)",
              fontSize: 12,
              outline: "none",
              boxSizing: "border-box",
            }}
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery("")}
              aria-label="Clear search"
              style={{
                position: "absolute",
                right: 6, top: "50%", transform: "translateY(-50%)",
                width: 18, height: 18,
                background: "transparent",
                border: "none",
                color: "var(--text-tertiary)",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                padding: 0,
                fontSize: 14,
                lineHeight: 1,
              }}
            >
              ×
            </button>
          )}
        </div>
      </div>

      {/* Search results (replaces sessions list when active) */}
      {searchQuery.trim().length >= 2 ? (
        <div className="sidebar-sessions" style={{ overflowY: "auto" }}>
          {searchLoading && (
            <div style={{ padding: "20px 16px", fontSize: 11, color: "var(--text-tertiary)", textAlign: "center" }}>
              Searching…
            </div>
          )}
          {!searchLoading && searchResults.length === 0 && (
            <div style={{ padding: "20px 16px", fontSize: 11, color: "var(--text-tertiary)", textAlign: "center" }}>
              No matches found.
            </div>
          )}
          {!searchLoading && searchResults.length > 0 && (
            <>
              <div style={{ padding: "6px 14px 4px", fontSize: 10, color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: 0.5 }}>
                {searchResults.length} result{searchResults.length === 1 ? "" : "s"}
              </div>
              {groupedResults().map((group) => (
                <div key={group.sessionId} style={{ marginBottom: 6 }}>
                  <div style={{
                    padding: "4px 14px",
                    fontSize: 10,
                    fontWeight: 600,
                    color: "var(--text-secondary)",
                    textTransform: "uppercase",
                    letterSpacing: 0.3,
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}>
                    {group.sessionTitle}
                  </div>
                  {group.results.map((r) => (
                    <button
                      key={r.messageId}
                      onClick={() => {
                        onSelectSearchResult(r.sessionId, r.messageId);
                        setSearchQuery("");
                      }}
                      style={{
                        display: "block",
                        width: "100%",
                        textAlign: "left",
                        padding: "6px 14px 8px 22px",
                        background: "transparent",
                        border: "none",
                        borderLeft: "2px solid transparent",
                        color: "var(--text-secondary)",
                        cursor: "pointer",
                        fontSize: 11,
                        lineHeight: 1.4,
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.background = "var(--bg-elevated)";
                        e.currentTarget.style.borderLeftColor = "var(--merck-teal)";
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.background = "transparent";
                        e.currentTarget.style.borderLeftColor = "transparent";
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
                        <span style={{ fontSize: 11 }}>{r.role === "user" ? "👤" : "🤖"}</span>
                        <span style={{ fontSize: 9, color: "var(--text-tertiary)", fontWeight: 600 }}>
                          {(r.score * 100).toFixed(0)}%
                        </span>
                      </div>
                      <div style={{
                        display: "-webkit-box",
                        WebkitLineClamp: 2,
                        WebkitBoxOrient: "vertical",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        color: "var(--text-secondary)",
                      }}>
                        {r.content.slice(0, 200)}
                      </div>
                    </button>
                  ))}
                </div>
              ))}
            </>
          )}
        </div>
      ) : (
        <div className="sidebar-sessions">
        {sessions.length === 0 && (
          <div className="sidebar-empty">
            No sessions yet. Click + to start.
          </div>
        )}

        {groups.map((group) => (
          <div key={group.label}>
            <div className="session-group-label">{group.label}</div>
            {group.sessions.map((s) => (
              <div
                key={s.id}
                className={`session-item ${s.id === activeSessionId ? "session-item-active" : ""}`}
                onClick={() => { if (renamingId !== s.id) onSelectSession(s.id); }}
              >
                {renamingId === s.id ? (
                  <input
                    className="session-rename-input"
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") submitRename(s.id); if (e.key === "Escape") setRenamingId(null); }}
                    onBlur={() => setRenamingId(null)}
                    autoFocus
                  />
                ) : (
                  <div className="session-item-row">
                    <span className="session-item-title">{s.title}</span>
                    <button
                      className="session-menu-btn"
                      onClick={(e) => { e.stopPropagation(); setMenuSessionId(menuSessionId === s.id ? null : s.id); }}
                      aria-label="Session options"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                        <circle cx="12" cy="5" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="12" cy="19" r="1.5" />
                      </svg>
                    </button>
                  </div>
                )}

                {menuSessionId === s.id && (
                  <div className="session-context-menu" onClick={(e) => e.stopPropagation()}>
                    <button className="context-menu-item" onClick={() => handleRename(s.id, s.title)}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M17 3a2.85 2.85 0 0 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
                      </svg>
                      Rename
                    </button>
                    <button className="context-menu-item context-menu-danger" onClick={() => { onDeleteSession(s.id); setMenuSessionId(null); }}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                      </svg>
                      Delete
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        ))}
        </div>
      )}

      <div className="sidebar-footer">
        <div
          className={`workspace-pill-expanded ${workspaces.length > 1 ? "workspace-pill-clickable" : ""}`}
          onClick={() => workspaces.length > 1 && setShowWorkspacePicker(!showWorkspacePicker)}
        >
          <span className="workspace-pill-dot" />
          <div className="workspace-pill-info">
            <div className="workspace-pill-name">{workspace?.name}</div>
            <div className="workspace-pill-title">{workspace?.title}</div>
          </div>
          {workspaces.length > 1 && (
            <svg
              width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
              style={{ transform: showWorkspacePicker ? "rotate(180deg)" : "none", transition: "transform 0.2s" }}
            >
              <polyline points="6 9 12 15 18 9" />
            </svg>
          )}
        </div>

        {showWorkspacePicker && (
          <div className="workspace-picker">
            {workspaces.map((ws) => (
              <div
                key={ws.id}
                className={`workspace-picker-item ${ws.active ? "workspace-picker-active" : ""}`}
                onClick={() => {
                  if (!ws.active) {
                    onSwitchWorkspace(ws.id);
                    setShowWorkspacePicker(false);
                  }
                }}
              >
                <span className={`workspace-picker-dot ${ws.active ? "stat-dot-ok" : ""}`} />
                <div className="workspace-picker-info">
                  <span className="workspace-picker-name">{ws.name}</span>
                  <span className="workspace-picker-title">{ws.title}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}
