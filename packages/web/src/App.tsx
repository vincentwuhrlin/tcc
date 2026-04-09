import { useEffect, useState, useCallback } from "react";
import { Chat } from "./components/Chat";
import { Sidebar } from "./components/Sidebar";
import { ThemeToggle } from "./components/ThemeToggle";
import { SettingsModal } from "./components/SettingsModal";

export interface Workspace {
  name: string;
  title: string;
  description: string;
  stats: {
    documents: number;
    indexed: boolean;
    planCategories: number;
    hasDomainContext: boolean;
    ragChunks?: number;
    ragReady?: boolean;
  };
}

export interface Session {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  message_count?: number;
}

export interface ChatMessage {
  id: string | number;
  role: "user" | "assistant";
  content: string;
  created_at?: string;
  sources?: { source: string; score: number }[];
  timing?: { embed_ms: number; search_ms: number; llm_ms: number; total_ms: number };
  context?: { totalMessages: number; hasCompaction: boolean; windowSize: number };
  debug?: DebugPayload;
  focusCategories?: { code: string; name: string; chunkCount: number }[];
}

export interface DebugPayload {
  query: string;
  rag: {
    totalChunks: number;
    returned: number;
    topK: number;
    minScore: number;
    chunks: { id: string; source: string; score: number; chars: number; preview: string }[];
  };
  prompt: { totalChars: number; instructions: number; domain: number; plan: number; ragContext: number; history: number; summary: number };
  session: { id: string; totalMessages: number; windowSize: number; hasCompaction: boolean; needsCompaction: boolean };
  config: { provider: string; model: string; streaming: boolean; embedEngine: string };
  deepSearch: { enabled: boolean; subQueries: string[]; pass1Count: number; pass2Count: number; mergedCount: number; deduped: number; timings: { subQueryGenMs: number; pass2EmbedMs: number; pass2SearchMs: number; totalMs: number } };
}

interface WorkspaceItem {
  id: string;
  name: string;
  title: string;
  active: boolean;
}

export function App() {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceItem[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [switchingTo, setSwitchingTo] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [scrollToMessageId, setScrollToMessageId] = useState<number | null>(null);

  // ── localStorage helpers for active workspace ─────────────────────
  const ACTIVE_WORKSPACE_KEY = "tcc-active-workspace";
  const getStoredWorkspace = (): string | null => {
    try { return localStorage.getItem(ACTIVE_WORKSPACE_KEY); } catch { return null; }
  };
  const storeWorkspace = (id: string) => {
    try { localStorage.setItem(ACTIVE_WORKSPACE_KEY, id); } catch { /* ignore */ }
  };

  // ── URL ↔ session sync helpers ───────────────────────────────────
  const getUrlSessionId = (): string | null => {
    const match = window.location.pathname.match(/^\/chat\/(.+)$/);
    return match?.[1] ?? null;
  };

  const setUrl = (sessionId: string | null) => {
    const newPath = sessionId ? `/chat/${sessionId}` : "/";
    if (window.location.pathname !== newPath) {
      window.history.pushState(null, "", newPath);
    }
  };

  // ── Fetch workspace info ──────────────────────────────────────────
  useEffect(() => {
    (async () => {
      try {
        const [wsRes, wssRes] = await Promise.all([
          fetch("/api/workspace"),
          fetch("/api/workspaces"),
        ]);
        const currentWs: Workspace = await wsRes.json();
        const allWs: WorkspaceItem[] = await wssRes.json();

        // Check localStorage — if user previously selected a different workspace, switch to it
        const stored = getStoredWorkspace();
        if (stored && stored !== currentWs.name && allWs.some((w) => w.id === stored)) {
          // Auto-switch to stored workspace
          setSwitchingTo(stored);
          try {
            const switchRes = await fetch(`/api/workspace/${stored}`, { method: "POST" });
            if (switchRes.ok) {
              const newWs: Workspace = await switchRes.json();
              setWorkspace(newWs);
              const refreshedRes = await fetch("/api/workspaces");
              setWorkspaces(await refreshedRes.json());
            } else {
              setWorkspace(currentWs);
              setWorkspaces(allWs);
            }
          } catch {
            setWorkspace(currentWs);
            setWorkspaces(allWs);
          } finally {
            setSwitchingTo(null);
          }
        } else {
          setWorkspace(currentWs);
          setWorkspaces(allWs);
          // Sync localStorage with server (first launch case)
          if (currentWs?.name) storeWorkspace(currentWs.name);
        }
      } catch {
        setWorkspace({
          name: "TCC", title: "Offline", description: "",
          stats: { documents: 0, indexed: false, planCategories: 0, hasDomainContext: false },
        });
        setWorkspaces([]);
      }
    })();
  }, []);

  // ── Fetch sessions ────────────────────────────────────────────────
  const refreshSessions = useCallback(() => {
    fetch("/api/sessions")
      .then((r) => r.json())
      .then(setSessions)
      .catch(() => setSessions([]));
  }, []);

  useEffect(() => {
    refreshSessions();
  }, [refreshSessions]);

  // ── Load session messages ─────────────────────────────────────────
  const loadSessionMessages = useCallback((sessionId: string) => {
    fetch(`/api/sessions/${sessionId}/messages`)
      .then((r) => r.json())
      .then((msgs: ChatMessage[]) => setMessages(msgs))
      .catch(() => setMessages([]));
  }, []);

  // ── Restore session from URL on mount ─────────────────────────
  useEffect(() => {
    const urlId = getUrlSessionId();
    if (urlId) {
      setActiveSessionId(urlId);
      loadSessionMessages(urlId);
    }
  }, [loadSessionMessages]);

  // ── Browser back/forward → sync session from URL ────────────────────────────
  useEffect(() => {
    const onPopState = () => {
      const urlId = getUrlSessionId();
      if (urlId && urlId !== activeSessionId) {
        setActiveSessionId(urlId);
        loadSessionMessages(urlId);
      } else if (!urlId) {
        setActiveSessionId(null);
        setMessages([]);
      }
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [activeSessionId, loadSessionMessages]);

  // ── Session actions ───────────────────────────────────────────────
  const handleNewSession = useCallback(async () => {
    try {
      const res = await fetch("/api/sessions", { method: "POST" });
      const session: Session = await res.json();
      setActiveSessionId(session.id);
      setMessages([]);
      setUrl(session.id);
      refreshSessions();
    } catch (err) {
      console.error("Failed to create session:", err);
    }
  }, [refreshSessions]);

  const handleSelectSession = useCallback(
    (id: string) => {
      setActiveSessionId(id);
      setUrl(id);
      loadSessionMessages(id);
    },
    [loadSessionMessages],
  );

  const handleSelectSearchResult = useCallback(
    async (sessionId: string, messageId: number) => {
      // If switching sessions, load messages first; otherwise just set the scroll target
      if (sessionId !== activeSessionId) {
        setActiveSessionId(sessionId);
        setUrl(sessionId);
        await loadSessionMessages(sessionId);
      }
      // Trigger scroll in Chat — set to null first to force re-trigger if same id
      setScrollToMessageId(null);
      setTimeout(() => setScrollToMessageId(messageId), 10);
    },
    [activeSessionId, loadSessionMessages],
  );

  const handleDeleteSession = useCallback(
    async (id: string) => {
      try {
        await fetch(`/api/sessions/${id}`, { method: "DELETE" });
        if (activeSessionId === id) {
          setActiveSessionId(null);
          setMessages([]);
          setUrl(null);
        }
        refreshSessions();
      } catch (err) {
        console.error("Failed to delete session:", err);
      }
    },
    [activeSessionId, refreshSessions],
  );

  const handleRenameSession = useCallback(
    async (id: string, title: string) => {
      try {
        await fetch(`/api/sessions/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title }),
        });
        refreshSessions();
      } catch (err) {
        console.error("Failed to rename session:", err);
      }
    },
    [refreshSessions],
  );

  // ── Called by Chat after sending a message ─────────────────────────
  const handleMessageSent = useCallback(() => {
    refreshSessions();
  }, [refreshSessions]);

  // ── Switch workspace (hot-reload) ─────────────────────────────────
  const handleSwitchWorkspace = useCallback(
    async (id: string) => {
      setSwitchingTo(id);
      try {
        const res = await fetch(`/api/workspace/${id}`, { method: "POST" });
        if (!res.ok) throw new Error(`Switch failed: ${res.status}`);

        const newWorkspace = await res.json();
        setWorkspace(newWorkspace);
        storeWorkspace(newWorkspace.name);

        // Refresh workspaces list (active flags changed)
        const wsRes = await fetch("/api/workspaces");
        setWorkspaces(await wsRes.json());

        // New workspace = new sessions, clear current
        setActiveSessionId(null);
        setMessages([]);
        setUrl(null);
        refreshSessions();
      } catch (err) {
        console.error("Failed to switch workspace:", err);
      } finally {
        setSwitchingTo(null);
      }
    },
    [refreshSessions],
  );

  // ── Auto-create session on first message if none active ───────────
  const ensureSession = useCallback(async (): Promise<string> => {
    if (activeSessionId) return activeSessionId;
    const res = await fetch("/api/sessions", { method: "POST" });
    const session: Session = await res.json();
    setActiveSessionId(session.id);
    setUrl(session.id);
    refreshSessions();
    return session.id;
  }, [activeSessionId, refreshSessions]);

  return (
    <div className="app-layout">
      {switchingTo && (
        <div style={{
          position: "fixed", inset: 0, zIndex: 9999,
          background: "rgba(0,0,0,0.6)", backdropFilter: "blur(4px)",
          display: "flex", alignItems: "center", justifyContent: "center",
          flexDirection: "column", gap: 16,
        }}>
          <div style={{
            width: 48, height: 48, border: "3px solid var(--border-medium)",
            borderTopColor: "var(--merck-teal-light)", borderRadius: "50%",
            animation: "tcc-spin 0.8s linear infinite",
          }} />
          <div style={{ color: "#fff", fontSize: 14, fontWeight: 600 }}>
            Switching to {switchingTo}…
          </div>
          <div style={{ color: "rgba(255,255,255,0.6)", fontSize: 11 }}>
            Reloading RAG index, category index, and warming up the model
          </div>
          <style>{`@keyframes tcc-spin { to { transform: rotate(360deg); } }`}</style>
        </div>
      )}
      <Sidebar
        sessions={sessions}
        activeSessionId={activeSessionId}
        workspace={workspace}
        workspaces={workspaces}
        collapsed={sidebarCollapsed}
        onToggle={() => setSidebarCollapsed(!sidebarCollapsed)}
        onNewSession={handleNewSession}
        onSelectSession={handleSelectSession}
        onDeleteSession={handleDeleteSession}
        onRenameSession={handleRenameSession}
        onSwitchWorkspace={handleSwitchWorkspace}
        onSelectSearchResult={handleSelectSearchResult}
      />

      <div className="app-main">
        <header className="header">
          <div className="header-left">
            <div className="logo">
              <span className="logo-icon">⚡</span>
              <span className="logo-text">TCC</span>
            </div>
            <span className="logo-separator" />
            <span className="logo-tagline">Transcript, Classify &amp; Chat!</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <ThemeToggle />
            <button
              onClick={() => setSettingsOpen(true)}
              aria-label="Settings"
              title="Settings"
              style={{
                background: "none",
                border: "1px solid var(--border-medium)",
                borderRadius: 8,
                padding: 8,
                cursor: "pointer",
                color: "var(--text-secondary)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                transition: "all 0.15s",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.borderColor = "var(--merck-teal-light)";
                e.currentTarget.style.color = "var(--merck-teal-light)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.borderColor = "var(--border-medium)";
                e.currentTarget.style.color = "var(--text-secondary)";
              }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
            </button>
          </div>
        </header>

        <main className="main">
          <Chat
            workspace={workspace}
            messages={messages}
            setMessages={setMessages}
            activeSessionId={activeSessionId}
            ensureSession={ensureSession}
            onMessageSent={handleMessageSent}
            scrollToMessageId={scrollToMessageId}
            onScrolledToMessage={() => setScrollToMessageId(null)}
          />
        </main>
      </div>

      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}
