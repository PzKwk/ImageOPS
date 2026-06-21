import OpenAI from "openai";
import { config } from "./config.js";
import { AppError } from "./http.js";

export const openaiClient = new OpenAI({
  apiKey: config.openaiApiKey || "missing-key"
});

export function assertOpenAIConfigured() {
  if (!config.openaiApiKey) {
    throw new AppError(
      503,
      "openai_not_configured",
      "OPENAI_API_KEY ist nicht gesetzt. Lege den Key in .env ab."
    );
  }
}
