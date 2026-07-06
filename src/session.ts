/**
 * Phase 2 + 4 — Persistent PTY session interception (FR-01…FR-05).
 *
 * Spawns the native `claude` binary inside a node-pty virtual terminal and
 * hooks the stdin stream. Below the activation threshold every keystroke is
 * passed through with zero added latency. Once the estimated context depth
 * crosses the threshold, the Enter key is held (~300–500ms) while a Haiku
 * evaluation runs, and the prompt is either forwarded, or preceded by an
 * injected /compact | /clear macro (Autopilot), or gated behind the
 * interactive UI.
 */
import { randomUUID } from "node:crypto";
import pty from "node-pty";
import type Anthropic from "@anthropic-ai/sdk";
import { loadConfig, resolveApiKey, type ClifConfig } from "./config.js";
import { appendEvent, recentPrompts } from "./history.js";
import { activationThreshold, inputCostUsd } from "./models.js";
import { TokenTracker } from "./tokens.js";
import { gitStatusPorcelain } from "./git.js";
import { createEvaluatorClient, evaluateDrift, type DriftEvaluation } from "./evaluator.js";
import { decide, buildCompactPayload, type Decision } from "./decision.js";
import { renderInterceptUI, renderAutopilotNotice, renderEvaluating, renderPassNotice } from "./ui.js";

const CTRL_U = "\x15"; // clears the child REPL's pending input line
const CTRL_C = "\x03";

type Mode = "passthrough" | "evaluating" | "menu";

interface PendingIntercept {
  prompt: string;
  evaluation: DriftEvaluation;
  decision: Decision;
  gitStatus: string;
}

export async function runSession(claudeArgs: string[]): Promise<number> {
  const config = loadConfig();
  const sessionId = randomUUID();
  const modelFlag = extractModelFlag(claudeArgs);
  const threshold = activationThreshold(modelFlag, config.default_target_pct);
  const tracker = new TokenTracker();

  const apiKey = resolveApiKey(config);
  let evaluator: Anthropic | null = null;
  if (apiKey) {
    evaluator = createEvaluatorClient(apiKey);
  } else {
    process.stderr.write(
      "[Clif] No Anthropic API key found (set ANTHROPIC_API_KEY or run `clif config`). " +
        "Drift evaluation disabled — running in transparent passthrough mode.\n",
    );
  }

  const shell = pty.spawn(process.env.CLIF_CLAUDE_BIN || "claude", claudeArgs, {
    name: "xterm-256color",
    cols: process.stdout.columns || 80,
    rows: process.stdout.rows || 24,
    cwd: process.cwd(),
    env: process.env as Record<string, string>,
  });

  shell.onData((data) => {
    tracker.addOutput(data);
    process.stdout.write(data);
  });

  process.stdout.on("resize", () => {
    shell.resize(process.stdout.columns || 80, process.stdout.rows || 24);
  });

  let mode: Mode = "passthrough";
  let lineBuffer = "";
  let pending: PendingIntercept | null = null;

  const stdin = process.stdin;
  if (stdin.isTTY) stdin.setRawMode(true);
  stdin.resume();

  const forwardPrompt = (prompt: string) => {
    appendEvent({
      type: "prompt",
      ts: new Date().toISOString(),
      session_id: sessionId,
      prompt,
      estimated_context_tokens: tracker.estimatedTokens,
    });
    tracker.addInput(prompt);
    shell.write("\r");
  };

  const injectMacro = async (action: "compact" | "clear", command: string, originalPrompt: string, uiMode: "autopilot" | "interactive" | "manual") => {
    const before = tracker.estimatedTokens;
    // Clear the child's pending input line, then run the macro.
    shell.write(CTRL_U);
    shell.write(`${command}\r`);
    const saved = action === "clear" ? (tracker.reset(), before) : tracker.compact();
    // Give the REPL a beat to register the slash command, then re-deliver
    // the user's original instruction text.
    await sleep(action === "compact" ? 1500 : 700);
    shell.write(originalPrompt);
    forwardPrompt(originalPrompt);
    // FR-05: local ROI telemetry.
    appendEvent({
      type: "optimization",
      ts: new Date().toISOString(),
      session_id: sessionId,
      action,
      mode: uiMode,
      tokens_before: before,
      tokens_after: tracker.estimatedTokens,
      tokens_saved: saved,
      cost_saved_usd: round4(inputCostUsd(saved, modelFlag)),
      model: modelFlag || "unknown",
    });
    return saved;
  };

  const onEnter = async () => {
    const prompt = lineBuffer.trim();
    lineBuffer = "";

    // Manual slash commands typed by the user keep the tracker honest.
    if (prompt === "/clear") {
      tracker.reset();
      shell.write("\r");
      return;
    }
    if (prompt.startsWith("/compact")) {
      tracker.compact();
      shell.write("\r");
      return;
    }

    const belowThreshold = tracker.estimatedTokens < threshold;
    if (!prompt || prompt.startsWith("/") || belowThreshold || !evaluator) {
      // FR-01: 0ms-lag passthrough below the activation threshold.
      if (prompt && !prompt.startsWith("/")) forwardPrompt(prompt);
      else shell.write("\r");
      return;
    }

    // FR-02: block downstream execution while the multi-vector evaluation runs.
    mode = "evaluating";
    process.stdout.write(renderEvaluating());
    const started = Date.now();
    try {
      const [gitStatus, history] = await Promise.all([
        gitStatusPorcelain(process.cwd()),
        Promise.resolve(recentPrompts(sessionId, 3)),
      ]);
      const evaluation = await evaluateDrift(evaluator, {
        prompt,
        historyPrompts: history,
        gitStatus,
      });
      const decision = decide(evaluation, config.sensitivity_threshold, gitStatus);
      appendEvent({
        type: "evaluation",
        ts: new Date().toISOString(),
        session_id: sessionId,
        prompt,
        drift_score: evaluation.drift_score,
        active_focus: evaluation.active_focus,
        context_relation: evaluation.context_relation,
        recommended_action: decision.recommended_action,
        latency_ms: Date.now() - started,
      });

      if (decision.recommended_action === "none") {
        process.stdout.write(renderPassNotice(Math.round(evaluation.drift_score * 100)));
        forwardPrompt(prompt);
        mode = "passthrough";
        return;
      }

      if (config.auto_execute) {
        // FR-04 Autopilot: suppress UI, silently inject the macro.
        const saved = await injectMacro(
          decision.recommended_action,
          decision.command!,
          prompt,
          "autopilot",
        );
        process.stdout.write(renderAutopilotNotice(saved));
        mode = "passthrough";
        return;
      }

      // FR-04 Interactive: show the UI block and wait for a keystroke.
      pending = { prompt, evaluation, decision, gitStatus };
      process.stdout.write(
        renderInterceptUI({
          contextTokens: tracker.estimatedTokens,
          evaluation,
          decision,
          model: modelFlag,
        }),
      );
      mode = "menu";
    } catch (err) {
      // Fail open: evaluation problems must never block the developer.
      process.stdout.write(`\r\n\x1b[2m[Clif] drift evaluation unavailable (${(err as Error).message}) — forwarding prompt.\x1b[0m\r\n`);
      forwardPrompt(prompt);
      mode = "passthrough";
    }
  };

  const onMenuKey = async (key: string) => {
    if (!pending) {
      mode = "passthrough";
      return;
    }
    const p = pending;
    const accept = key === "\r" || key === "\n";
    const choice = accept ? (p.decision.recommended_action === "compact" ? "1" : "2") : key;
    if (choice === "1" || choice === "2" || choice === "3") {
      process.stdout.write(`${choice}\r\n`);
      pending = null;
      mode = "passthrough";
      if (choice === "3") {
        forwardPrompt(p.prompt); // bypass — prompt text is already typed in the child
        return;
      }
      const action = choice === "1" ? "compact" : "clear";
      const command = action === "compact" ? `/compact ${buildCompactPayload(p.evaluation, p.gitStatus)}` : "/clear";
      const uiMode = accept ? "interactive" : "manual";
      await injectMacro(action, command, p.prompt, uiMode);
    } else if (key === CTRL_C || key === "\x1b") {
      // Cancel: drop the prompt entirely and clear the child's line.
      process.stdout.write("cancelled\r\n");
      pending = null;
      mode = "passthrough";
      shell.write(CTRL_U);
    }
    // Any other key: ignore, keep waiting.
  };

  stdin.on("data", (chunk: Buffer) => {
    const data = chunk.toString("utf8");
    if (mode === "menu") {
      void onMenuKey(data);
      return;
    }
    if (mode === "evaluating") {
      // Swallow keys while the ~300–500ms evaluation runs (Ctrl+C aborts to child).
      if (data === CTRL_C) shell.write(data);
      return;
    }
    // Passthrough: mirror keystrokes into the child while maintaining a local
    // copy of the pending line so intercepts know the full prompt text.
    for (const ch of data) {
      if (ch === "\r" || ch === "\n") {
        void onEnter();
      } else if (ch === "\x7f" || ch === "\b") {
        lineBuffer = lineBuffer.slice(0, -1);
        shell.write(ch);
      } else if (ch === CTRL_U) {
        lineBuffer = "";
        shell.write(ch);
      } else {
        if (ch >= " " || ch === "\t") lineBuffer += ch;
        else lineBuffer = ""; // control chars (Ctrl+C etc.) invalidate the line copy
        shell.write(ch);
      }
    }
  });

  return new Promise<number>((resolve) => {
    shell.onExit(({ exitCode }) => {
      if (stdin.isTTY) stdin.setRawMode(false);
      stdin.pause();
      resolve(exitCode);
    });
  });
}

function extractModelFlag(args: string[]): string | undefined {
  const i = args.indexOf("--model");
  if (i !== -1 && args[i + 1]) return args[i + 1];
  const eq = args.find((a) => a.startsWith("--model="));
  if (eq) return eq.split("=")[1];
  return process.env.ANTHROPIC_MODEL;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

export { extractModelFlag };
