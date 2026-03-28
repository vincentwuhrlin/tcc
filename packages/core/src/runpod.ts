import { getGpuConfig } from "./config.js";

const BASE = "https://rest.runpod.io/v1";

// ── REST API — used only for pod creation (more control than runpodctl) ──

export interface Pod {
  id: string;
  name: string;
  desiredStatus: string;
  costPerHr: number;
  gpuCount: number;
}

async function api<T = unknown>(
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getGpuConfig().apiKey}`,
    },
    ...(body && { body: JSON.stringify(body) }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`RunPod API ${res.status}: ${JSON.stringify(data)}`);
  }
  return data as T;
}

export const createPod = (config: Record<string, unknown>) =>
  api<Pod>("POST", "/pods", config);

// Used for duplicate name check before creation
export const getPods = () => api<Pod[]>("GET", "/pods");
