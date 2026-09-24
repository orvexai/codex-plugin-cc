#!/usr/bin/env node
// Runs the test suite with a scrubbed environment. When `npm test` is started
// from inside a Claude Code session the plugin's own session variables leak in
// and redirect state directories, which makes otherwise-passing tests fail.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LEAKY_ENV = [
  "CLAUDE_PLUGIN_DATA",
  "CLAUDE_ENV_FILE",
  "CODEX_COMPANION_SESSION_ID",
  "CODEX_COMPANION_TRANSCRIPT_PATH",
  "CODEX_COMPANION_APP_SERVER_ENDPOINT",
  "CODEX_COMPANION_APP_SERVER_PID_FILE",
  "CODEX_COMPANION_APP_SERVER_LOG_FILE",
  "CODEX_COMPANION_CONFIG",
  "CODEX_COMPANION_MODEL",
  "CODEX_COMPANION_EFFORT",
  "CODEX_COMPANION_SANDBOX",
  "CODEX_COMPANION_NETWORK"
];

const env = { ...process.env };
for (const name of LEAKY_ENV) {
  delete env[name];
}
// Keep tests away from the user's real global defaults and launcher.
const sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-plugin-test-home-"));
env.CODEX_COMPANION_CONFIG = path.join(sandboxHome, "config.json");
env.CODEX_COMPANION_BIN_DIR = path.join(sandboxHome, "bin");

const testsDir = path.join(ROOT, "tests");
const requested = process.argv.slice(2);
const files =
  requested.length > 0
    ? requested
    : fs
        .readdirSync(testsDir)
        .filter((name) => name.endsWith(".test.mjs"))
        .sort()
        .map((name) => path.join("tests", name));

const result = spawnSync(process.execPath, ["--test", ...files], { cwd: ROOT, env, stdio: "inherit" });
process.exit(result.status ?? 1);
