import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

export const CLI_SHIM_NAME = "orvex-codex";
const CLI_SHIM_MARKER = "# orvex-codex shim";

export function resolveDefaultBinDir() {
  return process.env.CODEX_COMPANION_BIN_DIR || path.join(os.homedir(), ".local", "bin");
}

export function resolveCliShimPath(binDir = resolveDefaultBinDir()) {
  return path.join(binDir, CLI_SHIM_NAME);
}

function buildShimSource(pluginRoot) {
  const script = path.join(pluginRoot, "scripts", "codex-companion.mjs");
  return [
    "#!/bin/sh",
    `${CLI_SHIM_MARKER}: stable entry point for the Codex companion runtime.`,
    "# Rewritten by /codex:setup --install-cli and refreshed at session start after plugin upgrades.",
    `exec node ${JSON.stringify(script)} "$@"`,
    ""
  ].join("\n");
}

function isOurShim(contents) {
  return contents.includes(CLI_SHIM_MARKER);
}

// Installs a stable `orvex-codex` launcher so permission rules and scripts do
// not have to name the version-specific plugin cache path.
export function installCliShim(pluginRoot, binDir = resolveDefaultBinDir()) {
  const target = resolveCliShimPath(binDir);
  if (fs.existsSync(target) && !isOurShim(fs.readFileSync(target, "utf8"))) {
    throw new Error(`Refusing to overwrite ${target}: it was not created by this plugin.`);
  }
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(target, buildShimSource(pluginRoot), { encoding: "utf8", mode: 0o755 });
  fs.chmodSync(target, 0o755);
  return target;
}

// Re-points an existing shim at the running plugin version. Never creates one.
export function refreshCliShim(pluginRoot, binDir = resolveDefaultBinDir()) {
  const target = resolveCliShimPath(binDir);
  if (!fs.existsSync(target)) {
    return null;
  }
  const contents = fs.readFileSync(target, "utf8");
  const next = buildShimSource(pluginRoot);
  if (!isOurShim(contents) || contents === next) {
    return null;
  }
  fs.writeFileSync(target, next, { encoding: "utf8", mode: 0o755 });
  return target;
}

export function describeCliShim(pluginRoot, binDir = resolveDefaultBinDir()) {
  const target = resolveCliShimPath(binDir);
  if (!fs.existsSync(target)) {
    return null;
  }
  const contents = fs.readFileSync(target, "utf8");
  if (!isOurShim(contents)) {
    return `${target} exists but was not created by this plugin`;
  }
  return contents === buildShimSource(pluginRoot) ? `${target} (current)` : `${target} (points at another plugin version)`;
}
