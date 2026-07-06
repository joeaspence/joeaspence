# Clif — the Claude Code Context Optimizer

> Stop hitting the Claude Code **"Intelligence Cliff"**.

Clif is a terminal-native, persistent shell wrapper for Claude Code. It spawns the
native `claude` binary as an interactive child process inside a local
pseudoterminal (PTY), sits invisibly in the execution stream, and monitors:

- **active token depth** — a local estimate of how full the context window is,
- **semantic drift** — how far your newest prompt diverges from the session's track,
- **directory/git telemetry** — uncommitted file changes via `git status --porcelain`.

When context turns toxic (past the 40% "intelligence cliff") and your topic
shifts, Clif intercepts the prompt and injects an optimized `/compact` (with a
custom context-preservation payload) or a hard `/clear` — either automatically
(**Autopilot Mode**) or behind a one-keystroke confirmation UI (**Interactive Mode**).

Everything is **100% local-first**: config and session logs live in `~/.clif/`;
no cloud databases, no telemetry endpoints, no external auth.

## Install

```bash
npm install -g clif-cli     # or: git clone … && npm install && npm run build && npm link
```

Requires Node 18+, the `claude` CLI on your PATH, and an `ANTHROPIC_API_KEY`
(env var or `clif config`) for the drift evaluator.

## Commands

| Command | What it does |
|---|---|
| `clif [claude args…]` | Boots the wrapped interactive Claude Code shell. Extra args (e.g. `--model claude-opus-4-6`) are forwarded to `claude` and used to compute the dynamic activation threshold. |
| `clif config` | Interactive prompts: toggle Autopilot, tune the sensitivity threshold and wake-up target with arrow keys, store your API key. |
| `clif stats` | Terminal dashboard: cumulative tokens saved, financial efficiencies, average drift trends. |

## Configuration — `~/.clif/config.json`

```json
{
  "anthropic_api_key": "sk-ant-...",
  "sensitivity_threshold": 0.70,
  "default_target_pct": 0.40,
  "auto_execute": false,
  "currency": "USD"
}
```

- **`sensitivity_threshold`** (0.1–1.0) — strictness of topic-drift filtering; lower = more aggressive interception.
- **`default_target_pct`** — fraction of the context window tolerated before the evaluation engine wakes up (default 0.40 — the 40% intelligence cliff).
- **`auto_execute`** — `false` = Interactive Mode (UI + keystroke confirm); `true` = Autopilot Mode (silent background optimization with a single feedback line).

### Dynamic activation threshold

Computed at boot from the active `--model` flag:

| Model flag | Context window | Wake-up threshold (40%) |
|---|---|---|
| `claude-3-5-sonnet` / older Sonnet | 200,000 | 80,000 |
| `claude-opus-20240229` | 200,000 | 80,000 |
| `claude-opus-4-6` … `claude-opus-4-8`, `claude-fable-5`, `claude-sonnet-5` | 1,000,000 | 400,000 |
| fallback | 200,000 | 80,000 |

## How the pipeline works

1. **FR-01 · PTY interception** — below the threshold every keystroke passes straight through with zero added latency. Every submitted prompt is appended to the local ledger `~/.clif/session_history.jsonl`.
2. **FR-02 · Multi-vector evaluation** — past the threshold, Enter is held for ~300–500ms while the current prompt + last 3 prompts + git status are scored by `claude-haiku-4-5` (schema-enforced JSON: `drift_score`, `active_focus`, `context_relation`). *Note: the original spec named `claude-3-5-haiku`; that model was retired by Anthropic in Feb 2026 — Clif uses its drop-in replacement.*
3. **FR-03 · Decision matrix** — `drift_score ≥ sensitivity_threshold` maps `subsystem_pivot → /compact "<preservation payload>"` and `disjoint_pivot → /clear`.
4. **FR-04 · Execution gate** — Interactive Mode renders the intercept UI (Enter to accept, `1`/`2`/`3` to choose); Autopilot injects the macro silently and prints one high-contrast feedback line.
5. **FR-05 · ROI telemetry** — every optimization logs tokens-before/after, tokens saved, and dollar savings (frontier input pricing) to the ledger, which `clif stats` aggregates.

## Development

```bash
npm install
npm run build      # tsc → dist/
npm test           # Phase-1 serialization + decision-matrix tests (node:test)
```

Layout:

```
src/
  index.ts      CLI entry (clif / clif config / clif stats)
  config.ts     ~/.clif/config.json read/write (Phase 1)
  history.ts    session_history.jsonl append pipeline (Phase 1)
  session.ts    node-pty wrapper + stdin interception (Phases 2 & 4)
  tokens.ts     local context-depth estimator
  git.ts        git status --porcelain telemetry
  evaluator.ts  Haiku drift scoring via @anthropic-ai/sdk (Phase 3)
  decision.ts   autonomous decision matrix + compact payload builder
  ui.ts         ANSI intercept UI / autopilot feedback
  configCmd.ts  interactive config editor
  stats.ts      ROI dashboard
web/index.html  runclif.com single-page landing site
```

### Notes & limitations

- The token count is a **local estimate** (~4 chars/token over PTY traffic, ANSI-stripped). Clif deliberately over-counts slightly so it wakes up early rather than late; `/clear` and `/compact` (yours or Clif's) reset/collapse the estimate.
- If no API key is available, Clif degrades to a transparent passthrough — it never blocks your session.
- Drift evaluation fails open: any evaluator error forwards your prompt untouched.
- Override the wrapped binary with `CLIF_CLAUDE_BIN` (useful for testing).
