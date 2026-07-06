/**
 * `clif stats` — local ROI dashboard from ~/.clif/session_history.jsonl.
 */
import { readEvents, type EvaluationEvent, type OptimizationEvent, type PromptEvent } from "./history.js";
import { historyPath } from "./config.js";
import { fmtTokens } from "./ui.js";

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const CYAN = "\x1b[36m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

export function runStats(): void {
  const events = readEvents();
  if (events.length === 0) {
    process.stdout.write(`${DIM}No session history yet (${historyPath()}). Run \`clif\` to start a monitored session.${RESET}\n`);
    return;
  }

  const prompts = events.filter((e): e is PromptEvent => e.type === "prompt");
  const evals = events.filter((e): e is EvaluationEvent => e.type === "evaluation");
  const opts = events.filter((e): e is OptimizationEvent => e.type === "optimization");

  const sessions = new Set(events.map((e) => e.session_id)).size;
  const tokensSaved = opts.reduce((s, o) => s + o.tokens_saved, 0);
  const costSaved = opts.reduce((s, o) => s + o.cost_saved_usd, 0);
  const avgDrift = evals.length ? evals.reduce((s, e) => s + e.drift_score, 0) / evals.length : 0;
  const avgLatency = evals.length ? evals.reduce((s, e) => s + e.latency_ms, 0) / evals.length : 0;
  const compacts = opts.filter((o) => o.action === "compact").length;
  const clears = opts.filter((o) => o.action === "clear").length;
  const autopilot = opts.filter((o) => o.mode === "autopilot").length;

  const bar = (v: number, max: number, width = 24) =>
    `${"█".repeat(Math.round((max ? v / max : 0) * width))}${"░".repeat(width - Math.round((max ? v / max : 0) * width))}`;

  const lines = [
    "",
    `${BOLD}📊 Clif — Session Optimization Dashboard${RESET}`,
    `${DIM}──────────────────────────────────────────────────────────${RESET}`,
    `  Sessions monitored        ${BOLD}${sessions}${RESET}`,
    `  Prompts observed          ${BOLD}${prompts.length}${RESET}`,
    `  Drift evaluations         ${BOLD}${evals.length}${RESET} ${DIM}(avg ${Math.round(avgLatency)}ms)${RESET}`,
    `  Optimizations executed    ${BOLD}${opts.length}${RESET} ${DIM}(${compacts} compact / ${clears} clear / ${autopilot} autopilot)${RESET}`,
    "",
    `  ${GREEN}${BOLD}Cumulative tokens saved   ${fmtTokens(tokensSaved)}${RESET}`,
    `  ${GREEN}${BOLD}Estimated cost saved      $${costSaved.toFixed(2)} USD${RESET}`,
    "",
    `  ${BOLD}Average drift trend${RESET}`,
    `  ${CYAN}${bar(avgDrift, 1)}${RESET} ${BOLD}${(avgDrift * 100).toFixed(0)}%${RESET} ${DIM}mean drift score across ${evals.length} evaluations${RESET}`,
    "",
  ];

  // Recent optimizations table
  const recent = opts.slice(-5).reverse();
  if (recent.length) {
    lines.push(`  ${BOLD}Recent optimizations${RESET}`);
    for (const o of recent) {
      const when = o.ts.slice(0, 16).replace("T", " ");
      lines.push(
        `  ${DIM}${when}${RESET}  ${o.action === "compact" ? YELLOW : CYAN}${o.action.padEnd(7)}${RESET} ${o.mode.padEnd(11)} saved ${GREEN}${fmtTokens(o.tokens_saved)}${RESET} tok ($${o.cost_saved_usd.toFixed(3)})`,
      );
    }
    lines.push("");
  }
  process.stdout.write(lines.join("\n") + "\n");
}
