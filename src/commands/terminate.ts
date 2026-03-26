import { deletePod } from "../runpodctl.js";
import { checkSetup } from "../preflight.js";
import * as state from "../state.js";

export async function terminate(): Promise<void> {
  checkSetup();

  const s = state.load();

  console.log(`🗑️  Terminating pod ${s.id}...`);
  deletePod(s.id);
  state.clear();

  console.log("✅ Pod destroyed. pod-info.json removed. $0 from now on.");
}
