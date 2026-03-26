import { execSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync, statSync } from "fs";
import { resolve, join, basename } from "path";
import { getPod } from "../runpodctl.js";
import { sshFlags } from "../ssh.js";
import { VIDEO_LINKS_FILE, OUTPUT_DIR, COOKIES_DIR, MEDIA_DIR } from "../config.js";
import { checkSetup } from "../preflight.js";
import * as state from "../state.js";

const AUDIO_DIR = resolve(`${MEDIA_DIR}/audio`);
const VIDEOS_DIR = resolve(`${MEDIA_DIR}/videos`);
const VIDEO_EXTENSIONS = [".mp4", ".mkv", ".avi", ".mov", ".webm", ".wav", ".flac", ".m4a", ".ogg"];

function ssh(ip: string, port: number, cmd: string): void {
  const escaped = cmd.replace(/"/g, '\\"');
  execSync(`ssh ${sshFlags()} -p ${port} root@${ip} "${escaped}"`, {
    stdio: "inherit",
  });
}

// Remote script: transcribe a SINGLE audio file passed as argument
const TRANSCRIBE_SCRIPT = `
import sys, os
from faster_whisper import WhisperModel

audio = sys.argv[1]
source_url = sys.argv[2] if len(sys.argv) > 2 else ""
duration = sys.argv[3] if len(sys.argv) > 3 else ""
name = os.path.splitext(os.path.basename(audio))[0]
out_path = f"/root/docs/videos/{name}.md"

print(f"Loading model...")
model = WhisperModel("large-v3", device="cuda", compute_type="float16")

print(f"Transcribing: {name}")
segments, info = model.transcribe(audio, beam_size=5)

os.makedirs("/root/docs/videos", exist_ok=True)
with open(out_path, "w") as f:
    f.write(f"# {name}\\n\\n")
    if source_url:
        f.write(f"> Source: {source_url}\\n")
    if duration:
        f.write(f"> Duration: {duration}\\n")
    f.write(f"> Language: {info.language}\\n\\n")
    for segment in segments:
        f.write(f"{segment.text.strip()}\\n\\n")

print(f"Done: {out_path}")
`.trim();

function findCookies(): string | null {
  if (!existsSync(COOKIES_DIR)) return null;

  const files = readdirSync(COOKIES_DIR)
    .filter((f) => f.endsWith(".txt"))
    .map((f) => join(COOKIES_DIR, f));

  const netscape: { path: string; mtime: number }[] = [];
  for (const f of files) {
    try {
      const head = readFileSync(f, "utf-8").substring(0, 40);
      if (head.includes("# Netscape HTTP Cookie File")) {
        const stat = statSync(f);
        netscape.push({ path: f, mtime: stat.mtimeMs });
      }
    } catch {}
  }

  if (netscape.length === 0) return null;
  netscape.sort((a, b) => b.mtime - a.mtime);
  return netscape[0].path;
}

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export async function videos(): Promise<void> {
  checkSetup();
  mkdirSync(AUDIO_DIR, { recursive: true });

  // ── Step 1a: Download YouTube audio ────────────────────────────────
  let ytCount = 0;

  if (existsSync(VIDEO_LINKS_FILE)) {
    const raw = readFileSync(VIDEO_LINKS_FILE, "utf-8");
    const links = raw
      .split("\n")
      .filter((l) => /^\s*-\s*\[x\]/i.test(l))
      .map((l) => l.replace(/^\s*-\s*\[x\]\s*/i, "").trim())
      .filter((l) => l.startsWith("http"));

    if (links.length > 0) {
      console.log(`🎬 Found ${links.length} active URL(s) in videos.md`);

      const cookiesPath = findCookies();
      const cookiesFlag = cookiesPath ? `--cookies "${cookiesPath}"` : "";
      if (cookiesPath) console.log(`🍪 Cookies: ${cookiesPath}`);

      console.log("📥 Step 1a — Downloading YouTube audio...");

      const tmpLinks = resolve(process.cwd(), ".videos-active.txt");
      writeFileSync(tmpLinks, links.join("\n") + "\n");

      try {
        execSync(
          `yt-dlp --remote-components ejs:github ${cookiesFlag} -x --audio-format mp3 --postprocessor-args "ffmpeg:-ac 1 -ar 16000" --write-info-json -o "${AUDIO_DIR}/%(playlist_index)s - %(title)s.%(ext)s" --download-archive "${AUDIO_DIR}/downloaded.txt" --batch-file "${tmpLinks}"`,
          { stdio: "inherit" },
        );
      } finally {
        if (existsSync(tmpLinks)) unlinkSync(tmpLinks);
      }

      ytCount = readdirSync(AUDIO_DIR).filter((f) => f.endsWith(".mp3")).length;
      console.log(`   ✅ ${ytCount} YouTube audio file(s)`);
      console.log();
    }
  }

  // ── Step 1b: Convert local video/audio files ───────────────────────
  let localCount = 0;

  if (existsSync(VIDEOS_DIR)) {
    const localFiles = readdirSync(VIDEOS_DIR).filter((f) => {
      const ext = f.substring(f.lastIndexOf(".")).toLowerCase();
      return VIDEO_EXTENSIONS.includes(ext);
    });

    if (localFiles.length > 0) {
      console.log(`📁 Found ${localFiles.length} local file(s) in videos/`);
      console.log("📥 Step 1b — Converting local files to mp3...");

      for (const file of localFiles) {
        const name = file.substring(0, file.lastIndexOf("."));
        const mp3Name = `${name}.mp3`;
        const mp3Path = join(AUDIO_DIR, mp3Name);

        if (existsSync(mp3Path)) {
          console.log(`   ⏭️  ${mp3Name} (already converted)`);
          continue;
        }

        console.log(`   🔄 Converting ${file}...`);
        try {
          execSync(
            `ffmpeg -i "${join(VIDEOS_DIR, file)}" -ac 1 -ar 16000 -q:a 5 "${mp3Path}" -y`,
            { stdio: "pipe" },
          );

          // Get duration via ffprobe
          let duration = 0;
          try {
            const probe = execSync(
              `ffprobe -v error -show_entries format=duration -of csv=p=0 "${join(VIDEOS_DIR, file)}"`,
              { encoding: "utf-8" },
            ).trim();
            duration = parseFloat(probe) || 0;
          } catch {}

          // Create .info.json with local source + duration
          const infoPath = join(AUDIO_DIR, `${name}.info.json`);
          writeFileSync(infoPath, JSON.stringify({
            webpage_url: `file://${join(VIDEOS_DIR, file)}`,
            title: name,
            duration,
          }));

          localCount++;
          console.log(`   ✅ ${mp3Name}`);
        } catch {
          console.log(`   ⚠️  Failed to convert ${file}`);
        }
      }
      console.log();
    }
  }

  // ── Check we have something to transcribe ──────────────────────────
  const mp3s = readdirSync(AUDIO_DIR).filter((f) => f.endsWith(".mp3"));
  console.log(`🎵 Total: ${mp3s.length} audio file(s) ready (${ytCount} YouTube + ${localCount} local + ${mp3s.length - ytCount - localCount} existing)`);
  console.log();

  if (mp3s.length === 0) {
    console.log("⚠️  No audio files to transcribe.");
    console.log("   Add URLs to media/videos/videos.md");
    console.log("   Or drop video/audio files in media/videos/");
    return;
  }

  // ── Step 2: Transcribe file by file ────────────────────────────────
  const s = state.load();
  const pod = getPod(s.id);

  if (!pod?.ssh?.ip || pod.desiredStatus !== "RUNNING") {
    console.log("⚠️  Pod not running. Audio downloaded locally.");
    console.log("   Start pod and re-run: npm run gpu:create && npm run transcript:videos");
    return;
  }

  const { ip, port } = pod.ssh;
  const flags = sshFlags();
  const outDir = `${OUTPUT_DIR}/videos`;
  mkdirSync(outDir, { recursive: true });

  // Upload transcription script once
  console.log("🎙️  Step 2/2 — Transcribing with faster-whisper (large-v3)...");
  console.log();

  ssh(ip, port, "mkdir -p /root/audio /root/docs/videos");
  const tmpScript = resolve(process.cwd(), ".transcribe.py");
  writeFileSync(tmpScript, TRANSCRIBE_SCRIPT);
  execSync(
    `scp ${flags} -P ${port} "${tmpScript}" root@${ip}:/root/transcribe.py`,
    { stdio: "pipe" },
  );
  unlinkSync(tmpScript);

  let done = 0;
  let skipped = 0;

  for (const mp3 of mp3s) {
    const mdName = mp3.replace(/\.mp3$/, ".md");
    const localMd = join(outDir, mdName);

    // Skip if already transcribed locally
    if (existsSync(localMd)) {
      skipped++;
      console.log(`[${done + skipped}/${mp3s.length}] ⏭️  ${mdName} (already done)`);
      continue;
    }

    const localMp3 = join(AUDIO_DIR, mp3);

    // Read source URL + duration from .info.json
    let sourceUrl = "";
    let duration = "";
    const infoJson = join(AUDIO_DIR, mp3.replace(/\.mp3$/, ".info.json"));
    if (existsSync(infoJson)) {
      try {
        const info = JSON.parse(readFileSync(infoJson, "utf-8"));
        sourceUrl = info.webpage_url ?? info.original_url ?? "";
        if (info.duration) duration = formatDuration(info.duration);
      } catch {}
    }

    // Upload mp3
    console.log(`[${done + skipped + 1}/${mp3s.length}] 📤 Uploading ${mp3}...`);
    execSync(
      `scp ${flags} -P ${port} "${localMp3}" root@${ip}:/root/audio/`,
      { stdio: "pipe" },
    );

    // Transcribe
    console.log(`[${done + skipped + 1}/${mp3s.length}] 🎙️  Transcribing...`);
    try {
      ssh(ip, port, `python3 /root/transcribe.py "/root/audio/${mp3}" "${sourceUrl}" "${duration}"`);
    } catch (err) {
      console.log(`   ⚠️  Failed: ${mp3} — skipping`);
      continue;
    }

    // Download .md immediately
    try {
      execSync(
        `scp ${flags} -P ${port} "root@${ip}:/root/docs/videos/${mdName}" "${localMd}"`,
        { stdio: "pipe" },
      );
      console.log(`   ✅ ${mdName}`);
      done++;
    } catch {
      console.log(`   ⚠️  Could not download ${mdName}`);
    }

    // Clean up mp3 on pod to save space
    try { ssh(ip, port, `rm -f "/root/audio/${mp3}"`); } catch {}
  }

  console.log();
  console.log(`✅ Done! ${done} transcribed, ${skipped} skipped (already done)`);
  console.log(`   Output: ${outDir}`);
}
