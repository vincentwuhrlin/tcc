import { documents } from "./documents.js";
import { videos } from "./videos.js";

/** Transcribe all: documents (PDFs) then videos (YouTube). */
export async function transcript(): Promise<void> {
  console.log("📄 Transcribing documents...\n");
  await documents();
  console.log("\n🎬 Transcribing videos...\n");
  await videos();
  console.log("\n✅ All transcriptions complete.");
}
