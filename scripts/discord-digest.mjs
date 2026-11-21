#!/usr/bin/env node
/**
 * Post the latest English daily digest to Discord, category by category —
 * as plain-text "【Part N/M】" messages directly in the channel (no thread,
 * no click needed), matching the Chinese daily bot's style:
 *
 *   【Part 1/3】
 *   GitHub Trending - 2026-11-20
 *   owner/repo
 *   描述…
 *   ...
 *
 * Original section structure (GitHub Trending / Models / Datasets / journal
 * groups / DLUT categories) is preserved inside the parts. One webhook per
 * category (env: DISCORD_WEBHOOK_PAPERS, DISCORD_WEBHOOK_ARXIV,
 * DISCORD_WEBHOOK_AI_NEWS, DISCORD_WEBHOOK_CODE, DISCORD_WEBHOOK_RESOURCE —
 * locally via .env, in CI via repository secrets).
 *
 * A marker file (runtime/bot-cache/.discord-posted.json) records which
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
const PART_CHARS = 1975; // Discord plain-message limit is 2000, minus the 【Part N/M】 prefix

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

const args = process.argv.slice(2);
const dry = args.includes('--dry');
const force = args.includes('--force');
const onlyIndex = args.indexOf('--only');
const onlyArg = onlyIndex !== -1 ? (args[onlyIndex + 1] ?? '') : '';
const dateArg = args.find((arg) => /^\d{4}-\d{2}-\d{2}$/.test(arg)) ?? '';

function parseDocument(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  return match ? { body: match[2] } : { body: text };
}

function cleanHeading(text) {
  return String(text)
    .replaceAll(/\*\*/g, '')
    .replaceAll(/\s+/g, ' ')
    .trim();
}

/** Each ##/### section (heading + body, structure preserved verbatim —
 * numbered items, bullets, links all stay as the translator wrote them). */
function extractSections(body) {
  const sections = [];
  const lines = body.split(/\r?\n/);
  let current = null;
  for (const line of lines) {
    const heading = line.match(/^#{2,3}\s+(.+?)\s*$/);
    if (heading) {
      if (current && current.summary.trim()) sections.push(current);
      current = { title: cleanHeading(heading[1]), summary: '' };
    } else if (current) {
      current.summary += (current.summary ? '\n' : '') + line;
    }
  }
  if (current && current.summary.trim()) sections.push(current);
  return sections;
}

/** Pack section blocks into 【Part N/M】 texts of ≤PART_CHARS. A single
 * over-long section is split at line boundaries where possible. */
function packParts(sections) {
  const blocks = sections.map((section) => `**${section.title}**\n${section.summary.trim()}`);
  const parts = [];
  let current = '';
  for (const block of blocks) {
    const candidate = current ? `${current}\n\n${block}` : block;
    if (candidate.length > PART_CHARS && current) {
      parts.push(current);
      current = block;
    } else {
      current = candidate;
    }
    while (current.length > PART_CHARS) {
      let cut = current.lastIndexOf('\n', PART_CHARS);
      if (cut < PART_CHARS / 2) cut = PART_CHARS;
      parts.push(current.slice(0, cut));
      current = current.slice(cut).replace(/^\n+/, '');
    }
  }
  if (current) parts.push(current);
  return parts.map((part, index) => `【Part ${index + 1}/${parts.length}】\n\n${part}`);
}

async function postToDiscord(webhookUrl, payload) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20_000),
    });
    if (response.ok) return;
    if (response.status === 429 && attempt === 0) {
      const wait = Number(response.headers.get('retry-after') ?? 2) * 1000;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, wait));
      continue;
    }
    throw new Error(`Discord webhook ${response.status}`);
  }
}

function readMarker() {
  try {
    return JSON.parse(readFileSync(markerPath, 'utf8'));
  } catch {
    return {};
  }
}

function readdirDates() {
  return readdirSync(cacheDir)
    .filter((name) => /^\d{4}-\d{2}-\d{2}$/.test(name))
    .sort()
    .reverse();
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
    const parts = packParts(extractSections(body));

    if (dry) {
      console.log(`[discord] DRY ${category.label}: ${parts.length} part post(s) → ${pageUrl(date, category)}`);
      for (const part of parts) console.log(part.split('\n').slice(0, 3).join(' | ').slice(0, 150));
      continue;
    }

    try {
      for (const [index, part] of parts.entries()) {
        await postToDiscord(webhookUrl, { username: 'DailyInfo', content: part });
        if (index < parts.length - 1) {
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 800));
        }
      }
      console.log(`[discord] ${category.label}: ${parts.length} part post(s) → ${pageUrl(date, category)}`);
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

function pageUrl(date, category) {
  return `${SITE.publicUrl}en/${date}/${category.slug}/`;
}

main().catch((error) => {
  console.error(`[discord] ${error.message}`);
  process.exitCode = 1;
});
