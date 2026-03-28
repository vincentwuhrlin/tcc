import { readFileSync, writeFileSync, existsSync, unlinkSync } from "fs";
import { resolve } from "path";

const STATE_FILE = resolve(process.cwd(), "pod-info.json");

export interface PodState {
  id: string;
  name: string;
  gpu: string;
  costPerHr: string;
  createdAt: string;
  sshIp?: string;
  sshPort?: number;
}

export function exists(): boolean {
  return existsSync(STATE_FILE);
}

export function save(state: PodState): void {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

export function load(): PodState {
  if (!existsSync(STATE_FILE)) {
    console.error('❌ No pod-info.json — run "npm run gpu:create" first.');
    process.exit(1);
  }
  return JSON.parse(readFileSync(STATE_FILE, "utf-8"));
}

export function clear(): void {
  if (existsSync(STATE_FILE)) unlinkSync(STATE_FILE);
}
