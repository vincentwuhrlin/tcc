import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig(({ mode }) => {
  // Load .env from monorepo root (2 levels up from packages/web)
  const env = loadEnv(mode, resolve(__dirname, "../.."), "");

  const host = env.HOST || "localhost";
  const uiPort = parseInt(env.WEB_PORT || "3000", 10);
  const apiPort = parseInt(env.API_PORT || "3001", 10);

  return {
    plugins: [react()],
    server: {
      host,
      port: uiPort,
      strictPort: true, // fail rather than silently picking another port
      proxy: {
        "/api": {
          // Always proxy to localhost — binding host is for external access,
          // but the UI server reaches the API server on the same machine.
          target: `http://localhost:${apiPort}`,
          changeOrigin: true,
          // SSE support: disable proxy buffering so events stream through
          configure: (proxy) => {
            proxy.on("proxyRes", (proxyRes) => {
              if (proxyRes.headers["content-type"]?.includes("text/event-stream")) {
                proxyRes.headers["Cache-Control"] = "no-cache";
                proxyRes.headers["X-Accel-Buffering"] = "no";
              }
            });
          },
        },
      },
    },
  };
});
