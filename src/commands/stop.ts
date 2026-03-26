import { getBin } from "../runpodctl.js";
import { execSync } from "child_process";
import { checkSetup } from "../preflight.js";
import * as state from "../state.js";

export async function stop(): Promise<void> {
  checkSetup();

  const s = state.load();

  console.log(`⏸️  Stopping pod ${s.id}...`);
  execSync(`${getBin()} pod stop ${s.id}`, { stdio: "pipe" });

  console.log("✅ Pod stopped. pod-info.json kept.");
  console.log("   Resume with: npm run gpu:start");
}
