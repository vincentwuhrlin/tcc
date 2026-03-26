import { execSync } from "child_process";
import { getPod, getBin } from "../runpodctl.js";
import { sshFlags } from "../ssh.js";
import { checkSetup } from "../preflight.js";
import * as state from "../state.js";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function start(): Promise<void> {
  checkSetup();

  const s = state.load();
  const pod = getPod(s.id);

  if (!pod) {
    console.error(`❌ Pod ${s.id} not found.`);
    process.exit(1);
  }

  if (pod.desiredStatus === "RUNNING") {
    console.log(`✅ Pod ${s.id} is already running.`);
    if (pod.ssh?.ip) {
      console.log(`🔗 SSH: root@${pod.ssh.ip}:${pod.ssh.port}`);
    }
    return;
  }

  console.log(`▶️  Starting pod ${s.id}...`);
  execSync(`${getBin()} pod start ${s.id}`, { stdio: "pipe" });

  process.stdout.write("⏳ Waiting for pod to be ready");
  for (let i = 0; i < 40; i++) {
    await sleep(5000);
    process.stdout.write(".");

    const p = getPod(s.id);
    if (p?.ssh?.ip && p.ssh.port) {
      try {
        execSync(
          `ssh ${sshFlags()} -p ${p.ssh.port} -o ConnectTimeout=5 root@${p.ssh.ip} "echo ok"`,
          { stdio: "pipe", timeout: 15000 },
        );
        console.log(" ✅");
        console.log(`🔗 SSH ready: root@${p.ssh.ip}:${p.ssh.port}`);
        return;
      } catch {
        // not ready yet
      }
    }
  }

  console.log();
  console.log("⚠️  Pod started but SSH not ready yet. Check: npm run gpu:status");
}
