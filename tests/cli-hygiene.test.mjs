import "./_isolation.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { parseArgs, UsageError } from "../plugins/codex/scripts/lib/args.mjs";
import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "plugins", "codex", "scripts", "codex-companion.mjs");
const SESSION_ENV = [
  "CLAUDE_PLUGIN_DATA",
  "CODEX_COMPANION_SESSION_ID",
  "CODEX_COMPANION_APP_SERVER_ENDPOINT",
  "CODEX_COMPANION_MODEL",
  "CODEX_COMPANION_EFFORT",
  "CODEX_COMPANION_SANDBOX",
  "CODEX_COMPANION_NETWORK"
];

function makeWorkspace(t) {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const home = makeTempDir();
  t.after(() => {
    for (const directory of [repo, binDir, home]) fs.rmSync(directory, { recursive: true, force: true });
  });
  installFakeCodex(binDir, "review-ok");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const env = {
    ...buildEnv(binDir),
    CODEX_COMPANION_CONFIG: path.join(home, "config.json"),
    CODEX_COMPANION_BIN_DIR: path.join(home, "bin")
  };
  for (const name of SESSION_ENV) delete env[name];
  env.CLAUDE_PLUGIN_DATA = path.join(home, "plugin-data");

  return {
    repo,
    home,
    env,
    fakeState: () => {
      const stateFile = path.join(binDir, "fake-codex-state.json");
      return fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, "utf8")) : {};
    },
    jobFiles: () => {
      const stateDir = path.join(env.CLAUDE_PLUGIN_DATA, "state");
      if (!fs.existsSync(stateDir)) return [];
      return fs.readdirSync(stateDir, { recursive: true })
        .filter((entry) => String(entry).includes(`${path.sep}jobs${path.sep}`) || String(entry).startsWith(`jobs${path.sep}`));
    },
    companion: (args) => run("node", [SCRIPT, ...args], { cwd: repo, env })
  };
}

test("parseArgs strict mode rejects unknown options only before the first positional", () => {
  assert.throws(
    () => parseArgs(["--wirte", "x"], { strict: true }),
    (error) => error instanceof UsageError && error.exitCode === 2 && /--wirte/.test(error.message)
  );
  assert.deepEqual(parseArgs(["fix", "the", "--verbose"], { strict: true }), {
    options: {},
    positionals: ["fix", "the", "--verbose"]
  });
  assert.deepEqual(parseArgs(["--name=demo", "x"], { strict: true, valueOptions: ["name"] }), {
    options: { name: "demo" },
    positionals: ["x"]
  });
  assert.deepEqual(parseArgs(["--", "--help"], { strict: true }), {
    options: {},
    positionals: ["--help"]
  });
});

test("each user-facing subcommand prints its own help without starting Codex or creating jobs", (t) => {
  const ws = makeWorkspace(t);
  for (const subcommand of [
    "task", "send", "status", "wait", "cancel", "result", "setup", "review", "adversarial-review", "transfer"
  ]) {
    for (const flag of ["--help", "-h"]) {
      const result = ws.companion([subcommand, flag]);
      assert.equal(result.status, 0, `${subcommand} ${flag}: ${result.stderr}`);
      assert.match(result.stdout, new RegExp(subcommand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.equal(ws.fakeState().appServerStarts ?? 0, 0, `${subcommand} ${flag} started Codex`);
      assert.deepEqual(ws.jobFiles(), [], `${subcommand} ${flag} created job files`);
    }
  }
});

test("help task prints only task usage", (t) => {
  const ws = makeWorkspace(t);
  const result = ws.companion(["help", "task"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage:.*task|node scripts\/codex-companion\.mjs task/);
  assert.doesNotMatch(result.stdout, /codex-companion\.mjs setup/);
});

test("quoted slash-command arguments are normalized before help parsing", (t) => {
  const ws = makeWorkspace(t);
  const result = ws.companion(["status", '"--help"']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /codex-companion\.mjs status/);
  assert.doesNotMatch(result.stdout, /codex-companion\.mjs setup/);
});

test("task rejects an unknown leading option with exit 2 and a usage hint", (t) => {
  const ws = makeWorkspace(t);
  const result = ws.companion(["task", "--wirte", "x"]);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /--wirte/);
  assert.match(result.stderr, /task --help/);
  assert.equal(ws.fakeState().appServerStarts ?? 0, 0);
  assert.deepEqual(ws.jobFiles(), []);
});

test("task -- passes a literal --help prompt to Codex", (t) => {
  const ws = makeWorkspace(t);
  const result = ws.companion(["task", "--", "--help"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(ws.fakeState().lastTurnStart.prompt, "--help");
});

test("unknown dash tokens after the first prompt word remain prompt text", (t) => {
  const ws = makeWorkspace(t);
  const result = ws.companion(["task", "fix", "the", "--verbose", "flag"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(ws.fakeState().lastTurnStart.prompt, "fix the --verbose flag");
});
