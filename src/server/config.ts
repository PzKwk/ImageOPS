import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

dotenv.config();

const here = path.dirname(fileURLToPath(import.meta.url));
export const rootDir = path.resolve(here, "../..");

function env(name: string, fallback = "") {
  return process.env[name] ?? fallback;
}

function envNumber(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function envBoolean(name: string, fallback = false) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

export type ImageSizeValue =
  | "3840x2160"
  | "2160x3840"
  | "1920x1080"
  | "1080x1920";

export type ImageSizePreset = {
  id: string;
  label: string;
  value: ImageSizeValue;
  aspect: string;
  baseCost: number;
  output: string;
};

export const imageSizePresets: ImageSizePreset[] = [
  {
    id: "max-4k-landscape",
    label: "Max 4K",
    value: "3840x2160",
    aspect: "16:9",
    baseCost: 15,
    output: "3840 x 2160"
  },
  {
    id: "max-4k-portrait",
    label: "Max 4K Portrait",
    value: "2160x3840",
    aspect: "9:16",
    baseCost: 15,
    output: "2160 x 3840"
  },
  {
    id: "test-1080p-landscape",
    label: "Test 1080p",
    value: "1920x1080",
    aspect: "16:9",
    baseCost: 3,
    output: "1920 x 1080"
  },
  {
    id: "test-1080p-portrait",
    label: "Test 1080p Portrait",
    value: "1080x1920",
    aspect: "9:16",
    baseCost: 3,
    output: "1080 x 1920"
  }
];

export type TokenPackage = {
  id: string;
  label: string;
  credits: number;
  price: string;
  currency: string;
  badge?: string;
};

export const tokenPackages: TokenPackage[] = [
  {
    id: "starter",
    label: "Starter",
    credits: 100,
    price: "9.00",
    currency: env("PAYPAL_CURRENCY", "EUR")
  },
  {
    id: "studio",
    label: "Studio",
    credits: 320,
    price: "24.00",
    currency: env("PAYPAL_CURRENCY", "EUR"),
    badge: "Best value"
  },
  {
    id: "production",
    label: "Production",
    credits: 1200,
    price: "79.00",
    currency: env("PAYPAL_CURRENCY", "EUR")
  }
];

export const config = {
  nodeEnv: env("NODE_ENV", "development"),
  port: envNumber("PORT", 8080),
  appOrigin: env("APP_ORIGIN", "http://127.0.0.1:5173"),
  jwtSecret: env("JWT_SECRET", "dev-only-change-this-secret"),
  startingCredits: envNumber("STARTING_CREDITS", 20),
  dataBackend: env("DATA_BACKEND", "supabase"),
  supabaseUrl: env("SUPABASE_URL"),
  supabaseServiceRoleKey: env("SUPABASE_SERVICE_ROLE_KEY"),
  openaiApiKey: env("OPENAI_API_KEY"),
  openaiImageModel: env("OPENAI_IMAGE_MODEL", "gpt-image-2"),
  openaiPromptModel: env("OPENAI_PROMPT_MODEL", "gpt-5.5"),
  openaiPromptProModel: env("OPENAI_PROMPT_PRO_MODEL", "gpt-5.5-pro"),
  promptRewriteCost: envNumber("ROB_TOKEN_PROMPT_REWRITE_COST", 1),
  promptRewriteProCost: envNumber("ROB_TOKEN_PROMPT_REWRITE_PRO_COST", 5),
  paypalEnabled: envBoolean("PAYPAL_ENABLED", false),
  paypalEnv: env("PAYPAL_ENV", "sandbox"),
  paypalClientId: env("PAYPAL_CLIENT_ID"),
  paypalClientSecret: env("PAYPAL_CLIENT_SECRET"),
  paypalCurrency: env("PAYPAL_CURRENCY", "EUR"),
  storageDir: path.join(rootDir, "storage"),
  dataFile: path.join(rootDir, "storage", "data", "imageops.json"),
  generatedDir: path.join(rootDir, "storage", "generated"),
  maxUploadMb: 32,
  rtxUpscaler: {
    enabled: envBoolean("RTX_UPSCALER_ENABLED", false),
    mode: env("RTX_UPSCALER_MODE", "localRTXup"),
    bin: env("RTX_UPSCALER_BIN"),
    args: env(
      "RTX_UPSCALER_ARGS",
      "--input {input} --output {output} --width {width} --height {height} --scale 2 --quality ultra"
    ),
    timeoutMs: envNumber("RTX_UPSCALER_TIMEOUT_MS", 900000),
    upscaleCost: envNumber("ROB_TOKEN_UPSCALE_8K_COST", 5),
    sdkRepo: "https://github.com/NVIDIAGameWorks/NVIDIAImageScaling",
    sdkDownloadScript: "npm run rtx:sdk:download",
    localRtxup: {
      dir: env("LOCAL_RTXUP_DIR"),
      command: env("LOCAL_RTXUP_COMMAND", ".\\run.ps1"),
      inputFile: env("LOCAL_RTXUP_INPUT_FILE", "input\\4k.png"),
      outputFile: env("LOCAL_RTXUP_OUTPUT_FILE", "output\\8k.png"),
      powershell: env("LOCAL_RTXUP_POWERSHELL", "powershell.exe")
    }
  }
};

export function findSizePreset(value: string) {
  return imageSizePresets.find((preset) => preset.value === value);
}

export function isFourKSource(value: string) {
  return value === "3840x2160" || value === "2160x3840";
}

export function targetEightKSize(value: string) {
  if (value === "3840x2160") return { width: 7680, height: 4320, label: "7680 x 4320" };
  if (value === "2160x3840") return { width: 4320, height: 7680, label: "4320 x 7680" };
  return null;
}
