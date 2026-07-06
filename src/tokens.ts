/**
 * Phase 2 — Active token-depth tracker.
 *
 * Clif sits outside the Claude Code process, so it cannot read the model's
 * true context count. It maintains a conservative local estimate:
 *   - every byte flowing through the PTY (input and output) approximates
 *     conversation content at ~4 characters per token;
 *   - /clear resets the estimate;
 *   - /compact collapses it to a small summary residue.
 *
 * The estimate only needs to be good enough to decide when the evaluation
 * engine should wake up (the 40% "intelligence cliff" threshold).
 */

const CHARS_PER_TOKEN = 4;
/** Fraction of context assumed to survive a /compact as the summary. */
const COMPACT_RESIDUE = 0.1;

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)/g;

export class TokenTracker {
  private chars = 0;

  /** Feed user-typed prompt text. */
  addInput(text: string): void {
    this.chars += text.length;
  }

  /**
   * Feed raw PTY output. ANSI escape sequences are stripped so cursor
   * movement and colour codes don't inflate the estimate; interactive
   * redraws still overcount somewhat, which keeps the estimate conservative
   * (Clif wakes up earlier rather than later).
   */
  addOutput(raw: string): void {
    this.chars += raw.replace(ANSI_RE, "").length;
  }

  get estimatedTokens(): number {
    return Math.round(this.chars / CHARS_PER_TOKEN);
  }

  /** /clear — hard reset. */
  reset(): void {
    this.chars = 0;
  }

  /** /compact — collapse to summary residue; returns tokens saved. */
  compact(): number {
    const before = this.estimatedTokens;
    this.chars = Math.round(this.chars * COMPACT_RESIDUE);
    return before - this.estimatedTokens;
  }
}
