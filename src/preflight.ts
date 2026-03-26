import { isInstalled, getBin } from "./runpodctl.js";

/**
 * Verifies that `npm run transcript:setup` has been run.
 * Call at the start of every command except `setup` itself.
 */
export function checkSetup(): void {
  if (!isInstalled()) {
    console.error("❌ runpodctl not found. Run setup first:");
    console.error("   npm run transcript:setup");
    process.exit(1);
  }

  // Verify API key is configured
  try {
    getBin(); // will exit if not found
  } catch {
    console.error("❌ runpodctl not configured. Run setup first:");
    console.error("   npm run transcript:setup");
    process.exit(1);
  }
}
