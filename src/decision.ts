/**
 * Phase 3/4 — Autonomous decision matrix (FR-03).
 *
 * Maps drift telemetry to the optimal cleanup macro:
 *   subsystem_pivot -> /compact with a custom context-preservation payload
 *   disjoint_pivot  -> /clear
 */
import type { DriftEvaluation } from "./evaluator.js";

export interface Decision {
  recommended_action: "compact" | "clear" | "none";
  /** Full slash command to inject down the PTY, when action != none. */
  command: string | null;
}

export function decide(evaluation: DriftEvaluation, sensitivityThreshold: number, gitStatus: string): Decision {
  if (evaluation.drift_score < sensitivityThreshold) {
    return { recommended_action: "none", command: null };
  }
  if (evaluation.context_relation === "subsystem_pivot") {
    return {
      recommended_action: "compact",
      command: `/compact ${buildCompactPayload(evaluation, gitStatus)}`,
    };
  }
  return { recommended_action: "clear", command: "/clear" };
}

/**
 * Constructs the context-compression prompt that preserves the parameters
 * relevant to the new focus (e.g. active file paths from git telemetry).
 */
export function buildCompactPayload(evaluation: DriftEvaluation, gitStatus: string): string {
  const files = gitStatus
    .split("\n")
    .map((l) => l.slice(3).trim())
    .filter(Boolean)
    .slice(0, 8);
  const filesClause = files.length ? ` Preserve state and decisions for these in-flight files: ${files.join(", ")}.` : "";
  return `Keep current focus on ${evaluation.active_focus}.${filesClause} Discard exploratory dead ends and verbose tool output from earlier topics.`;
}
