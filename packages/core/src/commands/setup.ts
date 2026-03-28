import { execSync } from "child_process";
import { mkdirSync, existsSync, writeFileSync } from "fs";
import { platform } from "os";
import { getGpuConfig, MEDIA_DIR, OUTPUT_DIR, PDF_INPUT_DIR, COOKIES_DIR } from "../config.js";
import { ensureRunpodctl, addSSHKey } from "../runpodctl.js";
import { validateKeyPair } from "../ssh.js";

const VIDEOS_MD_TEMPLATE = `# Videos to download

## Example
- [ ] https://www.youtube.com/watch?v=iamgroot
`;

function isCommandAvailable(cmd: string): boolean {
  try {
    execSync(`${platform() === "win32" ? "where" : "which"} ${cmd}`, { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function installDeno(): void {
  const os = platform();
  if (isCommandAvailable("deno")) {
    const ver = execSync("deno --version", { encoding: "utf-8" }).split("\n")[0];
    console.log(`   Already installed: ${ver}`);
    return;
  }

  console.log(`   Installing Deno (${os})...`);
  switch (os) {
    case "win32":
      execSync('powershell -Command "irm https://deno.land/install.ps1 | iex"', { stdio: "inherit" });
      break;
    case "darwin":
    case "linux":
      execSync("curl -fsSL https://deno.land/install.sh | sh", { stdio: "inherit" });
      break;
    default:
      console.log(`   ⚠️  Auto-install not supported on ${os}`);
      console.log("   Install manually: https://deno.land");
      return;
  }
  console.log("   ✅ Deno installed");
}

function installYtDlp(): void {
  // Check if already installed
  if (isCommandAvailable("yt-dlp")) {
    const ver = execSync("yt-dlp --version", { encoding: "utf-8" }).trim();
    console.log(`   Already installed: yt-dlp ${ver}`);
  } else {
    console.log("   Installing yt-dlp...");
    execSync("pip install --pre yt-dlp", { stdio: "inherit" });
  }

  // Install/update ejs plugin
  execSync("pip install --pre -U yt-dlp-ejs", { stdio: "pipe" });
  console.log("   ✅ yt-dlp + ejs plugin ready");
}

function installFfmpeg(): void {
  if (isCommandAvailable("ffmpeg")) {
    console.log("   Already installed");
    return;
  }

  const os = platform();
  console.log(`   Installing ffmpeg (${os})...`);
  switch (os) {
    case "win32":
      console.log("   ⚠️  Install ffmpeg manually: https://ffmpeg.org/download.html");
      console.log("   Or: winget install Gyan.FFmpeg");
      break;
    case "darwin":
      execSync("brew install ffmpeg", { stdio: "inherit" });
      break;
    case "linux":
      execSync("sudo apt-get install -y ffmpeg 2>/dev/null || sudo yum install -y ffmpeg", { stdio: "inherit" });
      break;
  }
}

export async function setup(): Promise<void> {
  console.log("============================================");
  console.log("  🔧 media2kb — Setup");
  console.log("============================================");
  console.log();

  // 1. runpodctl
  console.log("📦 [1/5] runpodctl...");
  ensureRunpodctl();
  console.log("   ✅ runpodctl installed & configured");
  console.log();

  // 2. SSH key
  console.log("🔑 [2/5] SSH key...");
  const publicKey = validateKeyPair();
  console.log(`   ✅ Key found: ${publicKey.substring(0, 40)}...`);
  addSSHKey(getGpuConfig().sshPublicKey);
  console.log();

  // 3. Deno (JS runtime for yt-dlp YouTube support)
  console.log("🦕 [3/5] Deno...");
  installDeno();
  console.log();

  // 4. yt-dlp + ejs + ffmpeg (local video download)
  console.log("📹 [4/5] yt-dlp + ffmpeg...");
  installYtDlp();
  installFfmpeg();
  console.log();

  // 5. Media directory structure
  console.log("📁 [5/5] Media directories...");
  const dirs = [
    MEDIA_DIR,
    OUTPUT_DIR,
    `${OUTPUT_DIR}/documents`,
    `${OUTPUT_DIR}/videos`,
    PDF_INPUT_DIR,
    COOKIES_DIR,
    `${MEDIA_DIR}/audio`,
    `${MEDIA_DIR}/videos`,
  ];

  for (const dir of dirs) {
    mkdirSync(dir, { recursive: true });
  }

  const videosmd = `${MEDIA_DIR}/videos/videos.md`;
  if (!existsSync(videosmd)) {
    writeFileSync(videosmd, VIDEOS_MD_TEMPLATE);
    console.log("   ✅ Created videos/videos.md — edit to add your URLs");
  }

  console.log("   ✅ Structure ready:");
  console.log(`      ${MEDIA_DIR}/`);
  console.log("      ├── output/");
  console.log("      │   ├── documents/");
  console.log("      │   └── videos/");
  console.log("      ├── audio/");
  console.log("      ├── pdfs/");
  console.log("      ├── videos/");
  console.log("      │   └── videos.md");
  console.log("      └── cookies/");

  console.log();
  console.log("============================================");
  console.log("  ✅ Setup complete!");
  console.log("============================================");
  console.log();
  console.log("  Next:");
  console.log("    npm run gpu:create       Create a GPU pod");
  console.log("    npm run transcript:documents    Convert PDFs → .md");
  console.log("    npm run transcript:videos       Download + transcribe videos → .md");
}
