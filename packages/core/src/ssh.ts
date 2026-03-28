import { readFileSync, existsSync } from "fs";
import { platform } from "os";
import { getGpuConfig } from "./config.js";

export function validateKeyPair(): string {
  if (!existsSync(getGpuConfig().sshPrivateKey)) {
    console.error(`❌ SSH private key not found: ${getGpuConfig().sshPrivateKey}`);
    console.error("   Generate one with:");
    console.error(`   ssh-keygen -t ed25519 -f ${getGpuConfig().sshPrivateKey} -C "media2kb"`);
    process.exit(1);
  }
  if (!existsSync(getGpuConfig().sshPublicKey)) {
    console.error(`❌ SSH public key not found: ${getGpuConfig().sshPublicKey}`);
    process.exit(1);
  }

  return readFileSync(getGpuConfig().sshPublicKey, "utf-8").trim();
}

export function getPrivateKeyPath(): string {
  return getGpuConfig().sshPrivateKey;
}

export function sshFlags(): string {
  const nullFile = platform() === "win32" ? "NUL" : "/dev/null";
  return `-i "${getGpuConfig().sshPrivateKey}" -o StrictHostKeyChecking=no -o UserKnownHostsFile=${nullFile} -o ServerAliveInterval=30`;
}
