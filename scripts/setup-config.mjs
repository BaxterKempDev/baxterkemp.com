#!/usr/bin/env node
/**
 * Interactive one-time setup for ~/.config/baxterkemp-contributions/config.json
 */

import { createInterface } from "node:readline/promises";
import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stdin as input, stdout as output } from "node:process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SITE_REPO = join(__dirname, "..");
const CONFIG_DIR = join(homedir(), ".config", "baxterkemp-contributions");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

async function pathExists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const rl = createInterface({ input, output });
  let existing = {};
  if (await pathExists(CONFIG_PATH)) {
    try {
      existing = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
      console.log(`Updating existing config at ${CONFIG_PATH}`);
    } catch {
      existing = {};
    }
  }

  const ask = async (label, fallback = "") => {
    const suffix = fallback ? ` [${fallback}]` : "";
    const answer = (await rl.question(`${label}${suffix}: `)).trim();
    return answer || fallback;
  };

  const siteRepo = await ask("Path to baxterkemp.com repo", existing.siteRepo || SITE_REPO);
  const githubUsername = await ask(
    "GitHub username",
    existing.githubUsername || "baxterkempdev",
  );
  const githubToken = await ask(
    "GitHub classic PAT (scope: read:user; optional repo for private contribs). Blank = gh auth token",
    existing.githubToken || "",
  );
  const cursorEmail = await ask("Cursor email", existing.cursorEmail || "");
  const cursorPassword = await ask(
    "Cursor password",
    existing.cursorPassword || "",
  );

  rl.close();

  const config = {
    siteRepo,
    githubUsername,
    githubToken,
    cursorEmail,
    cursorPassword,
    claudeDir: existing.claudeDir || join(homedir(), ".claude"),
  };

  await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", {
    mode: 0o600,
  });
  console.log(`Wrote ${CONFIG_PATH}`);
  console.log("Next: npm install && npx playwright install chromium");
  console.log("Then: npm run install-hook && npm run sync -- --force");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
