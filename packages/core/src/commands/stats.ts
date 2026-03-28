import { readFileSync, existsSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { OUTPUT_DIR, PDF_INPUT_DIR, MEDIA_DIR, printHeader } from "../config.js";

const AUDIO_DIR = join(MEDIA_DIR, "audio");

// ── PDF page counting (dependency-free) ──────────────────────────────

function countPdfPages(pdfPath: string): number {
  try {
    const buf = readFileSync(pdfPath);
    const content = buf.toString("latin1");

    // Method 1: look for /Type /Page (not /Pages)
    const matches = content.match(/\/Type\s*\/Page(?!s)/g);
    if (matches && matches.length > 0) return matches.length;

    // Method 2: look for /Count N in the /Pages dict
    const countMatch = content.match(/\/Pages[\s\S]{0,200}\/Count\s+(\d+)/);
    if (countMatch) return parseInt(countMatch[1], 10);

    return 0;
  } catch {
    return 0;
  }
}

function findPdfs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findPdfs(full));
    } else if (entry.name.toLowerCase().endsWith(".pdf")) {
      results.push(full);
    }
  }
  return results;
}

// ── Audio duration parsing ───────────────────────────────────────────

function getAudioDurations(): { file: string; seconds: number }[] {
  const results: { file: string; seconds: number }[] = [];

  // Try .info.json files in audio/ dir
  if (existsSync(AUDIO_DIR)) {
    for (const f of readdirSync(AUDIO_DIR)) {
      if (!f.endsWith(".info.json")) continue;
      try {
        const info = JSON.parse(readFileSync(join(AUDIO_DIR, f), "utf-8"));
        if (info.duration && typeof info.duration === "number") {
          const name = f.replace(".info.json", "");
          results.push({ file: name, seconds: info.duration });
        }
      } catch {}
    }
  }

  // Fallback: parse > Duration: HH:MM:SS from output .md files
  if (results.length === 0) {
    const videosDir = join(OUTPUT_DIR, "videos");
    if (existsSync(videosDir)) {
      for (const f of readdirSync(videosDir)) {
        if (!f.endsWith(".md")) continue;
        try {
          const head = readFileSync(join(videosDir, f), "utf-8").substring(0, 500);
          const match = head.match(/>\s*Duration:\s*(\d{2}):(\d{2}):(\d{2})/);
          if (match) {
            const secs = parseInt(match[1]) * 3600 + parseInt(match[2]) * 60 + parseInt(match[3]);
            results.push({ file: f.replace(".md", ""), seconds: secs });
          }
        } catch {}
      }
    }
  }

  return results;
}

function formatDuration(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = Math.floor(totalSeconds % 60);
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m ${String(s).padStart(2, "0")}s`;
  return `${m}m ${String(s).padStart(2, "0")}s`;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ── Main ──────────────────────────────────────────────────────────────

export async function stats(): Promise<void> {
  printHeader();
  console.log("📊 Knowledge Base Stats");
  console.log("═══════════════════════════════════════════════════");
  console.log();

  // ── PDFs ────────────────────────────────────────────────────────
  const pdfs = findPdfs(PDF_INPUT_DIR);
  const docsDir = join(OUTPUT_DIR, "documents");
  const splitsDir = join(OUTPUT_DIR, "documents", "splits");
  const originalsDir = join(OUTPUT_DIR, "documents", "originals");

  const convertedDocs = existsSync(docsDir)
    ? readdirSync(docsDir).filter((f) => f.endsWith(".md"))
    : [];
  const splitDocs = existsSync(splitsDir)
    ? readdirSync(splitsDir).filter((f) => f.endsWith(".md"))
    : [];
  const originalDocs = existsSync(originalsDir)
    ? readdirSync(originalsDir).filter((f) => f.endsWith(".md"))
    : [];

  let totalPages = 0;
  let totalPdfBytes = 0;
  let totalDocMdBytes = 0;
  let totalSplitMdBytes = 0;

  console.log("📄 Documents (PDFs)");
  console.log("───────────────────────────────────────────────────");

  if (pdfs.length > 0) {
    for (const pdf of pdfs) {
      const pages = countPdfPages(pdf);
      const size = statSync(pdf).size;
      totalPages += pages;
      totalPdfBytes += size;
    }
    console.log(`   Source PDFs:    ${pdfs.length} files, ${totalPages} pages, ${formatSize(totalPdfBytes)}`);
  } else {
    console.log(`   Source PDFs:    none found in ${PDF_INPUT_DIR}`);
  }

  if (convertedDocs.length > 0) {
    for (const f of convertedDocs) {
      totalDocMdBytes += statSync(join(docsDir, f)).size;
    }
    console.log(`   Converted .md:  ${convertedDocs.length} files, ${formatSize(totalDocMdBytes)}`);
  }

  if (splitDocs.length > 0) {
    for (const f of splitDocs) {
      totalSplitMdBytes += statSync(join(splitsDir, f)).size;
    }
    console.log(`   Split chunks:   ${splitDocs.length} files, ${formatSize(totalSplitMdBytes)} (from ${originalDocs.length} originals)`);
  }

  const effectiveDocBytes = totalDocMdBytes + totalSplitMdBytes;
  const effectiveDocCount = convertedDocs.length + splitDocs.length;
  if (effectiveDocCount > 0) {
    console.log(`   Est. tokens:    ~${Math.round(effectiveDocBytes / 4 / 1000)}k`);
  } else {
    console.log(`   Converted .md:  none yet`);
  }

  console.log();

  // ── Videos / Audio ──────────────────────────────────────────────
  const durations = getAudioDurations();
  const videosDir = join(OUTPUT_DIR, "videos");
  const convertedVideos = existsSync(videosDir)
    ? readdirSync(videosDir).filter((f) => f.endsWith(".md"))
    : [];
  const mp3s = existsSync(AUDIO_DIR)
    ? readdirSync(AUDIO_DIR).filter((f) => f.endsWith(".mp3"))
    : [];

  let totalVideoMdBytes = 0;

  console.log("🎬 Videos (audio transcriptions)");
  console.log("───────────────────────────────────────────────────");

  if (durations.length > 0) {
    const totalSecs = durations.reduce((sum, d) => sum + d.seconds, 0);
    console.log(`   Audio files:    ${mp3s.length} mp3s`);
    console.log(`   Total duration: ${formatDuration(totalSecs)}`);
  } else if (mp3s.length > 0) {
    console.log(`   Audio files:    ${mp3s.length} mp3s (duration unknown — no .info.json)`);
  } else {
    console.log(`   Audio files:    none yet`);
  }

  if (convertedVideos.length > 0) {
    for (const f of convertedVideos) {
      totalVideoMdBytes += statSync(join(videosDir, f)).size;
    }
    console.log(`   Transcribed:    ${convertedVideos.length} files, ${formatSize(totalVideoMdBytes)}`);
    console.log(`   Est. tokens:    ~${Math.round(totalVideoMdBytes / 4 / 1000)}k`);
  } else {
    console.log(`   Transcribed:    none yet`);
  }

  console.log();

  // ── Totals ──────────────────────────────────────────────────────
  const totalMd = effectiveDocCount + convertedVideos.length;
  const totalMdBytes = effectiveDocBytes + totalVideoMdBytes;
  const totalTokensK = Math.round(totalMdBytes / 4 / 1000);

  console.log("📚 Total Knowledge Base");
  console.log("───────────────────────────────────────────────────");
  console.log(`   Markdown files: ${totalMd}`);
  console.log(`   Total size:     ${formatSize(totalMdBytes)}`);
  console.log(`   Est. tokens:    ~${totalTokensK}k`);
  console.log();

  // Context window fit check
  const projectLimit = 200; // ~200k tokens for project knowledge
  if (totalTokensK > 0) {
    if (totalTokensK <= projectLimit) {
      console.log(`   ✅ Fits in a single Claude project (~${projectLimit}k token limit)`);
    } else {
      const projectsNeeded = Math.ceil(totalTokensK / projectLimit);
      console.log(`   ⚠️  Exceeds single project (~${projectLimit}k). Need ~${projectsNeeded} projects or use RAG.`);
    }
  }

  // Tagging status
  let tagged = 0;
  for (const dir of [docsDir, splitsDir, videosDir]) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".md")) continue;
      const head = readFileSync(join(dir, f), "utf-8").substring(0, 4);
      if (head === "---\n") tagged++;
    }
  }

  if (totalMd > 0) {
    console.log(`   Tagged:         ${tagged}/${totalMd} (${Math.round((tagged / totalMd) * 100)}%)`);
  }

  console.log();
}
