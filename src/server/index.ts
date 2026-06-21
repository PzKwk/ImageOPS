import path from "node:path";
import fs from "node:fs/promises";
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
  subscriptionPackage,
  targetEightKSize,
  tokenPackages
} from "./config.js";
import { loginUser, registerUser, requireAuth, type AuthenticatedRequest } from "./auth.js";
import { asyncHandler, errorResponse, AppError } from "./http.js";
import {
  appendAgentRunEvent,
  completeAgentRun,
  createAgentRun,
  failAgentRun,
  getAgentRunForUser
} from "./agentRuns.js";
import {
  evaluateGeneratedImage,
  imageAgentError,
  recoverMissingImprovedPrompt,
  type AgentAttempt
} from "./imageAgent.js";
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
}).transform((input) => ({
  ...input,
  background: "opaque" as const
}));

const promptImproveSchema = z.object({
  prompt: z.string().trim().min(3).max(maxPromptImproveLength),
  mode: z.string().trim().max(80).optional(),
  aspectRatio: z.string().trim().max(40).optional(),
  textStrictness: z.string().trim().max(80).optional()
});

const agentImageRequestSchema = imageRequestSchema;
const maxAgentPromptLength = 4000;

function fallbackAgentPromptRevision(input: { currentPrompt: string; rationale: string }) {
  const feedback =
    input.rationale &&
    !input.rationale.includes("nicht strukturiert lesbar") &&
    !input.rationale.includes("leer oder nicht lesbar")
      ? ` Address this evaluator feedback: ${input.rationale}`
      : "";
  const refinement = [
    "Refinement for the next render: improve fidelity to the original request, visual coherence, composition, lighting, subject clarity, detail hierarchy, and production readiness.",
    "Preserve every requested object, style, wording, logo, label, and layout constraint exactly.",
    "Make any requested text large enough, intentionally placed, high contrast, and clearly legible.",
    feedback.trim()
  ]
    .filter(Boolean)
    .join(" ");
  const baseRoom = Math.max(0, maxAgentPromptLength - refinement.length - 2);
  const base = input.currentPrompt.trim().slice(0, baseRoom);
  return `${base}\n\n${refinement}`.trim().slice(0, maxAgentPromptLength);
}

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

function imageAgentPresetsForSelected(size: string) {
  const portrait = size === "1080x1920" || size === "2160x3840";
  const testPreset = findSizePreset(portrait ? "1080x1920" : "1920x1080");
  const finalPreset = findSizePreset(portrait ? "2160x3840" : "3840x2160");
  if (!testPreset || !finalPreset) {
    throw new AppError(500, "agent_presets_missing", "Agent-Presets wurden nicht gefunden.");
  }
  return { testPreset, finalPreset };
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

async function reserveAgentCredits(userId: string, cost: number) {
  await updateStore((store) => {
    const storedUser = store.users.find((item) => item.id === userId);
    if (!storedUser) {
      throw new AppError(401, "invalid_token", "Die Sitzung ist ungueltig.");
    }
    if (storedUser.credits < cost) {
      throw new AppError(
        402,
        "insufficient_credits",
        `Nicht genug Rob-Token Credits fuer den Agent-Run. Maximal benoetigt: ${cost} Credits.`
      );
    }
    storedUser.credits -= cost;
  });
}

async function refundAgentCredits(userId: string, cost: number) {
  if (cost <= 0) return;
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
    const upscaler = await getUpscalerStatus();
    const agentTestCost = findSizePreset("1920x1080")?.baseCost ?? 3;
    const agentFinalCost = findSizePreset("3840x2160")?.baseCost ?? 15;
    const agentUpscaleReady = upscaler.configured && upscaler.binaryFound;
    res.json({
      openaiModel: config.openaiImageModel,
      dataBackend: config.dataBackend,
      quality: "high",
      outputFormat: "png",
      paypalEnabled: config.paypalEnabled,
      paypalClientId: config.paypalClientId,
      paypalCurrency: config.paypalCurrency,
      tokenPackages,
      subscriptionPackage,
      imageSizes: imageSizePresets,
      promptRewrite: {
        thinkingExtraHard: {
          mode: "thinking-extra-hard",
          model: config.openaiPromptModel,
          cost: config.promptRewriteCost
        },
        proDefault: {
          mode: "pro-default",
          model: config.openaiPromptProModel,
          cost: config.promptRewriteProCost
        }
      },
      imageAgent: {
        maxIterations: config.imageAgentMaxIterations,
        testRenderCost: agentTestCost,
        finalRenderCost: agentFinalCost,
        upscaleCost: config.rtxUpscaler.upscaleCost,
        upscalerWillRun: agentUpscaleReady,
        maxCost:
          config.imageAgentMaxIterations * agentTestCost +
          agentFinalCost +
          (agentUpscaleReady ? config.rtxUpscaler.upscaleCost : 0)
      },
      maxUploadMb: config.maxUploadMb,
      upscaler
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

app.get(
  "/api/agents/image/:runId",
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = (req as AuthenticatedRequest).user;
    const runId = z.string().uuid().parse(req.params.runId);
    const run = getAgentRunForUser(runId, user.id);
    if (!run) {
      throw new AppError(404, "agent_run_not_found", "Agent-Run wurde nicht gefunden.");
    }
    res.json(run);
  })
);

app.post(
  "/api/agents/image",
  requireAuth,
  upload.array("images", 6),
  asyncHandler(async (req, res) => {
    const user = (req as AuthenticatedRequest).user;
    const files = (req.files ?? []) as Express.Multer.File[];
    const parsed = agentImageRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, "invalid_agent_request", "Bitte gib einen Prompt mit 3 bis 4000 Zeichen ein.");
    }

    assertOpenAIConfigured();
    const input = parsed.data;
    if (!findSizePreset(input.size)) {
      throw new AppError(400, "invalid_size", "Die angeforderte Bildgroesse ist nicht erlaubt.");
    }

    const { testPreset, finalPreset } = imageAgentPresetsForSelected(input.size);
    const upscalerStatus = await getUpscalerStatus();
    const upscalerReady = upscalerStatus.configured && upscalerStatus.binaryFound;
    const maxCost =
      config.imageAgentMaxIterations * testPreset.baseCost +
      finalPreset.baseCost +
      (upscalerReady ? config.rtxUpscaler.upscaleCost : 0);

    await reserveAgentCredits(user.id, maxCost);

    const run = createAgentRun(user.id);
    appendAgentRunEvent(run.id, {
      level: "info",
      message: `Agent gestartet. Maximal ${maxCost} Credits reserviert; nicht verbrauchte Credits werden erstattet.`
    });

    void (async () => {
      let actualCost = 0;
      const attempts: AgentAttempt[] = [];
      const warnings: string[] = ["Kosten können höher als erwartet ausfallen."];
      let currentPrompt = input.prompt;
      let stoppedReason = "max_iterations";
      let refundSettled = false;
      let best:
        | {
            prompt: string;
            score: number;
            rationale: string;
            generated: Awaited<ReturnType<typeof generateImage>>;
          }
        | null = null;

      try {
        for (let attempt = 1; attempt <= config.imageAgentMaxIterations; attempt += 1) {
          appendAgentRunEvent(run.id, {
            level: "info",
            attempt,
            message: `1080p-Test ${attempt}/${config.imageAgentMaxIterations} gestartet (${testPreset.baseCost} Credits).`
          });

          const testJobId = randomUUID();
          actualCost += testPreset.baseCost;
          const generated = await generateImage({
            prompt: currentPrompt,
            size: testPreset.value,
            jobId: testJobId,
            background: input.background,
            files
          });

          appendAgentRunEvent(run.id, {
            level: "info",
            attempt,
            message: `1080p-Test ${attempt} gerendert. Bewertung läuft.`
          });

          const evaluation = await evaluateGeneratedImage({
            originalPrompt: input.prompt,
            currentPrompt,
            imagePath: generated.pngPath,
            attempt,
            aspectRatio: testPreset.aspect,
            userId: user.id
          });

          attempts.push({
            attempt,
            prompt: currentPrompt,
            score: evaluation.score,
            rationale: evaluation.rationale
          });

          appendAgentRunEvent(run.id, {
            level: "success",
            attempt,
            score: evaluation.score,
            rationale: evaluation.rationale,
            message: `Bewertung Test ${attempt}: ${evaluation.score}/10. ${evaluation.rationale}`
          });

          if (best && evaluation.score <= best.score) {
            stoppedReason = "score_not_improved";
            appendAgentRunEvent(run.id, {
              level: "warning",
              attempt,
              score: evaluation.score,
              message: `Score ist nicht gestiegen (${evaluation.score}/10 nach ${best.score}/10). Agent stoppt und nutzt das bisher beste Bild.`
            });
            break;
          }

          best = {
            prompt: currentPrompt,
            score: evaluation.score,
            rationale: evaluation.rationale,
            generated
          };

          if (evaluation.score >= 10) {
            stoppedReason = "score_10";
            appendAgentRunEvent(run.id, {
              level: "success",
              attempt,
              score: evaluation.score,
              message: "10/10 erreicht. Agent startet den finalen 4K-Render."
            });
            break;
          }

          let nextPrompt = evaluation.improvedPrompt.trim();
          if (evaluation.promptFallbackUsed && evaluation.score < 9) {
            appendAgentRunEvent(run.id, {
              level: "warning",
              attempt,
              score: evaluation.score,
              message:
                "Die Agent-Bewertung enthielt keinen auswertbaren verbesserten Prompt. Agent erzeugt intern einen Ersatz-Prompt fuer den naechsten Test."
            });
            try {
              const recoveredPrompt = await recoverMissingImprovedPrompt({
                originalPrompt: input.prompt,
                currentPrompt,
                score: evaluation.score,
                rationale: evaluation.rationale,
                aspectRatio: testPreset.aspect,
                userId: user.id
              });
              nextPrompt = recoveredPrompt || fallbackAgentPromptRevision({ currentPrompt, rationale: evaluation.rationale });
            } catch (error) {
              const appError = imageAgentError(error);
              appendAgentRunEvent(run.id, {
                level: "warning",
                attempt,
                score: evaluation.score,
                message: `Ersatz-Prompt per Modell fehlgeschlagen. Agent nutzt eine konservative lokale Prompt-Ergaenzung. ${appError.message}`
              });
              nextPrompt = fallbackAgentPromptRevision({ currentPrompt, rationale: evaluation.rationale });
            }
            appendAgentRunEvent(run.id, {
              level: "info",
              attempt,
              score: evaluation.score,
              message: "Ersatz-Prompt fuer den naechsten 1080p-Test wurde erzeugt."
            });
          }

          if (!nextPrompt || nextPrompt === currentPrompt.trim()) {
            stoppedReason = evaluation.promptFallbackUsed ? "evaluation_missing_prompt_high_score" : "no_prompt_change";
            appendAgentRunEvent(run.id, {
              level: "warning",
              attempt,
              score: evaluation.score,
              message: evaluation.promptFallbackUsed
                ? "Die Agent-Bewertung lieferte keinen auswertbaren neuen Prompt, der Score ist aber hoch genug. Finaler Render startet mit dem besten Prompt."
                : "Der Agent sieht keine sinnvolle Prompt-Änderung mehr. Finaler Render startet mit dem besten Prompt."
            });
            break;
          }

          currentPrompt = nextPrompt;
          appendAgentRunEvent(run.id, {
            level: "info",
            attempt,
            score: evaluation.score,
            message: `Prompt für den nächsten 1080p-Test wurde aktualisiert.`
          });
        }

        if (!best) {
          throw new AppError(502, "image_agent_no_result", "Der Agent hat kein Ergebnis erzeugt.");
        }
        const bestResult = best;

        appendAgentRunEvent(run.id, {
          level: "info",
          score: bestResult.score,
          message: `Bestes 1080p-Ergebnis: ${bestResult.score}/10. Finaler 4K-Render startet.`
        });

        const finalJobId = randomUUID();
        actualCost += finalPreset.baseCost;
        const bestBuffer = await fs.readFile(bestResult.generated.pngPath);
        const finalGenerated = await generateImage({
          prompt: bestResult.prompt,
          size: finalPreset.value,
          jobId: finalJobId,
          background: input.background,
          files: [
            {
              buffer: bestBuffer,
              originalname: "agent-best-1080p.png",
              mimetype: "image/png"
            }
          ]
        });

        let imageUrl = finalGenerated.pngUrl;
        let imageJpgUrl = finalGenerated.jpgUrl;
        const sourceImageUrl = finalGenerated.pngUrl;
        const sourceImageJpgUrl = finalGenerated.jpgUrl;
        let targetSize: string | undefined;
        let status: "completed" | "partial" = "completed";
        let upscaleCost = 0;

        appendAgentRunEvent(run.id, {
          level: "success",
          message: "4K-Render ist fertig."
        });

        if (upscalerReady) {
          const target = targetEightKSize(finalPreset.value);
          if (target) {
            actualCost += config.rtxUpscaler.upscaleCost;
            upscaleCost = config.rtxUpscaler.upscaleCost;
            appendAgentRunEvent(run.id, {
              level: "info",
              message: `localRTXup startet den 8K-Versuch (${config.rtxUpscaler.upscaleCost} Credits).`
            });
            try {
              const upscaled = await upscaleToEightK({
                inputPath: finalGenerated.pngPath,
                jobId: finalJobId,
                width: target.width,
                height: target.height
              });
              imageUrl = upscaled.pngUrl;
              imageJpgUrl = upscaled.jpgUrl;
              targetSize = target.label;
              appendAgentRunEvent(run.id, {
                level: "success",
                message: "RTX 8K wurde erfolgreich erzeugt."
              });
            } catch (error) {
              status = "partial";
              const upscalerMessage = imageErrorMessage(error);
              warnings.push(upscalerMessage);
              appendAgentRunEvent(run.id, {
                level: "warning",
                message: `RTX 8K ist fehlgeschlagen. Das 4K-Ergebnis bleibt verfügbar. ${upscalerMessage}`
              });
            }
          }
        } else {
          const skippedMessage = "RTX 8K wurde übersprungen, weil localRTXup noch nicht bereit ist.";
          warnings.push(skippedMessage);
          appendAgentRunEvent(run.id, {
            level: "warning",
            message: skippedMessage
          });
        }

        const refundedCredits = Math.max(0, maxCost - actualCost);
        await refundAgentCredits(user.id, refundedCredits);
        refundSettled = true;

        const payload = await updateStore((store) => {
          const storedUser = store.users.find((item) => item.id === user.id);
          if (!storedUser) {
            throw new AppError(401, "invalid_token", "Die Sitzung ist ungültig.");
          }

          const job = {
            id: finalJobId,
            userId: user.id,
            prompt: bestResult.prompt,
            size: finalPreset.output,
            background: input.background,
            targetSize,
            baseCost: actualCost - upscaleCost,
            upscaleCost,
            totalCost: actualCost,
            status,
            sourceImageUrl,
            sourceImageJpgUrl,
            imageUrl,
            imageJpgUrl,
            error: status === "partial" ? warnings[warnings.length - 1] : undefined,
            referenceCount: 1,
            createdAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
            agentScore: bestResult.score,
            agentAttempts: attempts,
            agentStopReason: stoppedReason
          };

          store.imageJobs.push(job);
          return { job, user: toPublicUser(storedUser) };
        });

        warnings.push(
          `Agent stoppte bei ${bestResult.score}/10 nach ${attempts.length} Test-Rendern.`
        );

        const result = {
          ...payload,
          warning: warnings.join(" "),
          agent: {
            attempts,
            bestScore: bestResult.score,
            finalPrompt: bestResult.prompt,
            stoppedReason,
            reservedCost: maxCost,
            totalCost: actualCost,
            refundedCredits,
            maxIterations: config.imageAgentMaxIterations
          }
        };

        appendAgentRunEvent(run.id, {
          level: "success",
          score: bestResult.score,
          message: `Agent abgeschlossen. Endbewertung: ${bestResult.score}/10. Verbraucht: ${actualCost} Credits, erstattet: ${refundedCredits} Credits.`
        });
        completeAgentRun(run.id, result);
      } catch (error) {
        if (!refundSettled) {
          await refundAgentCredits(user.id, Math.max(0, maxCost - actualCost));
        }
        const appError = imageAgentError(error);
        failAgentRun(run.id, appError.message);
      }
    })();

    const startedRun = getAgentRunForUser(run.id, user.id);
    res.status(202).json(startedRun);
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
