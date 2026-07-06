/**
 * Phase 1 validation — config.json serialization round-trip and the
 * session_history.jsonl append pipeline — plus the pure decision logic.
 * Runs against the compiled dist/ output with HOME pointed at a temp dir.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "clif-test-"));

const { loadConfig, saveConfig, configPath, DEFAULT_CONFIG, resolveApiKey } = await import("../dist/config.js");
const { appendEvent, readEvents, recentPrompts } = await import("../dist/history.js");
const { contextWindowFor, activationThreshold, inputCostUsd } = await import("../dist/models.js");
const { decide, buildCompactPayload } = await import("../dist/decision.js");
const { TokenTracker } = await import("../dist/tokens.js");

test("config: first load creates defaults on disk", () => {
  const cfg = loadConfig();
  assert.deepEqual(cfg, DEFAULT_CONFIG);
  assert.ok(fs.existsSync(configPath()));
});

test("config: round-trips writes and clamps out-of-range values", () => {
  saveConfig({ ...DEFAULT_CONFIG, sensitivity_threshold: 5, auto_execute: true, anthropic_api_key: "sk-ant-test" });
  const cfg = loadConfig();
  assert.equal(cfg.sensitivity_threshold, 1); // clamped to max
  assert.equal(cfg.auto_execute, true);
  assert.equal(resolveApiKey(cfg), "sk-ant-test");
  saveConfig(DEFAULT_CONFIG);
});

test("config: corrupt manifest regenerates defaults and keeps a backup", () => {
  fs.writeFileSync(configPath(), "{not json");
  const cfg = loadConfig();
  assert.deepEqual(cfg, DEFAULT_CONFIG);
  assert.ok(fs.existsSync(`${configPath()}.bak`));
});

test("history: append pipeline writes JSONL and reads it back in order", () => {
  const mk = (i) => ({
    type: "prompt",
    ts: new Date().toISOString(),
    session_id: "s1",
    prompt: `prompt ${i}`,
    estimated_context_tokens: i * 100,
  });
  for (let i = 1; i <= 5; i++) appendEvent(mk(i));
  const events = readEvents().filter((e) => e.type === "prompt");
  assert.equal(events.length, 5);
  assert.equal(events[4].prompt, "prompt 5");
  assert.deepEqual(recentPrompts("s1", 3), ["prompt 3", "prompt 4", "prompt 5"]);
});

test("models: dynamic activation thresholds match the PRD table", () => {
  assert.equal(activationThreshold("claude-3-5-sonnet", 0.4), 80_000);
  assert.equal(activationThreshold("claude-opus-20240229", 0.4), 80_000);
  assert.equal(activationThreshold("claude-opus-4-6", 0.4), 400_000);
  assert.equal(activationThreshold("claude-fable-5", 0.4), 400_000);
  assert.equal(activationThreshold(undefined, 0.4), 80_000); // fallback
  assert.equal(contextWindowFor("unknown-model"), 200_000);
});

test("decision matrix: subsystem pivot compacts, disjoint pivot clears, low drift passes", () => {
  const base = { drift_score: 0.8, active_focus: "stripe webhooks", context_relation: "subsystem_pivot", prior_focus: "react views" };
  const compact = decide(base, 0.7, " M src/webhooks.ts");
  assert.equal(compact.recommended_action, "compact");
  assert.match(compact.command, /^\/compact /);
  assert.match(compact.command, /stripe webhooks/);
  assert.match(compact.command, /src\/webhooks\.ts/);

  const clear = decide({ ...base, context_relation: "disjoint_pivot" }, 0.7, "");
  assert.equal(clear.recommended_action, "clear");
  assert.equal(clear.command, "/clear");

  const none = decide({ ...base, drift_score: 0.3 }, 0.7, "");
  assert.equal(none.recommended_action, "none");
  assert.equal(none.command, null);
});

test("tokens: tracker estimates, compacts, and resets", () => {
  const t = new TokenTracker();
  t.addInput("x".repeat(4000));
  assert.equal(t.estimatedTokens, 1000);
  t.addOutput("\x1b[31mred\x1b[0m"); // ANSI stripped: only "red" counts
  assert.equal(t.estimatedTokens, 1001);
  const saved = t.compact();
  assert.ok(saved > 800);
  t.reset();
  assert.equal(t.estimatedTokens, 0);
});

test("pricing: ROI math uses per-model input pricing", () => {
  assert.equal(inputCostUsd(1_000_000, "claude-opus-4-6"), 5);
  assert.equal(inputCostUsd(1_000_000, "claude-haiku-4-5"), 1);
  assert.equal(inputCostUsd(500_000, "claude-sonnet-5"), 1.5);
});

test("compact payload preserves active file parameters", () => {
  const payload = buildCompactPayload(
    { drift_score: 0.9, active_focus: "database migration logic", context_relation: "subsystem_pivot", prior_focus: "frontend" },
    " M prisma/schema.prisma\n?? src/db/migrate.ts",
  );
  assert.match(payload, /database migration logic/);
  assert.match(payload, /prisma\/schema\.prisma/);
  assert.match(payload, /src\/db\/migrate\.ts/);
});
