import fs from "node:fs/promises";
import path from "node:path";

const target = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(process.cwd(), "localRTXup");

const inputDir = path.join(target, "input");
const outputDir = path.join(target, "output");
const readme = path.join(target, "readme.txt");
const runScript = path.join(target, "run.ps1");

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

await fs.mkdir(inputDir, { recursive: true });
await fs.mkdir(outputDir, { recursive: true });

if (!(await exists(readme))) {
  await fs.writeFile(
    readme,
    [
      "localRTXup adapter for ImageOPS PRO Lab",
      "",
      "Required SDK contract:",
      "1. Put exactly one input PNG at input\\4k.png",
      "2. Run the PowerShell command configured in LOCAL_RTXUP_COMMAND",
      "3. Write the finished upscaled image to output\\8k.png",
      "",
      "Edit run.ps1 so it calls your real local RTX upscaler.",
      "After that, set these values in .env:",
      `LOCAL_RTXUP_DIR=${target}`,
      "LOCAL_RTXUP_COMMAND=.\\run.ps1",
      "RTX_UPSCALER_ENABLED=true",
      "RTX_UPSCALER_MODE=localRTXup",
      ""
    ].join("\r\n"),
    "utf8"
  );
}

if (!(await exists(runScript))) {
  await fs.writeFile(
    runScript,
    [
      "$ErrorActionPreference = \"Stop\"",
      "$root = Split-Path -Parent $MyInvocation.MyCommand.Path",
      "$input = Join-Path $root \"input\\4k.png\"",
      "$output = Join-Path $root \"output\\8k.png\"",
      "",
      "if (!(Test-Path -LiteralPath $input)) {",
      "  throw \"Missing input\\4k.png\"",
      "}",
      "",
      "# Replace this placeholder with the command from your localRTXup readme.txt.",
      "# The command must read input\\4k.png and write output\\8k.png.",
      "# Example only:",
      "# & \"$root\\YourRtxUpscaler.exe\" --input $input --output $output --scale 2",
      "",
      "throw \"Edit run.ps1 and insert the localRTXup command from readme.txt.\"",
      ""
    ].join("\r\n"),
    "utf8"
  );
}

console.log(`localRTXup folder ready: ${target}`);
console.log("Edit run.ps1 with the SDK command, then copy the shown LOCAL_RTXUP_DIR into .env.");
