#!/usr/bin/env node
/**
 * Installs a global git pre-push hook that backgrounds contribution sync.
 * Never blocks or fails the user's real push.
 */

import { chmod, mkdir, readFile, writeFile, access } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SITE_REPO = join(__dirname, "..");
const SYNC_SCRIPT = join(SITE_REPO, "scripts", "sync-contributions.mjs");
const CONFIG_DIR = join(homedir(), ".config", "baxterkemp-contributions");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");
const HOOKS_DIR = join(homedir(), ".git-hooks");
const HOOK_PATH = join(HOOKS_DIR, "pre-push");
const CHAIN_PATH = join(HOOKS_DIR, "pre-push.user");

async function pathExists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

function gitConfig(key) {
  const result = spawnSync("git", ["config", "--global", "--get", key], {
    encoding: "utf8",
  });
  if (result.status !== 0) return "";
  return result.stdout.trim();
}

function gitConfigSet(key, value) {
  const result = spawnSync("git", ["config", "--global", key, value], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(
      `Failed to set git config ${key}: ${(result.stderr || "").trim()}`,
    );
  }
}

async function ensureSiteRepoInConfig() {
  let config = {};
  if (await pathExists(CONFIG_PATH)) {
    try {
      config = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
    } catch {
      config = {};
    }
  }
  config.siteRepo = config.siteRepo || SITE_REPO;
  await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", {
    mode: 0o600,
  });
  return config.siteRepo;
}

async function main() {
  await mkdir(HOOKS_DIR, { recursive: true });
  await ensureSiteRepoInConfig();

  const existingHooksPath = gitConfig("core.hooksPath");
  if (existingHooksPath && existingHooksPath !== HOOKS_DIR) {
    console.warn(
      `Warning: core.hooksPath is already set to "${existingHooksPath}".`,
    );
    console.warn(`This installer will point it to "${HOOKS_DIR}".`);
    console.warn(
      "Move any existing hooks into that directory (or rely on pre-push.user chaining).",
    );
  }

  // Preserve a previously installed non-managed pre-push once
  if (await pathExists(HOOK_PATH)) {
    const current = await readFile(HOOK_PATH, "utf8");
    if (!current.includes("baxterkemp-contributions") && !(await pathExists(CHAIN_PATH))) {
      await writeFile(CHAIN_PATH, current, { mode: 0o755 });
      await chmod(CHAIN_PATH, 0o755);
      console.log(`Preserved existing pre-push as ${CHAIN_PATH}`);
    }
  }

  const hook = `#!/bin/sh
# baxterkemp-contributions — background sync; never blocks push
set -e

CHAIN="${CHAIN_PATH}"
if [ -x "$CHAIN" ]; then
  "$CHAIN" "$@" || true
fi

SYNC="${SYNC_SCRIPT}"
LOG_DIR="${CONFIG_DIR}"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/sync.log"

if [ -f "$SYNC" ]; then
  # Detach so the user's push is never delayed or failed by sync
  (
    /usr/bin/env node "$SYNC" >>"$LOG" 2>&1 || true
  ) >/dev/null 2>&1 &
fi

exit 0
`;

  await writeFile(HOOK_PATH, hook, { mode: 0o755 });
  await chmod(HOOK_PATH, 0o755);
  gitConfigSet("core.hooksPath", HOOKS_DIR);

  console.log(`Installed ${HOOK_PATH}`);
  console.log(`Set git core.hooksPath = ${HOOKS_DIR}`);
  console.log(`Sync script: ${SYNC_SCRIPT}`);
  console.log("Logs: ~/.config/baxterkemp-contributions/sync.log");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
