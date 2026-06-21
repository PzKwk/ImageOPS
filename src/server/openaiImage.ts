import fs from "node:fs/promises";
import path from "node:path";
import { toFile } from "openai";
import sharp from "sharp";
import { config } from "./config.js";
import { AppError } from "./http.js";
import { createImageArtifact } from "./imageArtifacts.js";
import { assertOpenAIConfigured, openaiClient } from "./openaiClient.js";

export type ImageReferenceFile = {
  buffer: Buffer;
  originalname: string;
  mimetype: string;
};

type GenerateImageInput = {
  prompt: string;
  size: string;
  jobId: string;
  background: "opaque" | "transparent";
  files: ImageReferenceFile[];
};

const imageSizeOverrides: Record<string, { requestSize: string; target: { width: number; height: number } }> = {
  "1920x1080": {
    requestSize: "1920x1088",
    target: { width: 1920, height: 1080 }
  },
  "1080x1920": {
    requestSize: "1088x1920",
    target: { width: 1080, height: 1920 }
  }
};

function safeExtension(format: string) {
  if (format === "jpeg") return "jpg";
  if (format === "webp") return "webp";
  return "png";
}

function openaiRequestSize(size: string) {
  return imageSizeOverrides[size]?.requestSize ?? size;
}

async function normalizeOutputSize(filePath: string, size: string) {
  const target = imageSizeOverrides[size]?.target;
  if (!target) return;

  const temporaryPath = `${filePath}.tmp.png`;
  await sharp(filePath)
    .resize({
      width: target.width,
      height: target.height,
      fit: "cover",
      position: "center"
    })
    .png()
    .toFile(temporaryPath);
  await fs.rename(temporaryPath, filePath);
}

export async function generateImage({ prompt, size, jobId, background, files }: GenerateImageInput) {
  assertOpenAIConfigured();
  await fs.mkdir(config.generatedDir, { recursive: true });

  const outputFormat = "png";
  const sizeForOpenAI = openaiRequestSize(size);
  const request = {
    model: config.openaiImageModel,
    prompt,
    size: sizeForOpenAI,
    quality: "high",
    output_format: outputFormat,
    background,
    moderation: "auto",
    n: 1
  };

  const response =
    files.length > 0
      ? await openaiClient.images.edit({
          ...(request as Record<string, unknown>),
          image: await Promise.all(
            files.map((file) =>
              toFile(file.buffer, file.originalname || "reference.png", {
                type: file.mimetype || "image/png"
              })
            )
          )
        } as never)
      : await openaiClient.images.generate(request as never);

  const imageBase64 = response.data?.[0]?.b64_json;
  if (!imageBase64) {
    throw new AppError(502, "openai_empty_image", "OpenAI hat keine Bilddaten zurueckgegeben.");
  }

  const filename = `${jobId}-4k.${safeExtension(outputFormat)}`;
  const filePath = path.join(config.generatedDir, filename);
  await fs.writeFile(filePath, Buffer.from(imageBase64, "base64"));
  await normalizeOutputSize(filePath, size);

  return createImageArtifact(filePath);
}

export function imageErrorMessage(error: unknown) {
  const maybe = error as {
    code?: string;
    request_id?: string;
    moderation_details?: { categories?: string[]; moderation_stage?: string };
    message?: string;
  };

  if (maybe.code === "moderation_blocked") {
    return "Die Bildanfrage wurde durch eine Sicherheitspruefung blockiert. Aendere Prompt oder Referenzbilder.";
  }

  return maybe.message ?? "Die Bildgenerierung ist fehlgeschlagen.";
}
