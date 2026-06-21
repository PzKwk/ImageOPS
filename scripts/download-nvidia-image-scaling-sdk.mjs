import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const repoZip =
  "https://github.com/NVIDIAGameWorks/NVIDIAImageScaling/archive/refs/heads/main.zip";
const vendorDir = path.resolve(process.cwd(), "vendor");
const zipPath = path.join(vendorDir, "NVIDIAImageScaling-main.zip");
const outputDir = path.join(vendorDir, "NVIDIAImageScaling");
const expandedDir = path.join(vendorDir, "NVIDIAImageScaling-main");

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: "inherit"
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} exited with code ${code}`));
      }
    });
  });
}

await fs.mkdir(vendorDir, { recursive: true });

console.log(`Downloading ${repoZip}`);
await run("powershell.exe", [
  "-NoProfile",
  "-ExecutionPolicy",
  "Bypass",
  "-Command",
  `Invoke-WebRequest -Uri '${repoZip}' -OutFile '${zipPath.replace(/'/g, "''")}'`
]);

await fs.rm(expandedDir, { recursive: true, force: true });
await fs.rm(outputDir, { recursive: true, force: true });

console.log("Extracting SDK source");
await run("powershell.exe", [
  "-NoProfile",
  "-ExecutionPolicy",
  "Bypass",
  "-Command",
  `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${vendorDir.replace(/'/g, "''")}' -Force`
]);

await fs.rename(expandedDir, outputDir);
console.log(`NVIDIA Image Scaling SDK source extracted to ${outputDir}`);
console.log("This provides source/shader material. Build or wrap your local RTX upscaler, then configure LOCAL_RTXUP_DIR.");
