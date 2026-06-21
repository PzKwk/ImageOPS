import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { config } from "./config.js";
import { AppError } from "./http.js";
import { createImageArtifact } from "./imageArtifacts.js";

type UpscaleInput = {
  inputPath: string;
  jobId: string;
  width: number;
  height: number;
};

let upscalerLock: Promise<void> = Promise.resolve();

async function withUpscalerLock<T>(runner: () => Promise<T>) {
  const run = upscalerLock.then(runner);
  upscalerLock = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

function splitArgs(template: string) {
  const matches = template.match(/"[^"]+"|'[^']+'|\S+/g) ?? [];
  return matches.map((item) => item.replace(/^["']|["']$/g, ""));
}

function fillArg(arg: string, values: Record<string, string>) {
  return arg.replace(/\{(input|output|width|height)\}/g, (_match, key: string) => values[key]);
}

export async function getUpscalerStatus() {
  let binaryFound = false;
  if (config.rtxUpscaler.mode === "localRTXup") {
    if (config.rtxUpscaler.localRtxup.dir) {
      try {
        await fs.access(config.rtxUpscaler.localRtxup.dir);
        binaryFound = true;
      } catch {
        binaryFound = false;
      }
    }
  } else if (config.rtxUpscaler.bin) {
    try {
      await fs.access(config.rtxUpscaler.bin);
      binaryFound = true;
    } catch {
      binaryFound = false;
    }
  }

  return {
    enabled: config.rtxUpscaler.enabled,
    mode: config.rtxUpscaler.mode,
    configured:
      config.rtxUpscaler.enabled &&
      (config.rtxUpscaler.mode === "localRTXup"
        ? Boolean(config.rtxUpscaler.localRtxup.dir)
        : Boolean(config.rtxUpscaler.bin)),
    binaryFound,
    target: "8K",
    upscaleCost: config.rtxUpscaler.upscaleCost,
    sdkRepo: config.rtxUpscaler.sdkRepo,
    sdkDownloadScript: config.rtxUpscaler.sdkDownloadScript,
    localDir: config.rtxUpscaler.localRtxup.dir,
    expectedInput: config.rtxUpscaler.localRtxup.inputFile,
    expectedOutput: config.rtxUpscaler.localRtxup.outputFile
  };
}

function runProcess(command: string, args: string[], options: { cwd?: string; timeoutMs: number }) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      windowsHide: true,
      shell: false
    });

    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        new AppError(
          504,
          "rtx_upscaler_timeout",
          `RTX-Upscaling hat nach ${options.timeoutMs} ms nicht abgeschlossen.`
        )
      );
    }, options.timeoutMs);

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
        return;
      }

      reject(
        new AppError(
          502,
          "rtx_upscaler_failed",
          stderr.trim() || `RTX-Upcaler wurde mit Code ${code} beendet.`
        )
      );
    });
  });
}

async function emptyDirectoryFilesOnly(directory: string) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  await Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .map((entry) => fs.unlink(path.join(directory, entry.name)))
  );
}

async function upscaleWithLocalRtxup({ inputPath, jobId }: UpscaleInput) {
  const sdkDir = config.rtxUpscaler.localRtxup.dir;
  if (!sdkDir) {
    throw new AppError(409, "local_rtxup_not_configured", "LOCAL_RTXUP_DIR ist nicht gesetzt.");
  }

  const inputFile = path.resolve(sdkDir, config.rtxUpscaler.localRtxup.inputFile);
  const outputFile = path.resolve(sdkDir, config.rtxUpscaler.localRtxup.outputFile);
  const inputDir = path.dirname(inputFile);
  const outputDir = path.dirname(outputFile);

  if (path.basename(inputDir).toLowerCase() !== "input") {
    throw new AppError(409, "local_rtxup_input_dir", "Der localRTXup Input-Ordner muss input heissen.");
  }
  if (path.basename(outputDir).toLowerCase() !== "output") {
    throw new AppError(409, "local_rtxup_output_dir", "Der localRTXup Output-Ordner muss output heissen.");
  }

  await fs.access(sdkDir);
  await fs.mkdir(inputDir, { recursive: true });
  await fs.mkdir(outputDir, { recursive: true });
  await emptyDirectoryFilesOnly(inputDir);
  await fs.rm(outputFile, { force: true });
  await fs.copyFile(inputPath, inputFile);

  const command = `Set-Location -LiteralPath '${sdkDir.replace(/'/g, "''")}'; ${config.rtxUpscaler.localRtxup.command}`;
  await runProcess(
    config.rtxUpscaler.localRtxup.powershell,
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command],
    { cwd: sdkDir, timeoutMs: config.rtxUpscaler.timeoutMs }
  );

  await fs.access(outputFile);

  const filename = `${jobId}-8k.png`;
  const finalPath = path.join(config.generatedDir, filename);
  await fs.copyFile(outputFile, finalPath);

  return createImageArtifact(finalPath);
}

async function upscaleWithCli({ inputPath, jobId, width, height }: UpscaleInput) {
  if (!config.rtxUpscaler.enabled || !config.rtxUpscaler.bin) {
    throw new AppError(
      409,
      "rtx_upscaler_not_configured",
      "Der lokale RTX-Upcaler ist nicht konfiguriert. Setze RTX_UPSCALER_BIN und RTX_UPSCALER_ARGS."
    );
  }

  await fs.access(inputPath);
  await fs.access(config.rtxUpscaler.bin);
  await fs.mkdir(config.generatedDir, { recursive: true });

  const filename = `${jobId}-8k.png`;
  const outputPath = path.join(config.generatedDir, filename);
  const values = {
    input: inputPath,
    output: outputPath,
    width: String(width),
    height: String(height)
  };
  const args = splitArgs(config.rtxUpscaler.args).map((arg) => fillArg(arg, values));

  await runProcess(config.rtxUpscaler.bin, args, { timeoutMs: config.rtxUpscaler.timeoutMs });

  await fs.access(outputPath);

  return createImageArtifact(outputPath);
}

export async function upscaleToEightK(input: UpscaleInput) {
  if (!config.rtxUpscaler.enabled) {
    throw new AppError(409, "rtx_upscaler_disabled", "RTX_UPSCALER_ENABLED ist nicht aktiv.");
  }

  return withUpscalerLock(() =>
    config.rtxUpscaler.mode === "localRTXup" ? upscaleWithLocalRtxup(input) : upscaleWithCli(input)
  );
}
