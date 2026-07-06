/**
 * Phase 3 — Semantic drift connector (FR-02).
 *
 * Bundles the current prompt, the last 3 historical prompts, and the
 * uncommitted git changes, then runs a rapid low-cost evaluation on a small
 * Claude model, returning a structured JSON verdict.
 *
 * NOTE ON THE MODEL: the PRD names `claude-3-5-haiku`, but that model was
 * retired by Anthropic in February 2026 and now returns a 404. Clif uses its
 * drop-in replacement `claude-haiku-4-5` ($1/MTok input), which also supports
 * schema-enforced structured outputs — so the evaluation JSON is guaranteed
 * valid without brittle string parsing.
 */
import Anthropic from "@anthropic-ai/sdk";

export const EVALUATOR_MODEL = "claude-haiku-4-5";

export interface DriftEvaluation {
  /** 0.0–1.0 divergence between the historical track and the new instruction. */
  drift_score: number;
  /** Brief ~3-word summary of the prompt's target module. */
  active_focus: string;
  /** Localized pivot vs switch to an uncoupled architectural component. */
  context_relation: "subsystem_pivot" | "disjoint_pivot";
  /** ~3-word summary of the prior session focus (for the intercept UI). */
  prior_focus: string;
}

const DRIFT_SCHEMA = {
  type: "object",
  properties: {
    drift_score: {
      type: "number",
      description:
        "Divergence between the historical context track and the new instruction, 0.0 (same topic) to 1.0 (completely unrelated).",
    },
    active_focus: {
      type: "string",
      description: "Roughly three words naming the new prompt's target module or concern.",
    },
    context_relation: {
      type: "string",
      enum: ["subsystem_pivot", "disjoint_pivot"],
      description:
        "subsystem_pivot when the change stays inside the same project area or touched files; disjoint_pivot when it switches to an entirely uncoupled architectural component or topic.",
    },
    prior_focus: {
      type: "string",
      description: "Roughly three words naming what the previous prompts were focused on.",
    },
  },
  required: ["drift_score", "active_focus", "context_relation", "prior_focus"],
  additionalProperties: false,
} as const;

export interface EvaluationInput {
  prompt: string;
  historyPrompts: string[]; // last 3 user prompts, most recent last
  gitStatus: string; // `git status --porcelain` output
}

export function createEvaluatorClient(apiKey: string): Anthropic {
  return new Anthropic({ apiKey, maxRetries: 1, timeout: 10_000 });
}

export async function evaluateDrift(client: Anthropic, input: EvaluationInput): Promise<DriftEvaluation> {
  const history = input.historyPrompts.length
    ? input.historyPrompts.map((p, i) => `${i + 1}. ${truncate(p, 400)}`).join("\n")
    : "(no prior prompts this session)";
  const git = input.gitStatus ? truncate(input.gitStatus, 800) : "(clean working tree)";

  const response = await client.messages.create({
    model: EVALUATOR_MODEL,
    max_tokens: 256,
    system:
      "You are a topic-drift classifier embedded in a coding session monitor. " +
      "Compare the NEW PROMPT against the RECENT PROMPTS and the uncommitted file changes, " +
      "and rate how far the developer's focus has shifted. Respond only with the JSON object.",
    messages: [
      {
        role: "user",
        content:
          `RECENT PROMPTS (oldest first):\n${history}\n\n` +
          `UNCOMMITTED FILE CHANGES (git status --porcelain):\n${git}\n\n` +
          `NEW PROMPT:\n${truncate(input.prompt, 800)}`,
      },
    ],
    output_config: {
      format: { type: "json_schema", schema: DRIFT_SCHEMA as unknown as Record<string, unknown> },
    },
  });

  const text = response.content.find((b) => b.type === "text");
  if (!text || text.type !== "text") {
    throw new Error("evaluator returned no text block");
  }
  const parsed = JSON.parse(text.text) as DriftEvaluation;
  parsed.drift_score = Math.min(1, Math.max(0, Number(parsed.drift_score) || 0));
  return parsed;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}
