import { useEffect, useState, useCallback } from "react";
import { Chat } from "./components/Chat";
import { Sidebar } from "./components/Sidebar";
import { ThemeToggle } from "./components/ThemeToggle";

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

  // ── Fetch workspace info ──────────────────────────────────────────
  useEffect(() => {
    fetch("/api/workspace")
      .then((r) => r.json())
      .then(setWorkspace)
      .catch(() =>
        setWorkspace({
          name: "TCC", title: "Offline", description: "",
          stats: { documents: 0, indexed: false, planCategories: 0, hasDomainContext: false },
        }),
      );

    fetch("/api/workspaces")
      .then((r) => r.json())
      .then(setWorkspaces)
      .catch(() => setWorkspaces([]));
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

  // ── Session actions ───────────────────────────────────────────────
  const handleNewSession = useCallback(async () => {
    try {
      const res = await fetch("/api/sessions", { method: "POST" });
      const session: Session = await res.json();
      setActiveSessionId(session.id);
      setMessages([]);
      refreshSessions();
    } catch (err) {
      console.error("Failed to create session:", err);
    }
  }, [refreshSessions]);

  const handleSelectSession = useCallback(
    (id: string) => {
      setActiveSessionId(id);
      loadSessionMessages(id);
    },
    [loadSessionMessages],
  );

  const handleDeleteSession = useCallback(
    async (id: string) => {
      try {
        await fetch(`/api/sessions/${id}`, { method: "DELETE" });
        if (activeSessionId === id) {
          setActiveSessionId(null);
          setMessages([]);
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
      try {
        const res = await fetch(`/api/workspace/${id}`, { method: "POST" });
        if (!res.ok) throw new Error(`Switch failed: ${res.status}`);

        const newWorkspace = await res.json();
        setWorkspace(newWorkspace);

        // Refresh workspaces list (active flags changed)
        const wsRes = await fetch("/api/workspaces");
        setWorkspaces(await wsRes.json());

        // New workspace = new sessions, clear current
        setActiveSessionId(null);
        setMessages([]);
        refreshSessions();
      } catch (err) {
        console.error("Failed to switch workspace:", err);
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
    refreshSessions();
    return session.id;
  }, [activeSessionId, refreshSessions]);

  return (
    <div className="app-layout">
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
          <ThemeToggle />
        </header>

        <main className="main">
          <Chat
            workspace={workspace}
            messages={messages}
            setMessages={setMessages}
            activeSessionId={activeSessionId}
            ensureSession={ensureSession}
            onMessageSent={handleMessageSent}
          />
        </main>
      </div>
    </div>
  );
}
