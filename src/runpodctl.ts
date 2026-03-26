import { execSync } from "child_process";
import { existsSync } from "fs";
import { join } from "path";
import { platform } from "os";
import { getGpuConfig } from "./config.js";

// ── Resolve binary path (cached) ────────────────────────────────────

let _binPath: string | null = null;

function findBinary(): string | null {
  // 1. In PATH
  try {
    execSync("runpodctl --version", { stdio: "pipe" });
    return "runpodctl";
  } catch {}

  // 2. Windows: common locations
  if (platform() === "win32") {
    const candidates = [
      join(process.env.LOCALAPPDATA ?? "", "runpodctl.exe"),
      join(process.env.USERPROFILE ?? "", ".runpod", "bin", "runpodctl.exe"),
    ];
    for (const p of candidates) {
      if (existsSync(p)) {
        try {
          execSync(`"${p}" --version`, { stdio: "pipe" });
          return `"${p}"`;
        } catch {}
      }
    }
  }

  return null;
}

export function getBin(): string {
  if (!_binPath) _binPath = findBinary();
  if (!_binPath) {
    console.error("❌ runpodctl not found. Run setup first:");
    console.error("   npm run transcript:setup");
    process.exit(1);
  }
  return _binPath;
}

function run(args: string, opts?: { stdio?: "pipe" | "inherit" }): string {
  return execSync(`${getBin()} ${args}`, {
    stdio: opts?.stdio ?? "pipe",
    encoding: "utf-8",
    timeout: 30000,
  });
}

// ── Check if installed (without error) ───────────────────────────────

export function isInstalled(): boolean {
  return findBinary() !== null;
}

// ── Auto-install based on OS ─────────────────────────────────────────

function install(): void {
  const os = platform();
  console.log(`📦 Installing runpodctl (${os})...`);

  try {
    switch (os) {
      case "darwin":
        execSync("brew install runpod/runpodctl/runpodctl", { stdio: "inherit" });
        break;
      case "linux": {
        const tmpDir = execSync("mktemp -d", { encoding: "utf-8" }).trim();
        execSync(`cd ${tmpDir} && wget -qO- cli.runpod.net | sudo bash`, {
          stdio: "inherit",
        });
        execSync(`rm -rf ${tmpDir}`);
        break;
      }
      case "win32": {
        const dlUrl = "https://github.com/runpod/runpodctl/releases/latest/download/runpodctl-windows-amd64.exe";
        const dest = join(process.env.LOCALAPPDATA ?? "", "runpodctl.exe");
        execSync(
          `powershell -Command "Invoke-WebRequest '${dlUrl}' -OutFile '${dest}'"`,
          { stdio: "inherit" },
        );
        _binPath = `"${dest}"`;
        console.log(`   ℹ️  Installed to ${dest}`);
        break;
      }
      default:
        throw new Error(`Unsupported OS: ${os}`);
    }
    // Reset cached path
    _binPath = null;
    _binPath = findBinary();
    console.log("   ✅ runpodctl installed");
  } catch (err) {
    console.error("❌ Failed to install runpodctl automatically");
    console.error("   Install manually: https://github.com/runpod/runpodctl");
    throw err;
  }
}

// ── Configure API key ────────────────────────────────────────────────

function configure(): void {
  try {
    run(`config --apiKey ${getGpuConfig().apiKey}`);
  } catch {
    // Non-fatal
  }
}

// ── Ensure runpodctl is ready ────────────────────────────────────────

export function ensureRunpodctl(): void {
  if (!isInstalled()) {
    install();
  }
  configure();
}

// ── SSH key management ───────────────────────────────────────────────

export function addSSHKey(publicKeyPath: string): void {
  try {
    const output = run(`ssh add-key --key-file "${publicKeyPath}"`);
    if (output.includes("already exists") || output.includes("No action needed")) {
      console.log("   🔑 Key already in RunPod account");
    } else {
      console.log("   🔑 Key synced to RunPod account ✅");
    }
  } catch (err) {
    const stderr =
      err instanceof Error
        ? ((err as { stderr?: string }).stderr ?? err.message)
        : String(err);
    if (stderr.includes("already exists") || stderr.includes("No action needed")) {
      console.log("   🔑 Key already in RunPod account");
    } else {
      console.log("   ⚠️  Key sync failed:", stderr.trim());
      console.log(`   Add manually: runpodctl ssh add-key --key-file ${publicKeyPath}`);
    }
  }
}

// ── Pod info via runpodctl ───────────────────────────────────────────

export interface PodSSH {
  ip: string;
  port: number;
  ssh_command: string;
}

export interface PodInfo {
  id: string;
  name: string;
  desiredStatus: string;
  costPerHr: number;
  memoryInGb: number;
  vcpuCount: number;
  gpuCount: number;
  imageName: string;
  uptimeSeconds?: number;
  ssh?: PodSSH;
  ports?: string[];
  portMappings?: Record<string, number>;
  publicIp?: string;
}

export function getPod(podId: string): PodInfo | null {
  try {
    const raw = run(`pod get ${podId}`);
    return JSON.parse(raw) as PodInfo;
  } catch {
    return null;
  }
}

export function deletePod(podId: string): void {
  run(`pod delete ${podId}`);
}
