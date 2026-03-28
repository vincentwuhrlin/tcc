import { useEffect, useState } from "react";
import { Chat } from "./components/Chat";

export interface Workspace {
  name: string;
  title: string;
  description: string;
  stats: {
    documents: number;
    indexed: boolean;
    planCategories: number;
    hasDomainContext: boolean;
  };
}

export function App() {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);

  useEffect(() => {
    fetch("/api/workspace")
      .then((r) => r.json())
      .then(setWorkspace)
      .catch(() =>
        setWorkspace({
          name: "TCC",
          title: "Offline",
          description: "",
          stats: { documents: 0, indexed: false, planCategories: 0, hasDomainContext: false },
        }),
      );
  }, []);

  return (
    <div className="app">
      <header className="header">
        <div className="header-left">
          <div className="logo">
            <span className="logo-icon">⚡</span>
            <span className="logo-text">TCC</span>
          </div>
          <span className="logo-separator" />
          <span className="logo-tagline">Transcript, Classify &amp; Chat</span>
        </div>
        {workspace && (
          <div className="workspace-badge">
            <span className="workspace-dot" />
            <span className="workspace-name">{workspace.name}</span>
            <span className="workspace-title">{workspace.title}</span>
          </div>
        )}
      </header>

      <main className="main">
        <Chat workspace={workspace} />
      </main>
    </div>
  );
}
