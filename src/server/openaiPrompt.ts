import { config } from "./config.js";
import { AppError } from "./http.js";
import { assertOpenAIConfigured, openaiClient } from "./openaiClient.js";

export const maxPromptImproveLength = 4000;

const promptOptimizerSystemInstruction =
  "You are an expert image prompt director. Rewrite the user's request into a production-ready prompt for gpt-image-2. Preserve the user's intent. Add clear composition, lighting, camera/framing, materials, mood, detail level, and visual hierarchy. If the user asks for logos or text, make the text requirements explicit and keep the design readable. Do not add unrelated objects, claims, brands, celebrities, copyrighted characters, or unwanted text. Do not overhype. Output only the final improved image prompt.";

type PromptImproveTier = "long" | "standard";

export type ImprovePromptInput = {
  prompt: string;
  mode?: string;
  aspectRatio?: string;
  textStrictness?: string;
  userId?: string;
};

export type PromptImprovePlan = {
  tier: PromptImproveTier;
  model: string;
  cost: number;
  maxOutputTokens: number;
  reasoningEffort: "low" | "medium";
};

function normalizePromptImproveMode(mode?: string): PromptImproveTier {
  const normalized = mode?.trim().toLowerCase() ?? "";
  if (["basic", "long", "sehr-lang", "very-long", "gpt-5.5"].includes(normalized)) {
    return "long";
  }
  return "standard";
}

export function resolvePromptImprovePlan(mode?: string): PromptImprovePlan {
  const tier = normalizePromptImproveMode(mode);
  if (tier === "long") {
    return {
      tier,
      model: config.openaiPromptModel,
      cost: config.promptRewriteCost,
      maxOutputTokens: 1800,
      reasoningEffort: "low"
    };
  }

  return {
    tier,
    model: config.openaiPromptProModel,
    cost: config.promptRewriteProCost,
    maxOutputTokens: 1400,
    reasoningEffort: "medium"
  };
}

function buildPromptImproveInput(input: ImprovePromptInput, plan: PromptImprovePlan) {
  const detailInstruction =
    plan.tier === "long"
      ? "Rewrite as a very detailed production prompt, but keep it under 3800 characters."
      : "Rewrite as a focused standard production prompt, but keep it under 3000 characters.";

  return [
    detailInstruction,
    `Aspect ratio: ${input.aspectRatio || "not specified"}`,
    `Text strictness: ${input.textStrictness || "default"}`,
    "",
    "User prompt:",
    input.prompt
  ].join("\n");
}

export async function improvePrompt(input: ImprovePromptInput) {
  assertOpenAIConfigured();
  const plan = resolvePromptImprovePlan(input.mode);

  const response = await openaiClient.responses.create({
    model: plan.model,
    instructions: promptOptimizerSystemInstruction,
    input: buildPromptImproveInput(input, plan),
    max_output_tokens: plan.maxOutputTokens,
    reasoning: { effort: plan.reasoningEffort },
    store: false,
    user: input.userId
  });

  if (response.error) {
    throw new AppError(
      502,
      "openai_prompt_improve_failed",
      response.error.message ?? "OpenAI konnte den Prompt nicht verbessern."
    );
  }

  const improvedPrompt = response.output_text.trim();
  if (!improvedPrompt) {
    throw new AppError(502, "openai_empty_prompt", "OpenAI hat keinen verbesserten Prompt zurueckgegeben.");
  }

  return improvedPrompt.slice(0, maxPromptImproveLength).trim();
}

export function promptImproveError(error: unknown) {
  if (error instanceof AppError) {
    return error;
  }

  const maybe = error as { code?: string; status?: number; message?: string };
  if (maybe.status === 401 || maybe.code === "invalid_api_key") {
    return new AppError(
      503,
      "openai_auth_failed",
      "OpenAI konnte den Prompt nicht verbessern. Pruefe den API-Key."
    );
  }

  if (maybe.status === 429) {
    return new AppError(
      429,
      "openai_rate_limited",
      "Prompt verbessern ist gerade ausgelastet. Bitte versuche es gleich erneut."
    );
  }

  if (maybe.code === "model_not_found") {
    return new AppError(
      503,
      "openai_prompt_model_unavailable",
      "Das konfigurierte Prompt-Modell ist nicht verfuegbar."
    );
  }

  return new AppError(
    502,
    "openai_prompt_improve_failed",
    "Prompt verbessern ist fehlgeschlagen. Bitte versuche es erneut."
  );
}
