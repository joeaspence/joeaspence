/**
 * Phase 2 — Directory/git telemetry.
 * Fetches uncommitted repository file changes via `git status --porcelain`.
 */
import { execFile } from "node:child_process";

export function gitStatusPorcelain(cwd: string): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["status", "--porcelain"],
      { cwd, timeout: 2000, maxBuffer: 256 * 1024 },
      (err, stdout) => resolve(err ? "" : stdout.trim()),
    );
  });
}
