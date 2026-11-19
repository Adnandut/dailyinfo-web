#!/usr/bin/env node
/**
 * Post the latest English daily digest to Discord, category by category.
 *
 * One webhook per category (env: DISCORD_WEBHOOK_PAPERS, DISCORD_WEBHOOK_ARXIV,
 * DISCORD_WEBHOOK_AI_NEWS, DISCORD_WEBHOOK_CODE, DISCORD_WEBHOOK_RESOURCE —
 * locally via .env, in CI via repository secrets).
 *
 * Reads the newest translated day from runtime/bot-cache/en/ and posts one
 * compact embed per category (top headlines + link to the /en/ page). A
 * marker file (runtime/bot-cache/.discord-posted.json) records which
 * categories were already posted per date so repeated deploys do not spam
 * the channels; when upstream publishes a later wave for the same date, the
 * new categories still go out.
 *
 * Usage:
 *   node scripts/discord-digest.mjs                 # latest date, respect marker
 *   node scripts/discord-digest.mjs --date 2026-11-19
 *   node scripts/discord-digest.mjs --force         # ignore the marker
 *   node scripts/discord-digest.mjs --only papers   # one category
 *   node scripts/discord-digest.mjs --dry           # print, do not POST
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SITE } from '../src/lib/site.ts';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cacheDir = join(repo, 'runtime/bot-cache/en');
const markerPath = join(repo, 'runtime/bot-cache/.discord-posted.json');

const CATEGORIES = [
  { id: 'papers', label: 'Papers', slug: 'papers' },
  { id: 'arxiv', label: 'arXiv', slug: 'arxiv' },
  { id: 'ai_news', label: 'AI News', slug: 'ai-news' },
  { id: 'code', label: 'Code', slug: 'code' },
  { id: 'resource', label: 'Resource', slug: 'resource' },
];
const WEBHOOK_ENV = {
  papers: 'DISCORD_WEBHOOK_PAPERS',
  arxiv: 'DISCORD_WEBHOOK_ARXIV',
  ai_news: 'DISCORD_WEBHOOK_AI_NEWS',
  code: 'DISCORD_WEBHOOK_CODE',
  resource: 'DISCORD_WEBHOOK_RESOURCE',
};
const HEADLINE_COUNT = 5;
const HEADLINE_CHARS = 160;

const args = process.argv.slice(2);
const dry = args.includes('--dry');
const force = args.includes('--force');
const onlyArg = args.find((arg) => arg.startsWith('--only'))?.split('=')[1]
  ?? (args[args.indexOf('--only') + 1] && !args[args.indexOf('--only') + 1].startsWith('--')
    ? args[args.indexOf('--only') + 1] : '');
const dateArg = args.find((arg) => /^\d{4}-\d{2}-\d{2}$/.test(arg)) ?? '';

function parseDocument(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  return match ? { body: match[2] } : { body: text };
}

function cleanMarkdown(text) {
  return String(text)
    .replaceAll(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replaceAll(/\*\*/g, '')
    .replaceAll(/\s+/g, ' ')
    .trim();
}

function extractHeadlines(body) {
  const headlines = [];
  for (const line of body.split(/\r?\n/)) {
    const numbered = line.match(/^\s*\d+\.\s+\*\*(.+?)\*\*/);
    const dated = line.match(/^\s*\*\*\[\d{4}-\d{2}-\d{2}\]\s*(.+?)\*\*/);
    const raw = numbered?.[1] ?? dated?.[1];
    if (!raw) continue;
    const title = cleanMarkdown(raw).slice(0, HEADLINE_CHARS);
    if (title && !headlines.includes(title)) headlines.push(title);
    if (headlines.length >= HEADLINE_COUNT) break;
  }
  return headlines;
}

async function postToDiscord(webhookUrl, payload) {
  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 429) {
    const wait = Number(response.headers.get('retry-after') ?? 2) * 1000;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, wait));
    const retry = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });
    if (!retry.ok) throw new Error(`Discord webhook ${retry.status}`);
    return;
  }
  if (!response.ok) throw new Error(`Discord webhook ${response.status}`);
}

async function main() {
  if (!existsSync(cacheDir)) {
    console.error('[discord] no translation cache — run: npm run bot -- translate');
    process.exitCode = 1;
    return;
  }
  const dates = readdirDates();
  const date = dateArg || dates[0];
  if (!date) {
    console.error('[discord] no translated days found');
    process.exitCode = 1;
    return;
  }
  const posted = readMarker();
  const already = new Set(posted[date] ?? []);
  let postedSomething = false;

  for (const category of CATEGORIES) {
    if (onlyArg && category.id !== onlyArg.replaceAll('-', '_')) continue;
    const file = join(cacheDir, date, `${category.id}.md`);
    if (!existsSync(file)) { console.log(`[discord] ${category.label}: no translation for ${date} — skipped`); continue; }
    if (!force && already.has(category.id)) { console.log(`[discord] ${category.label}: already posted for ${date} — skipped (--force to repost)`); continue; }

    const webhookUrl = process.env[WEBHOOK_ENV[category.id]];
    if (!webhookUrl) { console.log(`[discord] ${category.label}: ${WEBHOOK_ENV[category.id]} not set — skipped`); continue; }

    const { body } = parseDocument(readFileSync(file, 'utf8'));
    const headlines = extractHeadlines(body);
    const pageUrl = `${SITE.publicUrl}en/${date}/${category.slug}/`;
    const description = headlines.length
      ? headlines.map((title, index) => `**${index + 1}.** ${title}`).join('\n').slice(0, 3900)
      : 'See the full English digest online.';
    const payload = {
      username: 'DailyInfo',
      embeds: [{
        title: `${category.label} — ${date}`,
        url: pageUrl,
        description,
        color: 0x2b6cb0,
        footer: { text: `DailyInfo English edition · ${SITE.publicUrl}en/` },
        timestamp: new Date().toISOString(),
      }],
    };

    if (dry) {
      console.log(`[discord] DRY ${category.label} → ${pageUrl}\n${description}\n`);
      continue;
    }
    try {
      await postToDiscord(webhookUrl, payload);
      console.log(`[discord] ${category.label}: posted ${headlines.length} headlines → ${pageUrl}`);
      already.add(category.id);
      posted[date] = [...already].sort();
      postedSomething = true;
    } catch (error) {
      console.error(`[discord] ${category.label}: FAILED — ${error.message}`);
      process.exitCode = 1;
    }
  }

  if (!dry && (postedSomething || force)) {
    mkdirSync(dirname(markerPath), { recursive: true });
    writeFileSync(markerPath, `${JSON.stringify(posted, null, 2)}\n`, 'utf8');
  }
}

function readdirDates() {
  return readdirSync(cacheDir)
    .filter((name) => /^\d{4}-\d{2}-\d{2}$/.test(name))
    .sort()
    .reverse();
}

function readMarker() {
  try {
    return JSON.parse(readFileSync(markerPath, 'utf8'));
  } catch {
    return {};
  }
}

main().catch((error) => {
  console.error(`[discord] ${error.message}`);
  process.exitCode = 1;
});
