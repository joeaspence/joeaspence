/**
 * Phase 1 — Filesystem scaffold.
 *
 * All Clif state lives in ~/.clif/ (100% local-first; no cloud storage,
 * no telemetry endpoints). This module owns the JSON settings manifest at
 * ~/.clif/config.json.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export interface ClifConfig {
  /** BYOK — falls back to the ANTHROPIC_API_KEY environment variable when empty. */
  anthropic_api_key: string;
  /** 0.1–1.0. Drift scores at or above this value trigger an intercept. */
  sensitivity_threshold: number;
  /** Fraction of the model context window tolerated before evaluation wakes up. */
  default_target_pct: number;
  /** false = Interactive Mode (UI + keystroke confirm); true = Autopilot Mode. */
  auto_execute: boolean;
  currency: string;
}

export const DEFAULT_CONFIG: ClifConfig = {
  anthropic_api_key: "",
  sensitivity_threshold: 0.7,
  default_target_pct: 0.4,
  auto_execute: false,
  currency: "USD",
};

export function clifDir(): string {
  return path.join(os.homedir(), ".clif");
}

export function configPath(): string {
  return path.join(clifDir(), "config.json");
}

export function historyPath(): string {
  return path.join(clifDir(), "session_history.jsonl");
}

export function ensureClifDir(): string {
  const dir = clifDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function clampConfig(cfg: ClifConfig): ClifConfig {
  return {
    ...cfg,
    sensitivity_threshold: Math.min(1, Math.max(0.1, Number(cfg.sensitivity_threshold) || DEFAULT_CONFIG.sensitivity_threshold)),
    default_target_pct: Math.min(1, Math.max(0.05, Number(cfg.default_target_pct) || DEFAULT_CONFIG.default_target_pct)),
    auto_execute: Boolean(cfg.auto_execute),
  };
}

/**
 * Reads ~/.clif/config.json, creating it with defaults on first run.
 * Unknown keys are preserved; missing keys are backfilled from defaults.
 */
export function loadConfig(): ClifConfig {
  ensureClifDir();
  const file = configPath();
  if (!fs.existsSync(file)) {
    saveConfig(DEFAULT_CONFIG);
    return { ...DEFAULT_CONFIG };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    return clampConfig({ ...DEFAULT_CONFIG, ...raw });
  } catch {
    // Corrupt manifest: keep a backup, regenerate defaults.
    try {
      fs.copyFileSync(file, `${file}.bak`);
    } catch {
      /* ignore */
    }
    saveConfig(DEFAULT_CONFIG);
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(cfg: ClifConfig): void {
  ensureClifDir();
  const tmp = `${configPath()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, configPath());
}

/** Resolves the API key: config file first, then environment (BYOK). */
export function resolveApiKey(cfg: ClifConfig): string {
  return cfg.anthropic_api_key?.trim() || process.env.ANTHROPIC_API_KEY || "";
}
