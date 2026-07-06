/**
 * Dynamic activation threshold (PRD §3).
 *
 * The wake-up threshold is computed at shell boot from the active model flag:
 *   threshold = context_window * default_target_pct   (default 0.40)
 */

interface ModelWindowRule {
  match: RegExp;
  window: number;
}

const FALLBACK_WINDOW = 200_000;

// Ordered: first match wins.
const MODEL_WINDOW_RULES: ModelWindowRule[] = [
  // 1M-context frontier models
  { match: /fable-5|mythos-5/i, window: 1_000_000 },
  { match: /opus-4-[678]/i, window: 1_000_000 },
  { match: /sonnet-5(?!\d)/i, window: 1_000_000 },
  { match: /sonnet-4-6/i, window: 1_000_000 },
  // 200K-context models
  { match: /claude-3-5-sonnet|claude-sonnet/i, window: 200_000 },
  { match: /opus-20240229|claude-3-opus/i, window: 200_000 },
  { match: /haiku/i, window: 200_000 },
];

/** Resolves the max context window for a model flag string. */
export function contextWindowFor(modelFlag: string | undefined): number {
  if (!modelFlag) return FALLBACK_WINDOW;
  for (const rule of MODEL_WINDOW_RULES) {
    if (rule.match.test(modelFlag)) return rule.window;
  }
  return FALLBACK_WINDOW;
}

/** Evaluation wake-up threshold in tokens. */
export function activationThreshold(modelFlag: string | undefined, targetPct: number): number {
  return Math.floor(contextWindowFor(modelFlag) * targetPct);
}

/**
 * Standard frontier input-model pricing, USD per million input tokens
 * (used for local ROI telemetry only — FR-05).
 */
const INPUT_PRICE_PER_MTOK: Array<{ match: RegExp; usd: number }> = [
  { match: /fable-5|mythos-5/i, usd: 10 },
  { match: /opus/i, usd: 5 },
  { match: /sonnet/i, usd: 3 },
  { match: /haiku/i, usd: 1 },
];

export function inputPricePerMTok(modelFlag: string | undefined): number {
  if (modelFlag) {
    for (const rule of INPUT_PRICE_PER_MTOK) {
      if (rule.match.test(modelFlag)) return rule.usd;
    }
  }
  return 5; // Opus-tier fallback
}

/** Dollar cost of feeding `tokens` input tokens once to the given model. */
export function inputCostUsd(tokens: number, modelFlag: string | undefined): number {
  return (tokens / 1_000_000) * inputPricePerMTok(modelFlag);
}
