#!/usr/bin/env node
/**
 * Local contribution sync — GitHub + Claude Code (~/.claude) + Cursor (Playwright).
 * Secrets live in ~/.config/baxterkemp-contributions/ — never written to the public JSON.
 *
 * Usage:
 *   node scripts/sync-contributions.mjs
 *   node scripts/sync-contributions.mjs --force
 */

import { spawnSync } from "node:child_process";
import {
  access,
  mkdir,
  readFile,
  readdir,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SITE_REPO = join(__dirname, "..");
const OUT_PATH = join(SITE_REPO, "data", "contributions.json");
const CONFIG_DIR = join(homedir(), ".config", "baxterkemp-contributions");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");
const STORAGE_PATH = join(CONFIG_DIR, "storageState.json");
const LAST_SYNC_PATH = join(CONFIG_DIR, "last-sync");
const LOCK_PATH = join(CONFIG_DIR, "sync.lock");
const DEBOUNCE_MS = 60 * 60 * 1000;
const FORCE = process.argv.includes("--force");

function utcDateString(d) {
  return d.toISOString().slice(0, 10);
}

function startOfUtcDay(d) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function daysAgoUtc(n) {
  const d = startOfUtcDay(new Date());
  d.setUTCDate(d.getUTCDate() - n);
  return d;
}

function emptyDayMap(from, to) {
  const map = new Map();
  const cur = new Date(from);
  while (cur <= to) {
    map.set(utcDateString(cur), { github: 0, cursor: 0, claude: 0 });
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return map;
}

async function pathExists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function loadConfig() {
  if (!(await pathExists(CONFIG_PATH))) {
    throw new Error(
      `Missing config at ${CONFIG_PATH}. Run: npm run setup`,
    );
  }
  const raw = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
  return {
    siteRepo: raw.siteRepo || SITE_REPO,
    githubUsername: raw.githubUsername || "baxterkempdev",
    githubToken: raw.githubToken || "",
    cursorEmail: raw.cursorEmail || "",
    cursorPassword: raw.cursorPassword || "",
    claudeDir: raw.claudeDir || join(homedir(), ".claude"),
  };
}

async function resolveGithubToken(config) {
  if (config.githubToken) return config.githubToken;
  const fromEnv = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (fromEnv) return fromEnv;
  const result = spawnSync("gh", ["auth", "token"], { encoding: "utf8" });
  if (result.status === 0 && result.stdout.trim()) return result.stdout.trim();
  return "";
}

async function shouldSkipDebounce() {
  if (FORCE) return false;
  if (!(await pathExists(LAST_SYNC_PATH))) return false;
  const raw = (await readFile(LAST_SYNC_PATH, "utf8")).trim();
  const ts = Date.parse(raw);
  if (!Number.isFinite(ts)) return false;
  return Date.now() - ts < DEBOUNCE_MS;
}

async function acquireLock() {
  await mkdir(CONFIG_DIR, { recursive: true });
  if (await pathExists(LOCK_PATH)) {
    const raw = (await readFile(LOCK_PATH, "utf8")).trim();
    const ts = Date.parse(raw);
    // Stale lock older than 30 minutes — take over
    if (Number.isFinite(ts) && Date.now() - ts < 30 * 60 * 1000) {
      return false;
    }
  }
  await writeFile(LOCK_PATH, new Date().toISOString() + "\n");
  return true;
}

async function releaseLock() {
  try {
    await unlink(LOCK_PATH);
  } catch {
    // ignore
  }
}

async function markSynced() {
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(LAST_SYNC_PATH, new Date().toISOString() + "\n");
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const detail =
      typeof body === "string" ? body.slice(0, 300) : JSON.stringify(body)?.slice(0, 300);
    throw new Error(`${options.method || "GET"} ${url} → ${res.status}: ${detail}`);
  }
  return body;
}

async function fetchGitHub(from, to, token, username) {
  if (!token) {
    console.warn("GitHub token missing — skipping GitHub");
    return { ok: false, byDay: {} };
  }

  const query = `
    query($login: String!, $from: DateTime!, $to: DateTime!) {
      user(login: $login) {
        contributionsCollection(from: $from, to: $to) {
          contributionCalendar {
            weeks {
              contributionDays {
                date
                contributionCount
              }
            }
          }
        }
      }
    }
  `;

  const data = await fetchJson("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "baxterkemp.com-contributions",
    },
    body: JSON.stringify({
      query,
      variables: {
        login: username,
        from: from.toISOString(),
        to: to.toISOString(),
      },
    }),
  });

  if (data.errors?.length) {
    throw new Error(`GitHub GraphQL: ${data.errors.map((e) => e.message).join("; ")}`);
  }

  const weeks =
    data?.data?.user?.contributionsCollection?.contributionCalendar?.weeks ?? [];
  const byDay = {};
  for (const week of weeks) {
    for (const day of week.contributionDays ?? []) {
      byDay[day.date] = day.contributionCount ?? 0;
    }
  }
  return { ok: true, byDay };
}

async function walkJsonlFiles(dir, out = []) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await walkJsonlFiles(full, out);
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) out.push(full);
  }
  return out;
}

async function fetchClaude(from, to, claudeDir) {
  const byDay = {};
  const fromKey = utcDateString(from);
  const toKey = utcDateString(to);

  const statsPath = join(claudeDir, "stats-cache.json");
  if (await pathExists(statsPath)) {
    try {
      const stats = JSON.parse(await readFile(statsPath, "utf8"));
      for (const row of stats.dailyActivity ?? []) {
        if (!row?.date || row.date < fromKey || row.date > toKey) continue;
        const sessions = Number(row.sessionCount) || 0;
        const messages = Number(row.messageCount) || 0;
        byDay[row.date] = Math.max(
          byDay[row.date] ?? 0,
          sessions > 0 ? sessions : messages > 0 ? 1 : 0,
        );
      }
    } catch (err) {
      console.warn("Claude stats-cache parse failed:", err.message);
    }
  }

  const historyPath = join(claudeDir, "history.jsonl");
  if (await pathExists(historyPath)) {
    try {
      const promptsByDay = {};
      const text = await readFile(historyPath, "utf8");
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        let row;
        try {
          row = JSON.parse(line);
        } catch {
          continue;
        }
        const ts = Number(row.timestamp);
        if (!Number.isFinite(ts)) continue;
        const date = utcDateString(new Date(ts));
        if (date < fromKey || date > toKey) continue;
        promptsByDay[date] = (promptsByDay[date] ?? 0) + 1;
      }
      for (const [date, count] of Object.entries(promptsByDay)) {
        // Prefer richer of session-based stats vs prompt counts (no double-count)
        byDay[date] = Math.max(byDay[date] ?? 0, count);
      }
    } catch (err) {
      console.warn("Claude history.jsonl parse failed:", err.message);
    }
  }

  // Session files as a light supplement (file mtime → 1 if day empty)
  const projectsDir = join(claudeDir, "projects");
  if (await pathExists(projectsDir)) {
    const files = await walkJsonlFiles(projectsDir);
    for (const file of files) {
      try {
        const st = await stat(file);
        const date = utcDateString(st.mtime);
        if (date < fromKey || date > toKey) continue;
        if (!byDay[date]) byDay[date] = 1;
      } catch {
        // ignore
      }
    }
  }

  const ok = Object.keys(byDay).length > 0 || (await pathExists(claudeDir));
  return { ok, byDay };
}

function cookieHeaderFromStorage(storage) {
  const cookies = storage?.cookies ?? [];
  return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

function hasCursorSession(storage) {
  return (storage?.cookies ?? []).some(
    (c) => c.name === "WorkosCursorSessionToken" && c.value,
  );
}

async function cursorSessionValid(storage) {
  if (!hasCursorSession(storage)) return false;
  const cookie = cookieHeaderFromStorage(storage);
  try {
    const res = await fetch("https://cursor.com/api/auth/me", {
      headers: {
        Cookie: cookie,
        Origin: "https://cursor.com",
      },
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function launchBrowserForLogin() {
  // Prefer real Chrome + headed window — headless is often blocked by Cursor/WorkOS.
  const attempts = [
    { channel: "chrome", headless: false },
    { channel: "chrome", headless: true },
    { headless: false },
    { headless: true },
  ];
  let lastErr;
  for (const opts of attempts) {
    try {
      return await chromium.launch({
        ...opts,
        args: ["--disable-blink-features=AutomationControlled"],
      });
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error("Could not launch Chromium/Chrome");
}

async function loginCursorWithPlaywright(email, password) {
  if (!email || !password) {
    throw new Error("cursorEmail / cursorPassword missing in config");
  }

  console.log("Cursor session missing/expired — logging in with Playwright…");
  const browser = await launchBrowserForLogin();
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    locale: "en-US",
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });
  const page = await context.newPage();

  try {
    await page.goto("https://cursor.com/api/auth/login", {
      waitUntil: "domcontentloaded",
      timeout: 90_000,
    });
    // Auth redirects to authenticator.cursor.sh; give the SPA time to hydrate
    await page.waitForTimeout(3000);
    await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});

    const emailSelectors = [
      'input[type="email"]',
      'input[name="email"]',
      'input[autocomplete="email"]',
      'input[placeholder*="email" i]',
      'input[inputmode="email"]',
    ];

    let emailInput = null;
    for (const sel of emailSelectors) {
      const loc = page.locator(sel).first();
      if (await loc.count()) {
        try {
          await loc.waitFor({ state: "visible", timeout: 5_000 });
          emailInput = loc;
          break;
        } catch {
          // try next
        }
      }
    }

    if (!emailInput) {
      // Sometimes the field is only labeled, not typed as email
      const byLabel = page.getByLabel(/email/i).first();
      if (await byLabel.count()) {
        emailInput = byLabel;
      }
    }

    if (!emailInput) {
      await mkdir(CONFIG_DIR, { recursive: true });
      await page.screenshot({
        path: join(CONFIG_DIR, "login-debug.png"),
        fullPage: true,
      });
      throw new Error(
        `Could not find email field on ${page.url()}. Screenshot: ${join(CONFIG_DIR, "login-debug.png")}`,
      );
    }

    await emailInput.click();
    await emailInput.fill(email);

    const continueBtn = page.getByRole("button", {
      name: /continue|next|sign in/i,
    }).first();
    if (await continueBtn.count()) {
      await continueBtn.click();
    } else {
      await emailInput.press("Enter");
    }

    const passwordInput = page.locator(
      'input[type="password"], input[name="password"], input[autocomplete="current-password"]',
    ).first();
    await passwordInput.waitFor({ state: "visible", timeout: 45_000 });
    await passwordInput.fill(password);

    const submit = page.getByRole("button", {
      name: /sign in|log in|continue|submit/i,
    }).first();
    if (await submit.count()) {
      await submit.click();
    } else {
      await passwordInput.press("Enter");
    }

    // Wait for redirect back to cursor.com OR session cookie
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      const storage = await context.storageState();
      if (hasCursorSession(storage)) break;
      if (/cursor\.com/i.test(page.url()) && !/authenticator/i.test(page.url())) {
        await page.waitForTimeout(1500);
        break;
      }
      await page.waitForTimeout(1000);
    }

    let finalStorage = await context.storageState();
    if (!hasCursorSession(finalStorage)) {
      await page.goto("https://cursor.com/dashboard", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      await page.waitForTimeout(3000);
      finalStorage = await context.storageState();
    }

    if (!hasCursorSession(finalStorage)) {
      await mkdir(CONFIG_DIR, { recursive: true });
      await page.screenshot({
        path: join(CONFIG_DIR, "login-debug.png"),
        fullPage: true,
      });
      throw new Error(
        "Login finished but WorkosCursorSessionToken cookie was not set. " +
          `URL=${page.url()} Screenshot: ${join(CONFIG_DIR, "login-debug.png")}`,
      );
    }

    await mkdir(CONFIG_DIR, { recursive: true });
    await writeFile(STORAGE_PATH, JSON.stringify(finalStorage, null, 2) + "\n");
    console.log("Cursor login succeeded; session saved");
    return finalStorage;
  } finally {
    await browser.close();
  }
}

async function loadOrRefreshCursorStorage(config) {
  let storage = null;
  if (await pathExists(STORAGE_PATH)) {
    try {
      storage = JSON.parse(await readFile(STORAGE_PATH, "utf8"));
    } catch {
      storage = null;
    }
  }

  if (storage && (await cursorSessionValid(storage))) {
    return storage;
  }

  return loginCursorWithPlaywright(config.cursorEmail, config.cursorPassword);
}

async function fetchCursorUsage(from, to, storage) {
  const cookie = cookieHeaderFromStorage(storage);
  const byDay = {};
  let page = 1;
  const pageSize = 1000;
  const startDate = from.getTime();
  const endDate = to.getTime();

  for (;;) {
    const data = await fetchJson(
      "https://cursor.com/api/dashboard/get-filtered-usage-events",
      {
        method: "POST",
        headers: {
          Cookie: cookie,
          "Content-Type": "application/json",
          Origin: "https://cursor.com",
        },
        body: JSON.stringify({ startDate, endDate, page, pageSize }),
      },
    );

    const events = data.usageEventsDisplay ?? data.usageEvents ?? [];
    for (const event of events) {
      const ts = Number(event.timestamp ?? event.createdAt ?? event.time);
      if (!Number.isFinite(ts)) continue;
      const date = utcDateString(new Date(ts));
      byDay[date] = (byDay[date] ?? 0) + 1;
    }

    const total = data.totalUsageEventsCount ?? events.length;
    if (events.length < pageSize || page * pageSize >= total) break;
    page += 1;
    if (page > 200) break;
  }

  return { ok: true, byDay };
}

async function fetchCursor(from, to, config) {
  if (!config.cursorEmail || !config.cursorPassword) {
    console.warn("Cursor credentials missing — skipping Cursor");
    return { ok: false, byDay: {} };
  }
  const storage = await loadOrRefreshCursorStorage(config);
  return fetchCursorUsage(from, to, storage);
}

function mergeLevels(days) {
  const totals = days.map((d) => d.total).filter((t) => t > 0);
  if (!totals.length) return days.map((d) => ({ ...d, level: 0 }));

  const sorted = [...totals].sort((a, b) => a - b);
  const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  const t1 = q(0.25);
  const t2 = q(0.5);
  const t3 = q(0.75);

  return days.map((d) => {
    let level = 0;
    if (d.total > 0) level = 1;
    if (d.total > t1) level = 2;
    if (d.total > t2) level = 3;
    if (d.total > t3) level = 4;
    return { ...d, level };
  });
}

async function loadPrevious() {
  if (!(await pathExists(OUT_PATH))) return null;
  try {
    return JSON.parse(await readFile(OUT_PATH, "utf8"));
  } catch {
    return null;
  }
}

function previousBySource(prev, source) {
  const map = {};
  for (const day of prev?.days ?? []) {
    map[day.date] = Number(day[source]) || 0;
  }
  return map;
}

function git(args, cwd) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${(result.stderr || result.stdout || "").trim()}`,
    );
  }
  return result.stdout.trim();
}

async function commitAndPushIfChanged(siteRepo) {
  git(["add", "data/contributions.json"], siteRepo);
  const staged = spawnSync("git", ["diff", "--staged", "--quiet"], {
    cwd: siteRepo,
  });
  if (staged.status === 0) {
    console.log("No contribution data changes to commit");
    return false;
  }

  git(
    [
      "commit",
      "-m",
      "chore: refresh contribution graph data",
    ],
    siteRepo,
  );

  const push = spawnSync("git", ["push"], { cwd: siteRepo, encoding: "utf8" });
  if (push.status !== 0) {
    console.warn(
      "Committed locally but push failed:",
      (push.stderr || push.stdout || "").trim(),
    );
    return true;
  }
  console.log("Pushed updated contributions.json");
  return true;
}

async function main() {
  if (await shouldSkipDebounce()) {
    console.log("Skipping sync (debounced; use --force to override)");
    return;
  }

  if (!(await acquireLock())) {
    console.log("Skipping sync (another sync is already running)");
    return;
  }

  try {
    await runSync();
  } finally {
    await releaseLock();
  }
}

async function runSync() {
  const config = await loadConfig();
  const siteRepo = config.siteRepo || SITE_REPO;
  const to = startOfUtcDay(new Date());
  const from = daysAgoUtc(365);

  console.log(`Range: ${utcDateString(from)} → ${utcDateString(to)}`);

  const prev = await loadPrevious();
  const prevClaude = previousBySource(prev, "claude");
  const prevCursor = previousBySource(prev, "cursor");
  const prevGithub = previousBySource(prev, "github");

  const token = await resolveGithubToken(config);

  async function safe(label, fn) {
    try {
      return await fn();
    } catch (err) {
      console.error(`${label} failed:`, err.message || err);
      return { ok: false, byDay: {} };
    }
  }

  const [github, cursor, claude] = await Promise.all([
    safe("GitHub", () => fetchGitHub(from, to, token, config.githubUsername)),
    safe("Cursor", () => fetchCursor(from, to, config)),
    safe("Claude", () => fetchClaude(from, to, config.claudeDir)),
  ]);

  const dayMap = emptyDayMap(from, to);

  for (const [date, counts] of dayMap) {
    // GitHub: always prefer fresh fetch; fall back to previous if fetch failed
    if (github.ok) {
      counts.github = github.byDay[date] ?? 0;
    } else {
      counts.github = prevGithub[date] ?? 0;
    }

    // Cursor: prefer fresh; preserve previous days if fetch failed
    if (cursor.ok) {
      counts.cursor = cursor.byDay[date] ?? 0;
    } else {
      counts.cursor = prevCursor[date] ?? 0;
    }

    // Claude: take max(fresh, previous) so cleanup of ~/.claude does not erase history
    const freshClaude = claude.byDay[date] ?? 0;
    const oldClaude = prevClaude[date] ?? 0;
    counts.claude = Math.max(freshClaude, oldClaude);
  }

  let days = [...dayMap.entries()].map(([date, counts]) => ({
    date,
    github: counts.github,
    cursor: counts.cursor,
    claude: counts.claude,
    total: counts.github + counts.cursor + counts.claude,
  }));

  days = mergeLevels(days);

  const payload = {
    generatedAt: new Date().toISOString(),
    from: utcDateString(from),
    to: utcDateString(to),
    sources: {
      github: github.ok,
      cursor: cursor.ok,
      claude: claude.ok || Object.values(prevClaude).some((n) => n > 0),
    },
    totals: {
      github: days.reduce((s, d) => s + d.github, 0),
      cursor: days.reduce((s, d) => s + d.cursor, 0),
      claude: days.reduce((s, d) => s + d.claude, 0),
      combined: days.reduce((s, d) => s + d.total, 0),
    },
    days,
  };

  await mkdir(dirname(OUT_PATH), { recursive: true });
  const next = `${JSON.stringify(payload, null, 2)}\n`;
  const prevText = (await pathExists(OUT_PATH))
    ? await readFile(OUT_PATH, "utf8")
    : "";
  if (prevText === next) {
    console.log("Contribution data unchanged");
    await markSynced();
    return;
  }

  await writeFile(OUT_PATH, next);
  console.log(`Wrote ${OUT_PATH}`);
  console.log("Totals:", payload.totals);
  console.log("Sources:", payload.sources);

  // Mark before push so a nested pre-push hook is debounced
  await markSynced();

  try {
    await commitAndPushIfChanged(siteRepo);
  } catch (err) {
    console.warn("Git commit/push skipped or failed:", err.message || err);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
