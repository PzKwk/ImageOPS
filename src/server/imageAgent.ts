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
    .replace(/[“”]/g, "\"")
    .replace(/[‘’]/g, "'")
    .replace(/,\s*([}\]])/g, "$1");
}

function parseJsonCandidate(candidate: string) {
  return JSON.parse(repairJsonCandidate(candidate)) as Partial<ImageAgentEvaluation>;
}

function parseLooseEvaluation(raw: string, fallbackPrompt: string): Partial<ImageAgentEvaluation> | null {
  const scoreMatch = raw.match(/(?:score|bewertung)\s*[:=]\s*(\d+(?:[.,]\d+)?)/i) ?? raw.match(/(\d+(?:[.,]\d+)?)\s*\/\s*10/i);
  const score = scoreMatch ? Number(scoreMatch[1].replace(",", ".")) : NaN;
  if (!Number.isFinite(score)) return null;

  const improvedPromptMatch = raw.match(
    /(?:improvedPrompt|improved_prompt|improved prompt|verbesserter prompt|next prompt|prompt)\s*[:=]\s*([\s\S]+)$/i
  );
  const rationaleMatch = raw.match(
    /(?:rationale|reasoning|begründung|begruendung|bewertung)\s*[:=]\s*([\s\S]*?)(?=(?:improvedPrompt|improved_prompt|improved prompt|verbesserter prompt|next prompt|prompt)\s*[:=]|$)/i
  );

  return {
    score,
    rationale: (rationaleMatch?.[1] ?? "Bewertung wurde aus einer nicht strikt formatierten Agent-Antwort gelesen.").trim(),
    improvedPrompt: (improvedPromptMatch?.[1] ?? fallbackPrompt).trim()
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
      parsed = parseJsonCandidate(candidate);
      break;
    } catch {
      parsed = null;
    }
  }

  parsed = parsed ?? parseLooseEvaluation(raw, fallbackPrompt);
  if (!parsed) {
    throw new AppError(502, "openai_agent_invalid_evaluation", "Der Agent hat keine gültige Bewertung geliefert.");
  }

  const improvedPrompt = String(parsed.improvedPrompt ?? "").trim();
  const rationale = String(parsed.rationale ?? "").trim();

  if (!improvedPrompt || !rationale) {
    throw new AppError(502, "openai_agent_invalid_evaluation", "Der Agent hat keine gültige Bewertung geliefert.");
  }

  return {
    score: clampScore(Number(parsed.score)),
    rationale: rationale.slice(0, 700),
    improvedPrompt: improvedPrompt.slice(0, 4000)
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
    "Score the image from 0 to 10. A 10 means the image is production-ready, faithful to the user's intent, visually coherent, and needs no prompt change. If score is below 10, return one complete improved positive prompt for the next 1080p test render. If further improvement is not likely, return the same prompt."
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

  try {
    return parseEvaluation(response.output_text.trim(), input.currentPrompt);
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    throw new AppError(502, "openai_agent_invalid_evaluation", "Der Agent hat kein gültiges JSON geliefert.");
  }
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
