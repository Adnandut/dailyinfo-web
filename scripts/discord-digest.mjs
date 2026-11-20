#!/usr/bin/env node
/**
 * Post the latest English daily digest to Discord, category by category,
 * ONE MESSAGE PER ITEM (separate posts, as the channels are meant to read
 * like a feed). A short header message links to the /en/ page.
 *
 * One webhook per category (env: DISCORD_WEBHOOK_PAPERS, DISCORD_WEBHOOK_ARXIV,
 * DISCORD_WEBHOOK_AI_NEWS, DISCORD_WEBHOOK_CODE, DISCORD_WEBHOOK_RESOURCE —
 * locally via .env, in CI via repository secrets).
 *
 * Reads the newest translated day from runtime/bot-cache/en/. A marker file
 * (runtime/bot-cache/.discord-posted.json) records which categories were
 * already posted per date so repeated deploys do not spam the channels; when
 * upstream publishes a later wave for the same date, the new categories
 * still go out.
 *
 * Usage:
 *   node scripts/discord-digest.mjs                 # latest date, respect marker
 *   node scripts/discord-digest.mjs --date 2026-11-19
 *   node scripts/discord-digest.mjs --force         # ignore the marker
 *   node scripts/discord-digest.mjs --only papers   # one category
 *   node scripts/discord-digest.mjs --dry           # print, do not POST
 *
 * Item volume: DISCORD_MAX_ITEMS (default 10) per category per day — the
 * channel stays a feed, not a firehose; the header links to the full page.
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
const MAX_ITEMS = Number(process.env.DISCORD_MAX_ITEMS) || 10;
const ITEM_SUMMARY_CHARS = 500;
const POST_GAP_MS = 700;

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

function cleanMarkdown(text) {
  return String(text)
    .replaceAll(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replaceAll(/\*\*/g, '')
    .replaceAll(/&lt;/g, '<').replaceAll(/&gt;/g, '>').replaceAll(/&amp;/g, '&')
    .replaceAll(/\s+/g, ' ')
    .trim();
}

/** Numbered items with a following "> summary" line — the digest format. */
function extractItems(body) {
  const items = [];
  const lines = body.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const titleMatch = lines[index].match(/^\s*\d+\.\s+\*\*(.+?)\*\*\s*$/);
    if (!titleMatch) continue;
    let summary = '';
    for (let next = index + 1; next < Math.min(index + 3, lines.length); next++) {
      const quote = lines[next].match(/^\s*>\s+(.+)$/);
      if (quote) { summary = cleanMarkdown(quote[1]); break; }
      if (lines[next].trim()) break;
    }
    const title = cleanMarkdown(titleMatch[1]);
    if (title && !items.some((item) => item.title === title)) {
      items.push({ title, summary });
    }
  }
  return items;
}

function clip(text, limit) {
  if (!text) return '';
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

async function postToDiscord(webhookUrl, payload) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
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
    const items = extractItems(body).slice(0, MAX_ITEMS);
    const pageUrl = `${SITE.publicUrl}en/${date}/${category.slug}/`;
    const total = (body.match(/^\s*\d+\.\s+\*\*/gm) ?? []).length;

    if (dry) {
      console.log(`[discord] DRY ${category.label}: ${items.length} item post(s) → ${pageUrl}`);
      for (const item of items) console.log(`   • ${clip(item.title, 90)}`);
      continue;
    }

    try {
      // Header message: what this feed is + where the full edition lives.
      await postToDiscord(webhookUrl, {
        username: 'DailyInfo',
        embeds: [{
          title: `${category.label} — ${date}`,
          url: pageUrl,
          description: `${total || items.length} articles today · posting ${items.length} highlights. Full edition: **${pageUrl}**`,
          color: 0x2b6cb0,
          footer: { text: 'DailyInfo English edition' },
        }],
      });
      await new Promise((resolveDelay) => setTimeout(resolveDelay, POST_GAP_MS));

      // One message per item: title + its summary.
      for (const [index, item] of items.entries()) {
        await postToDiscord(webhookUrl, {
          username: 'DailyInfo',
          embeds: [{
            title: clip(`${index + 1}. ${item.title}`, 250),
            url: pageUrl,
            description: clip(item.summary, ITEM_SUMMARY_CHARS) || 'See the full edition online.',
            color: 0x4a90d9,
            footer: { text: `DailyInfo · ${category.label} · ${date} · item ${index + 1}/${items.length}` },
          }],
        });
        await new Promise((resolveDelay) => setTimeout(resolveDelay, POST_GAP_MS));
      }
      console.log(`[discord] ${category.label}: header + ${items.length} item posts → ${pageUrl}`);
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

main().catch((error) => {
  console.error(`[discord] ${error.message}`);
  process.exitCode = 1;
});
