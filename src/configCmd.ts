/**
 * `clif config` — interactive CLI prompts to toggle auto_execute, adjust the
 * sensitivity threshold with arrow keys, and store the local API token.
 */
import readline from "node:readline";
import { loadConfig, saveConfig, configPath, type ClifConfig } from "./config.js";

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const CYAN = "\x1b[36m";
const RESET = "\x1b[0m";

/** Arrow-key selector rendered on a single refreshing block. */
function select(title: string, options: string[], initial: number): Promise<number> {
  return new Promise((resolve) => {
    let index = Math.max(0, Math.min(options.length - 1, initial));
    const stdin = process.stdin;
    const render = (first = false) => {
      if (!first) process.stdout.write(`\x1b[${options.length}A`);
      for (let i = 0; i < options.length; i++) {
        const marker = i === index ? `${GREEN}❯${RESET} ${BOLD}` : "  ";
        process.stdout.write(`\x1b[2K${marker}${options[i]}${RESET}\n`);
      }
    };
    process.stdout.write(`${BOLD}${title}${RESET} ${DIM}(↑/↓ then Enter)${RESET}\n`);
    render(true);
    const wasRaw = stdin.isTTY ? stdin.isRaw : false;
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    const onKey = (chunk: Buffer) => {
      const key = chunk.toString("utf8");
      if (key === "\x1b[A" || key === "k") index = (index - 1 + options.length) % options.length;
      else if (key === "\x1b[B" || key === "j") index = (index + 1) % options.length;
      else if (key === "\r" || key === "\n") {
        stdin.off("data", onKey);
        if (stdin.isTTY) stdin.setRawMode(wasRaw);
        resolve(index);
        return;
      } else if (key === "\x03") {
        process.stdout.write("\n");
        process.exit(130);
      }
      render();
    };
    stdin.on("data", onKey);
  });
}

/** Arrow-key numeric slider for the sensitivity threshold. */
function slider(title: string, value: number, min: number, max: number, step: number): Promise<number> {
  return new Promise((resolve) => {
    let v = value;
    const stdin = process.stdin;
    const render = () => {
      const span = max - min;
      const filled = Math.round(((v - min) / span) * 30);
      const bar = `${"█".repeat(filled)}${"░".repeat(30 - filled)}`;
      process.stdout.write(`\r\x1b[2K${BOLD}${title}${RESET} ${CYAN}${bar}${RESET} ${BOLD}${v.toFixed(2)}${RESET} ${DIM}(←/→ then Enter)${RESET}`);
    };
    render();
    const wasRaw = stdin.isTTY ? stdin.isRaw : false;
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    const onKey = (chunk: Buffer) => {
      const key = chunk.toString("utf8");
      if (key === "\x1b[C") v = Math.min(max, Math.round((v + step) * 100) / 100);
      else if (key === "\x1b[D") v = Math.max(min, Math.round((v - step) * 100) / 100);
      else if (key === "\r" || key === "\n") {
        stdin.off("data", onKey);
        if (stdin.isTTY) stdin.setRawMode(wasRaw);
        process.stdout.write("\n");
        resolve(v);
        return;
      } else if (key === "\x03") {
        process.stdout.write("\n");
        process.exit(130);
      }
      render();
    };
    stdin.on("data", onKey);
  });
}

function question(prompt: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) =>
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer);
    }),
  );
}

export async function runConfig(): Promise<void> {
  const cfg: ClifConfig = loadConfig();
  process.stdout.write(`${BOLD}Clif configuration${RESET} ${DIM}(${configPath()})${RESET}\n\n`);

  const modeIdx = await select(
    "Execution mode",
    [
      "Interactive Mode — intercept, show UI, wait for keystroke confirmation",
      "Autopilot Mode — silently execute optimizations in the background",
    ],
    cfg.auto_execute ? 1 : 0,
  );
  cfg.auto_execute = modeIdx === 1;

  cfg.sensitivity_threshold = await slider("Sensitivity threshold", cfg.sensitivity_threshold, 0.1, 1.0, 0.05);
  cfg.default_target_pct = await slider("Context wake-up target", cfg.default_target_pct, 0.1, 0.9, 0.05);

  const masked = cfg.anthropic_api_key ? `${cfg.anthropic_api_key.slice(0, 12)}…` : process.env.ANTHROPIC_API_KEY ? "(using ANTHROPIC_API_KEY env)" : "(not set)";
  const key = await question(`${BOLD}Anthropic API key${RESET} ${DIM}[${masked}] — Enter to keep:${RESET} `);
  if (key.trim()) cfg.anthropic_api_key = key.trim();

  saveConfig(cfg);
  process.stdout.write(`\n${GREEN}✓ Saved${RESET} ${DIM}${configPath()}${RESET}\n`);
  process.stdout.write(
    `  auto_execute=${cfg.auto_execute}  sensitivity_threshold=${cfg.sensitivity_threshold}  default_target_pct=${cfg.default_target_pct}\n`,
  );
}
