import { getPod } from "../runpodctl.js";
import { checkSetup } from "../preflight.js";
import * as state from "../state.js";

export async function status(): Promise<void> {
  checkSetup();

  const s = state.load();
  const pod = getPod(s.id);

  if (!pod) {
    console.log(`⚠️  Could not reach pod ${s.id}`);
    console.log("   Visit: https://www.runpod.io/console/pods");
    console.log(`   Pod ID: ${s.id}`);
    return;
  }

  if (pod.desiredStatus === "EXITED" || pod.desiredStatus === "TERMINATED") {
    console.log(`⚠️  Pod ${s.id} is ${pod.desiredStatus}`);
    console.log("   npm run gpu:start     → resume");
    console.log("   npm run gpu:terminate → clean up");
    return;
  }

  console.log(`📦 Pod ${pod.id}`);
  console.log(`   Name:     ${pod.name}`);
  console.log(`   Status:   ${pod.desiredStatus}`);
  console.log(`   GPU:      ${pod.gpuCount}x (${pod.memoryInGb}GB RAM, ${pod.vcpuCount} vCPUs)`);
  console.log(`   Cost:     $${pod.costPerHr}/hr`);

  if (pod.ssh?.ip) {
    console.log();
    console.log("🔗 SSH:");
    console.log(`   ${pod.ssh.ip}:${pod.ssh.port}`);
  }
}
