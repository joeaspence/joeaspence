/**
 * Phase 1 — Local runtime ledger.
 *
 * Line-delimited JSON at ~/.clif/session_history.jsonl. Every prompt line,
 * evaluation, and optimization outcome is appended locally.
 */
import fs from "node:fs";
import { ensureClifDir, historyPath } from "./config.js";

export interface PromptEvent {
  type: "prompt";
  ts: string;
  session_id: string;
  prompt: string;
  estimated_context_tokens: number;
}

export interface EvaluationEvent {
  type: "evaluation";
  ts: string;
  session_id: string;
  prompt: string;
  drift_score: number;
  active_focus: string;
  context_relation: "subsystem_pivot" | "disjoint_pivot";
  recommended_action: "compact" | "clear" | "none";
  latency_ms: number;
}

export interface OptimizationEvent {
  type: "optimization";
  ts: string;
  session_id: string;
  action: "compact" | "clear";
  mode: "autopilot" | "interactive" | "manual";
  tokens_before: number;
  tokens_after: number;
  tokens_saved: number;
  cost_saved_usd: number;
  model: string;
}

export type LedgerEvent = PromptEvent | EvaluationEvent | OptimizationEvent;

/** Appends one event as a single JSONL line. */
export function appendEvent(event: LedgerEvent): void {
  ensureClifDir();
  fs.appendFileSync(historyPath(), `${JSON.stringify(event)}\n`, { mode: 0o600 });
}

/** Reads the full ledger, skipping any malformed lines. */
export function readEvents(): LedgerEvent[] {
  const file = historyPath();
  if (!fs.existsSync(file)) return [];
  const out: LedgerEvent[] = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      /* skip malformed line */
    }
  }
  return out;
}

/** Last N user prompts for this session (most recent last). */
export function recentPrompts(sessionId: string, n: number): string[] {
  return readEvents()
    .filter((e): e is PromptEvent => e.type === "prompt" && e.session_id === sessionId)
    .slice(-n)
    .map((e) => e.prompt);
}
