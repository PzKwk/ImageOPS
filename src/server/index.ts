import path from "node:path";
import cors from "cors";
import express from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import multer from "multer";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  config,
  findSizePreset,
  imageSizePresets,
  isFourKSource,
  targetEightKSize,
  tokenPackages
} from "./config.js";
import { loginUser, registerUser, requireAuth, type AuthenticatedRequest } from "./auth.js";
import { asyncHandler, errorResponse, AppError } from "./http.js";
import { assertOpenAIConfigured } from "./openaiClient.js";
import { generateImage, imageErrorMessage } from "./openaiImage.js";
import {
  improvePrompt,
  maxPromptImproveLength,
  promptImproveError,
  resolvePromptImprovePlan
} from "./openaiPrompt.js";
import { capturePayPalOrder, createPayPalOrder } from "./paypal.js";
import { getUpscalerStatus, upscaleToEightK } from "./upscaler.js";
import { readStore, toPublicUser, updateStore } from "./store.js";
import { initializeLocalRtxup } from "./localRtxupSetup.js";

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: config.maxUploadMb * 1024 * 1024,
    files: 6
  },
  fileFilter: (_req, file, cb) => {
    if (["image/png", "image/jpeg", "image/webp"].includes(file.mimetype)) {
      cb(null, true);
      return;
    }
    cb(new AppError(400, "invalid_upload_type", "Nur PNG, JPG und WebP sind erlaubt."));
  }
});

app.use(
  helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" }
  })
);
app.use(
  cors({
    origin: config.appOrigin,
    credentials: true
  })
);
app.use(express.json({ limit: "1mb" }));
app.use(
  rateLimit({
    windowMs: 60_000,
    limit: 180,
    standardHeaders: true,
    legacyHeaders: false
  })
);
app.use("/generated", express.static(config.generatedDir));

const imageRequestSchema = z.object({
  prompt: z.string().trim().min(3).max(4000),
  size: z.string().trim(),
  background: z.enum(["opaque", "transparent"]).default("opaque")
});

const promptImproveSchema = z.object({
  prompt: z.string().trim().min(3).max(maxPromptImproveLength),
  mode: z.string().trim().max(80).optional(),
  aspectRatio: z.string().trim().max(40).optional(),
  textStrictness: z.string().trim().max(80).optional()
});

function imageSizeToPresetValue(size: string) {
  if (size === "3840 x 2160") return "3840x2160";
  if (size === "2160 x 3840") return "2160x3840";
  if (size === "1920 x 1080") return "1920x1080";
  if (size === "1080 x 1920") return "1080x1920";
  return null;
}

function maxRenderValueForSource(size: string) {
  if (size === "1920 x 1080" || size === "3840 x 2160") return "3840x2160";
  if (size === "1080 x 1920" || size === "2160 x 3840") return "2160x3840";
  return null;
}

function localGeneratedPathFromUrl(url?: string) {
  if (!url || !url.startsWith("/generated/")) {
    return null;
  }

  return path.join(config.generatedDir, path.basename(url));
}

async function chargePromptImprove(userId: string, cost: number) {
  await updateStore((store) => {
    const storedUser = store.users.find((item) => item.id === userId);
    if (!storedUser) {
      throw new AppError(401, "invalid_token", "Die Sitzung ist ungueltig.");
    }
    if (storedUser.credits < cost) {
      throw new AppError(402, "insufficient_credits", "Nicht genug Rob-Token Credits fuer Prompt verbessern.");
    }
    storedUser.credits -= cost;
  });
}

async function refundPromptImprove(userId: string, cost: number) {
  await updateStore((store) => {
    const storedUser = store.users.find((item) => item.id === userId);
    if (storedUser) {
      storedUser.credits += cost;
    }
  });
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.get(
  "/api/config",
  asyncHandler(async (_req, res) => {
    res.json({
      openaiModel: config.openaiImageModel,
      dataBackend: config.dataBackend,
      quality: "high",
      outputFormat: "png",
      paypalEnabled: config.paypalEnabled,
      paypalClientId: config.paypalClientId,
      paypalCurrency: config.paypalCurrency,
      tokenPackages,
      imageSizes: imageSizePresets,
      maxUploadMb: config.maxUploadMb,
      upscaler: await getUpscalerStatus()
    });
  })
);

app.post(
  "/api/auth/register",
  asyncHandler(async (req, res) => {
    res.status(201).json(await registerUser(req.body));
  })
);

app.post(
  "/api/auth/login",
  asyncHandler(async (req, res) => {
    res.json(await loginUser(req.body));
  })
);

app.get(
  "/api/auth/me",
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json({ user: (req as AuthenticatedRequest).user });
  })
);

app.get(
  "/api/jobs",
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = (req as AuthenticatedRequest).user;
    const jobs = await readStore((store) =>
      store.imageJobs
        .filter((job) => job.userId === user.id)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    );
    res.json({ jobs });
  })
);

app.post(
  "/api/prompts/improve",
  requireAuth,
  asyncHandler(async (req, res) => {
    const parsed = promptImproveSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(
        400,
        "invalid_prompt_improve_request",
        "Bitte gib einen Prompt mit 3 bis 4000 Zeichen ein."
      );
    }

    assertOpenAIConfigured();
    const user = (req as AuthenticatedRequest).user;
    const plan = resolvePromptImprovePlan(parsed.data.mode);
    await chargePromptImprove(user.id, plan.cost);

    try {
      const improvedPrompt = await improvePrompt({
        ...parsed.data,
        userId: user.id
      });
      res.json({ improvedPrompt });
    } catch (error) {
      await refundPromptImprove(user.id, plan.cost);
      throw promptImproveError(error);
    }
  })
);

app.post(
  "/api/images/generate",
  requireAuth,
  upload.array("images", 6),
  asyncHandler(async (req, res) => {
    const user = (req as AuthenticatedRequest).user;
    const files = (req.files ?? []) as Express.Multer.File[];
    const input = imageRequestSchema.parse(req.body);
    const preset = findSizePreset(input.size);
    if (!preset) {
      throw new AppError(400, "invalid_size", "Die angeforderte Bildgroesse ist nicht erlaubt.");
    }

    const jobId = randomUUID();
    const totalCost = preset.baseCost;

    await updateStore((store) => {
      const storedUser = store.users.find((item) => item.id === user.id);
      if (!storedUser) {
        throw new AppError(401, "invalid_token", "Die Sitzung ist ungueltig.");
      }
      if (storedUser.credits < totalCost) {
        throw new AppError(402, "insufficient_credits", "Nicht genug Rob-Token Credits.");
      }
      storedUser.credits -= totalCost;
      store.imageJobs.push({
        id: jobId,
        userId: user.id,
        prompt: input.prompt,
        size: preset.output,
        background: input.background,
        baseCost: preset.baseCost,
        upscaleCost: 0,
        totalCost,
        status: "pending",
        referenceCount: files.length,
        createdAt: new Date().toISOString()
      });
    });

    let generated: Awaited<ReturnType<typeof generateImage>> | null = null;
    try {
      generated = await generateImage({
        prompt: input.prompt,
        size: preset.value,
        jobId,
        background: input.background,
        files
      });

      const payload = await updateStore((store) => {
        const job = store.imageJobs.find((item) => item.id === jobId);
        const storedUser = store.users.find((item) => item.id === user.id);
        if (!job || !storedUser) {
          throw new AppError(500, "job_missing", "Job konnte nicht gespeichert werden.");
        }
        job.status = "completed";
        job.sourceImageUrl = generated?.pngUrl;
        job.sourceImageJpgUrl = generated?.jpgUrl;
        job.imageUrl = generated?.pngUrl;
        job.imageJpgUrl = generated?.jpgUrl;
        job.completedAt = new Date().toISOString();
        return { job, user: toPublicUser(storedUser) };
      });

      res.status(201).json(payload);
    } catch (error) {
      await updateStore((store) => {
        const job = store.imageJobs.find((item) => item.id === jobId);
        if (job) {
          job.status = "failed";
          job.error = imageErrorMessage(error);
          job.completedAt = new Date().toISOString();
        }
      });
      throw error;
    }
  })
);

app.post(
  "/api/jobs/:jobId/upscale-8k",
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = (req as AuthenticatedRequest).user;
    const jobId = z.string().uuid().parse(req.params.jobId);
    const status = await getUpscalerStatus();
    if (!status.configured || !status.binaryFound) {
      throw new AppError(
        409,
        "rtx_upscaler_not_ready",
        "RTX 8K ist noch nicht bereit. Setze LOCAL_RTXUP_DIR und den PowerShell-Befehl aus der readme.txt."
      );
    }

    const prepare = await updateStore((store) => {
      const job = store.imageJobs.find((item) => item.id === jobId && item.userId === user.id);
      const storedUser = store.users.find((item) => item.id === user.id);
      if (!job || !storedUser) {
        throw new AppError(404, "job_not_found", "Job wurde nicht gefunden.");
      }
      if (job.targetSize) {
        throw new AppError(409, "already_upscaled", "Dieser Job wurde bereits auf 8K nachbearbeitet.");
      }
      if (job.status !== "completed" && job.status !== "partial") {
        throw new AppError(409, "job_not_ready", "Der 4K-Job ist noch nicht fertig.");
      }

      const sourceValue = imageSizeToPresetValue(job.size);
      if (!sourceValue || !isFourKSource(sourceValue)) {
        throw new AppError(400, "job_not_4k", "RTX 8K Nachbearbeitung benoetigt ein 4K-Quellbild.");
      }

      if (storedUser.credits < config.rtxUpscaler.upscaleCost) {
        throw new AppError(402, "insufficient_credits", "Nicht genug Rob-Token Credits fuer 8K RTX.");
      }

      storedUser.credits -= config.rtxUpscaler.upscaleCost;
      return { sourceValue };
    });

    const target = targetEightKSize(prepare.sourceValue);
    if (!target) {
      throw new AppError(400, "invalid_upscale_size", "8K RTX benoetigt ein 4K-Quellbild.");
    }

    try {
      const upscaled = await upscaleToEightK({
        inputPath: path.join(config.generatedDir, `${jobId}-4k.png`),
        jobId,
        width: target.width,
        height: target.height
      });

      const payload = await updateStore((store) => {
        const job = store.imageJobs.find((item) => item.id === jobId && item.userId === user.id);
        const storedUser = store.users.find((item) => item.id === user.id);
        if (!job || !storedUser) {
          throw new AppError(404, "job_not_found", "Job wurde nicht gefunden.");
        }
        job.sourceImageUrl = job.sourceImageUrl ?? job.imageUrl;
        job.sourceImageJpgUrl = job.sourceImageJpgUrl ?? job.imageJpgUrl;
        job.imageUrl = upscaled.pngUrl;
        job.imageJpgUrl = upscaled.jpgUrl;
        job.targetSize = target.label;
        job.upscaleCost += config.rtxUpscaler.upscaleCost;
        job.totalCost += config.rtxUpscaler.upscaleCost;
        job.status = "completed";
        job.error = undefined;
        job.completedAt = new Date().toISOString();
        return { job, user: toPublicUser(storedUser) };
      });

      res.json(payload);
    } catch (error) {
      await updateStore((store) => {
        const job = store.imageJobs.find((item) => item.id === jobId && item.userId === user.id);
        if (job) {
          job.error = imageErrorMessage(error);
        }
      });
      throw error;
    }
  })
);

app.post(
  "/api/jobs/:jobId/render-max",
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = (req as AuthenticatedRequest).user;
    const sourceJobId = z.string().uuid().parse(req.params.jobId);

    const prepare = await updateStore((store) => {
      const sourceJob = store.imageJobs.find((item) => item.id === sourceJobId && item.userId === user.id);
      const storedUser = store.users.find((item) => item.id === user.id);
      if (!sourceJob || !storedUser) {
        throw new AppError(404, "job_not_found", "Job wurde nicht gefunden.");
      }
      if (sourceJob.status !== "completed" && sourceJob.status !== "partial") {
        throw new AppError(409, "job_not_ready", "Der Test-Job ist noch nicht fertig.");
      }

      const maxValue = maxRenderValueForSource(sourceJob.size);
      if (!maxValue) {
        throw new AppError(400, "job_not_promotable", "Nur 1080p-Testjobs koennen als 4K Max neu gerendert werden.");
      }

      const preset = findSizePreset(maxValue);
      if (!preset) {
        throw new AppError(500, "max_preset_missing", "4K Max Preset wurde nicht gefunden.");
      }
      if (sourceJob.size === preset.output) {
        throw new AppError(409, "already_max", "Dieser Job ist bereits ein 4K Max Render.");
      }

      const sourcePath = localGeneratedPathFromUrl(sourceJob.imageUrl);
      if (!sourcePath) {
        throw new AppError(409, "source_image_missing", "Das 1080p-Ausgangsbild wurde nicht gefunden.");
      }

      if (storedUser.credits < preset.baseCost) {
        throw new AppError(402, "insufficient_credits", "Nicht genug Rob-Token Credits fuer 4K Max.");
      }

      const newJobId = randomUUID();
      storedUser.credits -= preset.baseCost;
      store.imageJobs.push({
        id: newJobId,
        userId: user.id,
        prompt: sourceJob.prompt,
        size: preset.output,
        background: sourceJob.background ?? "opaque",
        baseCost: preset.baseCost,
        upscaleCost: 0,
        totalCost: preset.baseCost,
        status: "pending",
        referenceCount: 1,
        createdAt: new Date().toISOString()
      });

      return {
        newJobId,
        sourcePath,
        prompt: sourceJob.prompt,
        background: sourceJob.background ?? "opaque",
        preset
      };
    });

    try {
      const sourceBuffer = await import("node:fs/promises").then((fs) => fs.readFile(prepare.sourcePath));
      const generated = await generateImage({
        prompt: prepare.prompt,
        size: prepare.preset.value,
        jobId: prepare.newJobId,
        background: prepare.background,
        files: [
          {
            buffer: sourceBuffer,
            originalname: "1080p-test-source.png",
            mimetype: "image/png"
          }
        ]
      });

      const payload = await updateStore((store) => {
        const job = store.imageJobs.find((item) => item.id === prepare.newJobId);
        const storedUser = store.users.find((item) => item.id === user.id);
        if (!job || !storedUser) {
          throw new AppError(500, "job_missing", "Job konnte nicht gespeichert werden.");
        }
        job.status = "completed";
        job.sourceImageUrl = generated.pngUrl;
        job.sourceImageJpgUrl = generated.jpgUrl;
        job.imageUrl = generated.pngUrl;
        job.imageJpgUrl = generated.jpgUrl;
        job.completedAt = new Date().toISOString();
        return { job, user: toPublicUser(storedUser) };
      });

      res.status(201).json(payload);
    } catch (error) {
      await updateStore((store) => {
        const job = store.imageJobs.find((item) => item.id === prepare.newJobId);
        if (job) {
          job.status = "failed";
          job.error = imageErrorMessage(error);
          job.completedAt = new Date().toISOString();
        }
      });
      throw error;
    }
  })
);

app.post(
  "/api/rtx/local-init",
  requireAuth,
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        directory: z.string().trim().min(1).max(260).optional()
      })
      .parse(req.body);

    const setup = await initializeLocalRtxup(body.directory);
    res.json({
      setup,
      upscaler: await getUpscalerStatus()
    });
  })
);

app.post(
  "/api/paypal/create-order",
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = (req as AuthenticatedRequest).user;
    const body = z.object({ packageId: z.string().min(1) }).parse(req.body);
    res.status(201).json(await createPayPalOrder(user.id, body.packageId));
  })
);

app.post(
  "/api/paypal/capture-order",
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = (req as AuthenticatedRequest).user;
    const body = z.object({ orderId: z.string().min(1) }).parse(req.body);
    res.json(await capturePayPalOrder(user.id, body.orderId));
  })
);

if (config.nodeEnv === "production") {
  const clientDir = path.join(config.storageDir, "..", "dist", "client");
  app.use(express.static(clientDir));
  app.get("*", (_req, res) => {
    res.sendFile(path.join(clientDir, "index.html"));
  });
}

app.use(errorResponse);

app.listen(config.port, () => {
  console.log(`ImageOPS PRO Lab API listening on http://127.0.0.1:${config.port}`);
});
