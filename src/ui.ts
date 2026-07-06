/**
 * Phase 4 — Interactive Mode terminal interface (PRD §5).
 */
import type { DriftEvaluation } from "./evaluator.js";
import type { Decision } from "./decision.js";
import { inputCostUsd } from "./models.js";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const MAGENTA = "\x1b[35m";

export function fmtTokens(n: number): string {
  return n.toLocaleString("en-US");
}

export interface InterceptView {
  contextTokens: number;
  evaluation: DriftEvaluation;
  decision: Decision;
  model: string | undefined;
}

export function renderInterceptUI(v: InterceptView): string {
  const { evaluation, decision } = v;
  const driftPct = Math.round(evaluation.drift_score * 100);
  const extraCost = inputCostUsd(v.contextTokens, v.model);
  const isCompact = decision.recommended_action === "compact";
  const actionLabel = isCompact ? "[INTELLIGENT COMPACT]" : "[HARD SESSION CLEAR]";
  const actionWhy = isCompact
    ? "You are pivoting tasks within the same project workspace.\n   Clif has generated an architectural preservation payload for this session."
    : "Your new instruction is uncoupled from the current session's work.\n   A fresh context start will give Claude maximum accuracy.";

  return [
    "",
    `${YELLOW}${BOLD}⚠️  CLIF: High Topic Drift Intercepted!${RESET}`,
    `${DIM}──────────────────────────────────────────────────────────${RESET}`,
    `• Current Session Context:  ${BOLD}${fmtTokens(v.contextTokens)} tokens${RESET} ${YELLOW}(Entering Risk Zone)${RESET}`,
    `• Prior Session Focus:     ${CYAN}[${evaluation.prior_focus}]${RESET}`,
    `• Detected New Focus:      ${MAGENTA}[${evaluation.active_focus}]${RESET}`,
    "",
    `${BOLD}💡 Analysis:${RESET} Your instruction represents a ${BOLD}${driftPct}% topic shift${RESET}.`,
    `   Proceeding blindly will pollute Claude's memory and cost ~$${extraCost.toFixed(2)} extra/prompt.`,
    "",
    `${GREEN}👉 Clif Recommended Action: ${BOLD}${actionLabel}${RESET}`,
    `   ${actionWhy}`,
    "",
    `${BOLD}[Press ENTER to accept recommendation]${RESET} or select manually:`,
    `   ${BOLD}[1]${RESET} Intelligent Compact ${DIM}(Runs /compact + custom preservation payload)${RESET}`,
    `   ${BOLD}[2]${RESET} Hard Session Clear  ${DIM}(Runs /clear - fresh context start)${RESET}`,
    `   ${BOLD}[3]${RESET} Bypass Clif         ${DIM}(Forward prompt directly to Claude Code)${RESET}`,
    "",
    `${BOLD}[Selection]:${RESET} `,
  ].join("\r\n");
}

/** Autopilot Mode single-line feedback string (FR-04). */
export function renderAutopilotNotice(tokensSaved: number): string {
  return `\r\n${GREEN}${BOLD}[Clif]:${RESET} Autonomous context optimization executed. Saved ~${fmtTokens(tokensSaved)} input tokens.\r\n`;
}

export function renderEvaluating(): string {
  return `\r\n${DIM}[Clif] evaluating topic drift…${RESET}`;
}

export function renderPassNotice(driftPct: number): string {
  return `\r\n${DIM}[Clif] drift ${driftPct}% — below threshold, forwarding prompt.${RESET}\r\n`;
}
