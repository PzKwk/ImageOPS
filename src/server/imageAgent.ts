import fs from "node:fs/promises";
import { config } from "./config.js";
import { AppError } from "./http.js";
import { assertOpenAIConfigured, openaiClient } from "./openaiClient.js";

export type AgentAttempt = {
  attempt: number;
  prompt: string;
  score: number;
  rationale: string;
};

export type ImageAgentEvaluation = {
  score: number;
  rationale: string;
  improvedPrompt: string;
  promptFallbackUsed: boolean;
};

export const imageAgentSystemInstruction =
  "You are an expert image art director and prompt optimizer. Evaluate the generated image against the user's original request and the prompt that created it. Score only visible image quality, fidelity to intent, composition, lighting, clarity, text/logo accuracy when requested, and production readiness. Then rewrite the prompt only when a meaningful improvement is likely. Use affirmative visual language only. Do not write negative prompts. Do not add unrelated objects, claims, brands, celebrities, copyrighted characters, or unwanted text. If text, typography, signage, labels, branding, or logos are requested, preserve the exact wording and make placement, scale, contrast, hierarchy, and legibility explicit. Return strict JSON only.";

const evaluationSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    score: {
      type: "number",
      minimum: 0,
      maximum: 10
    },
    rationale: {
      type: "string"
    },
    improvedPrompt: {
      type: "string"
    }
  },
  required: ["score", "rationale", "improvedPrompt"]
};

function clampScore(score: number) {
  if (!Number.isFinite(score)) return 0;
  return Math.max(0, Math.min(10, Math.round(score * 10) / 10));
}

function extractFencedJson(raw: string) {
  const match = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return match?.[1]?.trim() ?? null;
}

function extractBalancedJsonObject(raw: string) {
  const start = raw.indexOf("{");
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < raw.length; index += 1) {
    const char = raw[index];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (char === "\"") {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;
    if (depth === 0) {
      return raw.slice(start, index + 1).trim();
    }
  }

  return null;
}

function repairJsonCandidate(candidate: string) {
  return candidate
    .trim()
    .replace(/^\uFEFF/, "")
    .replace(/[\u201c\u201d]/g, "\"")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/,\s*([}\]])/g, "$1");
}

function parseJsonCandidate(candidate: string) {
  const parsed = JSON.parse(repairJsonCandidate(candidate)) as unknown;
  if (Array.isArray(parsed)) {
    return parsed.find((item) => item && typeof item === "object") as Record<string, unknown> | undefined;
  }
  return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
}

function valueByAlias(record: Record<string, unknown>, aliases: string[]) {
  const normalized = new Map(
    Object.entries(record).map(([key, value]) => [key.replace(/[_\s-]/g, "").toLowerCase(), value])
  );
  return aliases
    .map((alias) => normalized.get(alias.replace(/[_\s-]/g, "").toLowerCase()))
    .find((value) => value !== undefined && value !== null);
}

function stringByAlias(record: Record<string, unknown>, aliases: string[]) {
  const value = valueByAlias(record, aliases);
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return String(value);
  return "";
}

function numberByAlias(record: Record<string, unknown>, aliases: string[]) {
  const value = valueByAlias(record, aliases);
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const match = value.match(/\d+(?:[.,]\d+)?/);
    return match ? Number(match[0].replace(",", ".")) : NaN;
  }
  return NaN;
}

function normalizeParsedEvaluation(
  parsed: Record<string, unknown> | undefined,
  fallbackPrompt: string
): Partial<ImageAgentEvaluation> | null {
  if (!parsed) return null;
  const improvedPrompt = stringByAlias(parsed, [
    "improvedPrompt",
    "improved_prompt",
    "improvedImagePrompt",
    "improved_image_prompt",
    "nextPrompt",
    "next_prompt",
    "rewrittenPrompt",
    "rewritten_prompt",
    "optimizedPrompt",
    "optimized_prompt",
    "prompt"
  ]);

  return {
    score: numberByAlias(parsed, [
      "score",
      "rating",
      "grade",
      "scoreOutOf10",
      "score_out_of_10",
      "finalScore",
      "evaluation",
      "bewertung"
    ]),
    rationale: stringByAlias(parsed, [
      "rationale",
      "reason",
      "reasoning",
      "feedback",
      "critique",
      "analysis",
      "comment",
      "kommentar",
      "begruendung",
      "begr\u00fcndung",
      "bewertung"
    ]),
    improvedPrompt: improvedPrompt || fallbackPrompt,
    promptFallbackUsed: !improvedPrompt
  };
}

function parseLooseEvaluation(raw: string, fallbackPrompt: string): Partial<ImageAgentEvaluation> | null {
  const scoreMatch =
    raw.match(/(?:score|rating|bewertung|overall|rate(?:d| it)?(?:\s+as)?)\D{0,24}(\d+(?:[.,]\d+)?)(?:\s*(?:\/|out of|von)\s*10)?/i) ??
    raw.match(/(\d+(?:[.,]\d+)?)\s*(?:\/|out of|von)\s*10/i);
  const score = scoreMatch ? Number(scoreMatch[1].replace(",", ".")) : NaN;
  if (!Number.isFinite(score)) return null;

  const improvedPromptMatch = raw.match(
    /(?:improvedPrompt|improved_prompt|improved prompt|verbesserter prompt|next prompt|prompt)\s*[:=]\s*([\s\S]+)$/i
  );
  const rationaleMatch = raw.match(
    /(?:rationale|reasoning|begr(?:uendung|\u00fcndung)|bewertung|feedback|critique)\s*[:=]\s*([\s\S]*?)(?=(?:improvedPrompt|improved_prompt|improved prompt|verbesserter prompt|next prompt|prompt)\s*[:=]|$)/i
  );

  return {
    score,
    rationale: (rationaleMatch?.[1] ?? "Bewertung wurde aus einer nicht strikt formatierten Agent-Antwort gelesen.").trim(),
    improvedPrompt: (improvedPromptMatch?.[1] ?? fallbackPrompt).trim(),
    promptFallbackUsed: !improvedPromptMatch
  };
}

function fallbackEvaluation(fallbackPrompt: string, raw: string): ImageAgentEvaluation {
  const rawExcerpt = raw.trim().replace(/\s+/g, " ").slice(0, 220);
  return {
    score: 0,
    rationale: rawExcerpt
      ? `Die Agent-Bewertung war nicht strukturiert lesbar. Rohantwort: ${rawExcerpt}`
      : "Die Agent-Bewertung war leer oder nicht lesbar. Der aktuelle Prompt wird als Fallback verwendet.",
    improvedPrompt: fallbackPrompt,
    promptFallbackUsed: true
  };
}

function parseEvaluation(raw: string, fallbackPrompt: string): ImageAgentEvaluation {
  const candidates = [
    raw.trim(),
    extractFencedJson(raw),
    extractBalancedJsonObject(raw)
  ].filter((candidate): candidate is string => Boolean(candidate));

  let parsed: Partial<ImageAgentEvaluation> | null = null;
  for (const candidate of candidates) {
    try {
      parsed = normalizeParsedEvaluation(parseJsonCandidate(candidate), fallbackPrompt);
      break;
    } catch {
      parsed = null;
    }
  }

  parsed = parsed ?? parseLooseEvaluation(raw, fallbackPrompt);
  if (!parsed) {
    return fallbackEvaluation(fallbackPrompt, raw);
  }

  const parsedImprovedPrompt = String(parsed.improvedPrompt ?? "").trim();
  const promptFallbackUsed = Boolean(parsed.promptFallbackUsed) || !parsedImprovedPrompt;
  const improvedPrompt = parsedImprovedPrompt || fallbackPrompt;
  const rationale =
    String(parsed.rationale ?? "").trim() ||
    "Die Agent-Bewertung war unvollst\u00e4ndig. Der aktuelle Prompt wird als Fallback verwendet.";

  return {
    score: clampScore(Number(parsed.score)),
    rationale: rationale.slice(0, 700),
    improvedPrompt: improvedPrompt.slice(0, 4000),
    promptFallbackUsed
  };
}

function buildEvaluationInput(input: {
  originalPrompt: string;
  currentPrompt: string;
  attempt: number;
  aspectRatio: string;
}) {
  return [
    `Attempt: ${input.attempt}`,
    `Target aspect ratio: ${input.aspectRatio}`,
    "",
    "Original user request:",
    input.originalPrompt,
    "",
    "Prompt used for this image:",
    input.currentPrompt,
    "",
    "Task:",
    "Score the image from 0 to 10. A 10 means the image is production-ready, faithful to the user's intent, visually coherent, and needs no prompt change. Always return a complete improvedPrompt field. If score is below 10, improvedPrompt must be one complete positive prompt for the next 1080p test render and should differ from the prompt used whenever any concrete visual improvement is possible. Return the same prompt only when no specific prompt change is likely to improve the next render, and explain that in the rationale. Return JSON when possible. If JSON is impossible, write plain fields: Score:, Rationale:, improvedPrompt:."
  ].join("\n");
}

function buildPromptRecoveryInput(input: {
  originalPrompt: string;
  currentPrompt: string;
  score: number;
  rationale: string;
  aspectRatio: string;
}) {
  return [
    "Create one revised image-generation prompt for the next 1080p test render.",
    `Target aspect ratio: ${input.aspectRatio}`,
    `Previous image score: ${input.score}/10`,
    "",
    "Original user request:",
    input.originalPrompt,
    "",
    "Prompt used for the previous render:",
    input.currentPrompt,
    "",
    "Evaluator feedback:",
    input.rationale,
    "",
    "Requirements:",
    "Return only the revised prompt. Preserve the original intent and every stated requirement. Address the evaluator feedback when it contains concrete visual issues. If the feedback is missing or generic, improve fidelity to the original request, composition, subject clarity, lighting, visual hierarchy, and production readiness. Use affirmative visual language only. Keep requested text, logos, labels, or wording exact and make their placement, scale, contrast, and legibility explicit."
  ].join("\n");
}

export async function evaluateGeneratedImage(input: {
  originalPrompt: string;
  currentPrompt: string;
  imagePath: string;
  attempt: number;
  aspectRatio: string;
  userId: string;
}) {
  assertOpenAIConfigured();
  const imageBase64 = await fs.readFile(input.imagePath, "base64");

  const response = await openaiClient.responses.create({
    model: config.openaiPromptProModel,
    instructions: imageAgentSystemInstruction,
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: buildEvaluationInput(input)
          },
          {
            type: "input_image",
            image_url: `data:image/png;base64,${imageBase64}`,
            detail: "high"
          }
        ]
      }
    ],
    max_output_tokens: 1200,
    reasoning: { effort: "medium" },
    text: {
      format: {
        type: "json_schema",
        name: "image_agent_evaluation",
        strict: true,
        schema: evaluationSchema
      }
    },
    store: false,
    user: input.userId
  });

  if (response.error) {
    throw new AppError(
      502,
      "openai_agent_evaluation_failed",
      response.error.message ?? "Der Agent konnte das Bild nicht bewerten."
    );
  }

  return parseEvaluation(response.output_text.trim(), input.currentPrompt);
}

export async function recoverMissingImprovedPrompt(input: {
  originalPrompt: string;
  currentPrompt: string;
  score: number;
  rationale: string;
  aspectRatio: string;
  userId: string;
}) {
  assertOpenAIConfigured();

  const response = await openaiClient.responses.create({
    model: config.openaiPromptProModel,
    instructions:
      "You are an expert image prompt director. Return exactly one improved prompt for the next image render, with no commentary.",
    input: buildPromptRecoveryInput(input),
    max_output_tokens: 1000,
    reasoning: { effort: "medium" },
    store: false,
    user: input.userId
  });

  if (response.error) {
    throw new AppError(
      502,
      "openai_agent_prompt_recovery_failed",
      response.error.message ?? "Der Agent konnte keinen Ersatz-Prompt erzeugen."
    );
  }

  return response.output_text.trim().slice(0, 4000);
}

export function imageAgentError(error: unknown) {
  if (error instanceof AppError) {
    return error;
  }

  const maybe = error as { code?: string; status?: number; message?: string };
  if (maybe.status === 401 || maybe.code === "invalid_api_key") {
    return new AppError(503, "openai_auth_failed", "OpenAI konnte den Agent-Run nicht starten. Pruefe den API-Key.");
  }

  if (maybe.status === 429) {
    return new AppError(429, "openai_rate_limited", "Der Agent ist gerade ausgelastet. Bitte versuche es gleich erneut.");
  }

  if (maybe.code === "model_not_found") {
    return new AppError(503, "openai_agent_model_unavailable", "Das konfigurierte Agent-Modell ist nicht verfuegbar.");
  }

  return new AppError(502, "image_agent_failed", maybe.message ?? "Der Agent-Run ist fehlgeschlagen.");
}
