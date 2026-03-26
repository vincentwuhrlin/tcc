import { execSync } from "child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, statSync } from "fs";
import { join, basename } from "path";
import { getPod } from "../runpodctl.js";
import { sshFlags } from "../ssh.js";
import { PDF_INPUT_DIR, OUTPUT_DIR } from "../config.js";
import { checkSetup } from "../preflight.js";
import * as state from "../state.js";

function countPdfPages(pdfPath: string): number {
  try {
    const buf = readFileSync(pdfPath);
    const content = buf.toString("latin1");
    const matches = content.match(/\/Type\s*\/Page(?!s)/g);
    if (matches && matches.length > 0) return matches.length;
    const countMatch = content.match(/\/Pages[\s\S]{0,200}\/Count\s+(\d+)/);
    if (countMatch) return parseInt(countMatch[1], 10);
    return 0;
  } catch {
    return 0;
  }
}

function ssh(ip: string, port: number, cmd: string): void {
  const escaped = cmd.replace(/"/g, '\\"');
  execSync(`ssh ${sshFlags()} -p ${port} root@${ip} "${escaped}"`, {
    stdio: "inherit",
  });
}

// Find PDFs recursively (cross-platform)
function findPdfs(dir: string): string[] {
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

/**
 * Compact excessive whitespace in markdown table rows.
 * Marker often pads cells with hundreds of spaces, inflating token counts 5-10x.
 * Only touches lines starting with | (table rows and separators).
 */
function compactTableWhitespace(content: string): string {
  return content.replace(/^(\|.*\|)$/gm, (line) => {
    // Collapse multiple spaces into one, trim cell content
    return line
      .split("|")
      .map((cell) => cell.replace(/  +/g, " ").trim())
      .join(" | ")
      .replace(/^\s*\| /, "| ")
      .replace(/ \|\s*$/, " |");
  });
}

export async function documents(): Promise<void> {
  checkSetup();

  // ── Validate inputs ────────────────────────────────────────────────
  if (!existsSync(PDF_INPUT_DIR)) {
    console.error(`❌ PDF input dir not found: ${PDF_INPUT_DIR}`);
    console.error("   Set MEDIA_PDF_INPUT in .env");
    process.exit(1);
  }

  const pdfs = findPdfs(PDF_INPUT_DIR);

  if (pdfs.length === 0) {
    console.error(`❌ No PDFs found in ${PDF_INPUT_DIR}`);
    process.exit(1);
  }

  // ── Get pod SSH ────────────────────────────────────────────────────
  const s = state.load();
  const pod = getPod(s.id);

  if (!pod?.ssh?.ip || pod.desiredStatus !== "RUNNING") {
    console.error("❌ Pod not running. Check: npm run gpu:status");
    process.exit(1);
  }

  const { ip, port } = pod.ssh;
  const flags = sshFlags();
  const outDir = `${OUTPUT_DIR}/documents`;
  mkdirSync(outDir, { recursive: true });

  console.log(`📦 Pod ${s.id}`);
  console.log(`📄 Found ${pdfs.length} PDF(s) in ${PDF_INPUT_DIR}`);
  console.log();

  // ── Setup pod directories ──────────────────────────────────────────
  ssh(ip, port, "mkdir -p /root/pdfs /root/docs/documents");

  let done = 0;
  let skipped = 0;

  for (const pdf of pdfs) {
    const pdfName = basename(pdf);
    const mdName = pdfName.replace(/\.pdf$/i, ".md");
    const localMd = join(outDir, mdName);

    // Skip if already converted
    if (existsSync(localMd)) {
      skipped++;
      console.log(`[${done + skipped}/${pdfs.length}] ⏭️  ${mdName} (already done)`);
      continue;
    }

    // Upload PDF
    console.log(`[${done + skipped + 1}/${pdfs.length}] 📤 Uploading ${pdfName}...`);
    execSync(
      `scp ${flags} -P ${port} "${pdf}" root@${ip}:/root/pdfs/`,
      { stdio: "pipe" },
    );

    // Convert with marker_single (single file, no images, markdown only)
    console.log(`[${done + skipped + 1}/${pdfs.length}] 🔄 Converting...`);
    const pdfBaseName = pdfName.replace(/\.pdf$/i, "");
    try {
      ssh(ip, port, `marker_single '/root/pdfs/${pdfName}' --output_format markdown --output_dir /root/marker_out --disable_image_extraction 2>&1 && cp '/root/marker_out/${pdfBaseName}/${pdfBaseName}.md' /root/docs/documents/ && rm -rf /root/marker_out '/root/pdfs/${pdfName}'`);
    } catch {
      console.log(`   ⚠️  Failed: ${pdfName} — skipping`);
      try { ssh(ip, port, "rm -rf /root/marker_out"); } catch {}
      continue;
    }

    // Download .md immediately
    try {
      execSync(
        `scp ${flags} -P ${port} "root@${ip}:/root/docs/documents/${mdName}" "${localMd}"`,
        { stdio: "pipe" },
      );

      // Inject source header (like video transcriptions)
      const mdContent = readFileSync(localMd, "utf-8");
      if (!mdContent.startsWith("> Source:")) {
        const pdfSize = statSync(pdf).size;
        const sizeMB = (pdfSize / (1024 * 1024)).toFixed(1);
        const pages = countPdfPages(pdf);

        const header = [
          `> Source: ${pdf}`,
          pages > 0 ? `> Pages: ${pages}` : null,
          `> Size: ${sizeMB} MB`,
        ].filter(Boolean).join("\n");

        writeFileSync(localMd, header + "\n\n" + mdContent);
      }

      // Post-process: compact table whitespace (marker pads cells with huge spaces)
      // | FR 3 – System integrity      |          | → | FR 3 – System integrity | |
      const processed = readFileSync(localMd, "utf-8");
      const compacted = compactTableWhitespace(processed);
      if (compacted.length < processed.length) {
        writeFileSync(localMd, compacted);
      }

      console.log(`   ✅ ${mdName}`);
      done++;
    } catch {
      console.log(`   ⚠️  Could not download ${mdName}`);
    }
  }

  console.log();
  console.log(`✅ Done! ${done} converted, ${skipped} skipped (already done)`);
  console.log(`   Output: ${outDir}`);
}
