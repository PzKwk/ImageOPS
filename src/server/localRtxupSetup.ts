import fs from "node:fs/promises";
import path from "node:path";
import { config, rootDir } from "./config.js";

type EnvValues = Record<string, string>;

async function exists(filePath: string) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function resolveDirectory(directory?: string) {
  const raw = directory?.trim() || path.join(rootDir, "localRTXup");
  return path.resolve(path.isAbsolute(raw) ? raw : path.join(rootDir, raw));
}

async function upsertEnv(values: EnvValues) {
  const envPath = path.join(rootDir, ".env");
  let lines: string[] = [];

  try {
    lines = (await fs.readFile(envPath, "utf8")).split(/\r?\n/);
  } catch {
    lines = [];
  }

  const pending = new Set(Object.keys(values));
  const next = lines.map((line) => {
    const match = /^([A-Z0-9_]+)=/.exec(line);
    if (!match || !(match[1] in values)) {
      return line;
    }

    pending.delete(match[1]);
    return `${match[1]}=${values[match[1]]}`;
  });

  for (const key of pending) {
    next.push(`${key}=${values[key]}`);
  }

  await fs.writeFile(envPath, `${next.filter((line, index) => line || index < next.length - 1).join("\n")}\n`, "utf8");
}

export async function initializeLocalRtxup(directory?: string) {
  const target = resolveDirectory(directory);
  const inputDir = path.join(target, "input");
  const outputDir = path.join(target, "output");
  const readme = path.join(target, "readme.txt");
  const runScript = path.join(target, "run.ps1");

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

  await upsertEnv({
    RTX_UPSCALER_ENABLED: "true",
    RTX_UPSCALER_MODE: "localRTXup",
    LOCAL_RTXUP_DIR: target,
    LOCAL_RTXUP_COMMAND: ".\\run.ps1",
    LOCAL_RTXUP_INPUT_FILE: config.rtxUpscaler.localRtxup.inputFile,
    LOCAL_RTXUP_OUTPUT_FILE: config.rtxUpscaler.localRtxup.outputFile,
    LOCAL_RTXUP_POWERSHELL: "powershell.exe",
    LOCAL_RTXUP_TILE: "512",
    LOCAL_RTXUP_OVERLAP: "32"
  });

  config.rtxUpscaler.enabled = true;
  config.rtxUpscaler.mode = "localRTXup";
  config.rtxUpscaler.localRtxup.dir = target;
  config.rtxUpscaler.localRtxup.command = ".\\run.ps1";
  config.rtxUpscaler.localRtxup.powershell = "powershell.exe";

  return {
    directory: target,
    inputFile: path.join(inputDir, "4k.png"),
    outputFile: path.join(outputDir, "8k.png"),
    readme,
    runScript
  };
}
