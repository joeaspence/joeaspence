#!/usr/bin/env node
/**
 * Clif — the Claude Code context optimizer.
 *
 * Commands:
 *   clif [claude args…]   boot the wrapped interactive Claude Code shell
 *   clif config           interactive settings editor (~/.clif/config.json)
 *   clif stats            local ROI dashboard from session_history.jsonl
 */
import { runConfig } from "./configCmd.js";
import { runStats } from "./stats.js";
import { runSession } from "./session.js";

const HELP = `Clif — stop hitting the Claude Code "intelligence cliff".

Usage:
  clif [claude args…]   Start a monitored Claude Code session (args are
                        forwarded to the claude binary, e.g. --model …)
  clif config           Configure autopilot mode, sensitivity, and API key
  clif stats            Show cumulative tokens/cost saved and drift trends
  clif --help           Show this help

Config lives at ~/.clif/config.json; the session ledger at
~/.clif/session_history.jsonl. Everything is 100% local.
`;

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case "config":
      await runConfig();
      return;
    case "stats":
      runStats();
      return;
    case "--help":
    case "-h":
    case "help":
      process.stdout.write(HELP);
      return;
    default: {
      const args = process.argv.slice(2);
      const code = await runSession(args);
      process.exit(code);
    }
  }
}

main().catch((err) => {
  process.stderr.write(`clif: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
