import { execSync } from "child_process";
import { getPod } from "../runpodctl.js";
import { sshFlags } from "../ssh.js";
import { checkSetup } from "../preflight.js";
import * as state from "../state.js";

export async function ssh(): Promise<void> {
  checkSetup();

  const s = state.load();
  const pod = getPod(s.id);

  if (!pod?.ssh?.ip) {
    console.log("⏳ Pod not ready yet. Run 'npm run gpu:status' to check.");
    return;
  }

  const { ip, port } = pod.ssh;
  const flags = sshFlags();

  const arg = process.argv[3];

  if (arg === "pull") {
    console.log("📥 Pulling files...");
    try { execSync(`scp ${flags} -P ${port} -r root@${ip}:/root/videos ./videos`, { stdio: "inherit" }); } catch {}
    try { execSync(`scp ${flags} -P ${port} -r root@${ip}:/root/pdfs ./pdfs`, { stdio: "inherit" }); } catch {}
    console.log("✅ Done.");
    return;
  }

  execSync(`ssh ${flags} -p ${port} root@${ip}`, { stdio: "inherit" });
}
