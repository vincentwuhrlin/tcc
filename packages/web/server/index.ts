/**
 * TCC Web Server — Hono on Node.js
 *
 * Release 2: Workspace awareness — reads workspace.json + stats from disk.
 * Release 3+: Real LLM routing via @tcc/core.
 */
import "./env.js"; // must be first — loads .env from monorepo root
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { loadActiveWorkspace, scanAllWorkspaces, type WorkspaceInfo } from "./workspace.js";

const app = new Hono();

// ── Middleware ───────────────────────────────────────────────────────
app.use("*", logger());
app.use("/api/*", cors());

// ── Workspaces ──────────────────────────────────────────────────────
let workspace = loadActiveWorkspace();
const allWorkspaces = scanAllWorkspaces();

// Active workspace
app.get("/api/workspace", (c) => {
  return c.json({
    id: workspace.id,
    name: workspace.name,
    title: workspace.title,
    description: workspace.description,
    stats: workspace.stats,
  });
});

// List all available workspaces
app.get("/api/workspaces", (c) => {
  return c.json(
    allWorkspaces.map((ws) => ({
      id: ws.id,
      name: ws.name,
      title: ws.title,
      description: ws.description,
      active: ws.id === workspace.id,
      stats: ws.stats,
    })),
  );
});

// Switch workspace
app.post("/api/workspace/:id", (c) => {
  const id = c.req.param("id");
  const found = allWorkspaces.find((ws) => ws.id === id);

  if (!found) {
    return c.json({ error: `Workspace "${id}" not found` }, 404);
  }

  workspace = found;
  console.log(`📂 Switched to workspace: ${workspace.name} (${workspace.id})`);

  return c.json({
    id: workspace.id,
    name: workspace.name,
    title: workspace.title,
    description: workspace.description,
    stats: workspace.stats,
  });
});

// ── Chat endpoint (Release 2: still echo, workspace-aware) ─────────
interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

app.post("/api/chat", async (c) => {
  const body = await c.req.json<{ messages: ChatMessage[] }>();
  const messages = body.messages ?? [];
  const last = messages[messages.length - 1];

  if (!last?.content) {
    return c.json({ error: "No message provided" }, 400);
  }

  // Release 2: echo with workspace context
  await new Promise((r) => setTimeout(r, 600));

  const statsLine = workspace.stats.documents > 0
    ? `_${workspace.stats.documents} docs | ${workspace.stats.planCategories} categories | ${workspace.stats.indexed ? "INDEX.md ✓" : "no index"}_`
    : `_No documents in workspace_`;

  const reply: ChatMessage = {
    role: "assistant",
    content: `**Echo (Release 2)** — Workspace **${workspace.name}** connected!\n\n> ${last.content}\n\n${statsLine}`,
  };

  return c.json(reply);
});

// ── Health ──────────────────────────────────────────────────────────
app.get("/api/health", (c) => c.json({ status: "ok", release: 2 }));

// ── Start ───────────────────────────────────────────────────────────
const port = parseInt(process.env.PORT ?? "3001", 10);

serve({ fetch: app.fetch, port }, () => {
  const s = workspace.stats;
  console.log();
  console.log("  ╔══════════════════════════════════════════════╗");
  console.log("  ║  🔥 TCC Server (Hono)                       ║");
  console.log(`  ║  📡 http://localhost:${port}                   ║`);
  console.log("  ║  🏷️  Release 2 — Workspace aware              ║");
  console.log("  ╠══════════════════════════════════════════════╣");
  console.log(`  ║  📂 ${workspace.name}: ${workspace.title.slice(0, 35).padEnd(35)}║`);
  console.log(`  ║  📄 ${String(s.documents).padStart(3)} documents | ${String(s.planCategories).padStart(3)} categories     ║`);
  console.log(`  ║  📑 INDEX: ${s.indexed ? "✓" : "✗"}  |  DOMAIN: ${s.hasDomainContext ? "✓" : "✗"}               ║`);
  console.log(`  ║  📁 ${workspace.path.slice(-40).padEnd(40)}║`);
  if (allWorkspaces.length > 1) {
    console.log("  ╠══════════════════════════════════════════════╣");
    console.log(`  ║  📚 ${allWorkspaces.length} workspaces available:                   ║`);
    for (const ws of allWorkspaces) {
      const marker = ws.id === workspace.id ? "▸" : " ";
      console.log(`  ║   ${marker} ${ws.name.padEnd(6)} ${ws.title.slice(0, 33).padEnd(33)}║`);
    }
  }
  console.log("  ╚══════════════════════════════════════════════╝");
  console.log();
});
