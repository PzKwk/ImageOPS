import { randomUUID } from "node:crypto";
import type { AgentAttempt } from "./imageAgent.js";
import type { ImageJob, PublicUser } from "./store.js";

export type AgentRunEvent = {
  id: string;
  at: string;
  level: "info" | "success" | "warning" | "error";
  message: string;
  attempt?: number;
  score?: number;
  rationale?: string;
};

export type AgentRunResult = {
  job: ImageJob;
  user: PublicUser;
  warning?: string;
  agent: {
    attempts: AgentAttempt[];
    bestScore: number;
    finalPrompt: string;
    stoppedReason: string;
    reservedCost: number;
    totalCost: number;
    refundedCredits: number;
    maxIterations: number;
  };
};

export type AgentRun = {
  id: string;
  userId: string;
  status: "queued" | "running" | "completed" | "failed";
  createdAt: string;
  updatedAt: string;
  events: AgentRunEvent[];
  result?: AgentRunResult;
  error?: string;
};

const agentRuns = new Map<string, AgentRun>();
const maxRunAgeMs = 4 * 60 * 60 * 1000;

function nowIso() {
  return new Date().toISOString();
}

function pruneAgentRuns() {
  const cutoff = Date.now() - maxRunAgeMs;
  for (const [id, run] of agentRuns) {
    if (new Date(run.updatedAt).getTime() < cutoff) {
      agentRuns.delete(id);
    }
  }
}

export function createAgentRun(userId: string) {
  pruneAgentRuns();
  const run: AgentRun = {
    id: randomUUID(),
    userId,
    status: "queued",
    createdAt: nowIso(),
    updatedAt: nowIso(),
    events: []
  };
  agentRuns.set(run.id, run);
  return run;
}

export function appendAgentRunEvent(
  runId: string,
  event: Omit<AgentRunEvent, "id" | "at">
) {
  const run = agentRuns.get(runId);
  if (!run) return null;
  const nextEvent: AgentRunEvent = {
    ...event,
    id: randomUUID(),
    at: nowIso()
  };
  run.events.push(nextEvent);
  run.updatedAt = nextEvent.at;
  if (run.status === "queued") {
    run.status = "running";
  }
  return nextEvent;
}

export function completeAgentRun(runId: string, result: AgentRunResult) {
  const run = agentRuns.get(runId);
  if (!run) return null;
  run.status = "completed";
  run.result = result;
  run.updatedAt = nowIso();
  return run;
}

export function failAgentRun(runId: string, message: string) {
  const run = agentRuns.get(runId);
  if (!run) return null;
  run.status = "failed";
  run.error = message;
  run.updatedAt = nowIso();
  appendAgentRunEvent(runId, {
    level: "error",
    message
  });
  return run;
}

export function getAgentRunForUser(runId: string, userId: string) {
  const run = agentRuns.get(runId);
  if (!run || run.userId !== userId) {
    return null;
  }

  return {
    id: run.id,
    status: run.status,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    events: run.events,
    result: run.result,
    error: run.error
  };
}
