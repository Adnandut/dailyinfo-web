#!/usr/bin/env node
/**
 * Post the latest English daily digest to Discord, category by category —
 * items are BATCHED: up to 10 item-embeds per message (Discord's hard cap),
 * so a 299-item arXiv day is ~30 messages instead of 299. One notification
 * per message. First message carries the category header embed.
 *
 * One webhook per category (env: DISCORD_WEBHOOK_PAPERS, DISCORD_WEBHOOK_ARXIV,
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
 *
 * Tuning: DISCORD_ITEMS_PER_MESSAGE (default 10, hard cap 10),
 * DISCORD_MAX_ITEMS (0 = all items of the day, the default).
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
// Discord limits: 10 embeds per message, ~6000 chars across all embeds.
const MAX_ITEMS_PER_MESSAGE = Math.min(Number(process.env.DISCORD_ITEMS_PER_MESSAGE) || 10, 10);
const EMBED_CHAR_BUDGET = 5600; // Discord counts all embed text toward 6000/message
const ITEM_DESC_CHARS = 350;
const MAX_ITEMS = Number(process.env.DISCORD_MAX_ITEMS) || 0; // 0 = all items
  const POST_GAP_MS = 1200;
  const POST_GAP_THREAD_MS = 600;

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
    .replaceAll(/\[([^\]]+)\]\(([^)]*)\)/g, (match, label, url) => `[${label}](${url})`)
    .replaceAll(/\*\*/g, '')
    .replaceAll(/&lt;/g, '<').replaceAll(/&gt;/g, '>').replaceAll(/&amp;/g, '&')
    .replaceAll(/\s+/g, ' ')
    .trim();
}

function clip(text, limit) {
  if (!text) return '';
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

/** Numbered items with a following "> summary" line — papers/code/arxiv. */
function extractNumberedItems(body) {
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

/** Section-based fallback (ai_news/resource): each ##/### heading and its body
 * becomes one item. Links are kept so Discord renders them. */
function extractSections(body) {
  const sections = [];
  const lines = body.split(/\r?\n/);
  let current = null;
  for (const line of lines) {
    const heading = line.match(/^#{2,3}\s+(.+?)\s*$/);
    if (heading) {
      if (current && current.summary) sections.push(current);
      current = { title: cleanMarkdown(heading[1]).slice(0, 250), summary: '' };
    } else if (current) {
      const text = line.trim();
      if (!text || text.startsWith('[View Original]')) continue;
      current.summary += (current.summary ? '\n' : '') + text;
    }
  }
  if (current && current.summary) sections.push(current);
  return sections.map((section) => ({
    title: section.title,
    summary: clip(section.summary, 3400),
  }));
}

function extractItems(body) {
  const numbered = extractNumberedItems(body);
  return numbered.length ? numbered : extractSections(body);
}

/** Item -> embed (title ≤ 100, description ≤ ITEM_DESC_CHARS). */
function itemEmbed(item, position, total, pageUrl, category, date) {
  return {
    title: clip(`${position}. ${item.title}`, 90),
    url: pageUrl,
    description: clip(item.summary, ITEM_DESC_CHARS) || 'See the full edition online.',
    color: 0x4a90d9,
    footer: { text: `DailyInfo · ${category} · ${date} · ${position}/${total}` },
  };
}

function packMessages(items, pageUrl, category, date, total) {
  // Greedy pack: ≤10 embeds and ≤EMBED_CHAR_BUDGET chars per message. The
  // header embed joins the FIRST message, so its budget reserves room for it
  // (Discord counts every embed's title+description+footer toward 6000).
  const header = {
    title: clip(`${category.label} — ${date}`, 100),
    url: pageUrl,
    description: clip(`${total} articles today · full edition: **${pageUrl}**`, 300),
    color: 0x2b6cb0,
    footer: { text: 'DailyInfo English edition' },
  };
  const headerCost = header.title.length + header.description.length + header.footer.text.length + 30;
  const messages = [];
  let current = [];
  let chars = 0;
  for (const [index, item] of items.entries()) {
    const embed = itemEmbed(item, index + 1, total, pageUrl, category.label, date);
    const cost = (embed.title?.length ?? 0) + (embed.description?.length ?? 0) + (embed.footer?.text?.length ?? 0) + 30;
    const cap = messages.length === 0 ? MAX_ITEMS_PER_MESSAGE - 1 : MAX_ITEMS_PER_MESSAGE; // header takes one embed slot
    const budget = messages.length === 0 ? EMBED_CHAR_BUDGET - headerCost : EMBED_CHAR_BUDGET;
    if (current.length && (current.length >= cap || chars + cost > budget)) {
      messages.push({ embeds: current });
      current = [];
      chars = 0;
    }
    current.push(embed);
    chars += cost;
  }
  if (current.length) messages.push({ embeds: current });
  if (messages.length) messages[0].embeds.unshift(header);
  return messages;
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

const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || '';

function sleep(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function botApi(method, path, payload) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await fetch(`https://discord.com/api/v10${path}`, {
      method,
      headers: { Authorization: `Bot ${BOT_TOKEN}`, 'Content-Type': 'application/json' },
      body: payload ? JSON.stringify(payload) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
    if (response.ok) return response.json();
    if (response.status === 429 && attempt === 0) {
      const body429 = await response.json().catch(() => ({}));
      await sleep((body429.retry_after ?? 2) * 1000);
      continue;
    }
    const detail = (await response.text().catch(() => '')).slice(0, 150);
    throw new Error(`Discord bot API ${response.status}: ${detail}`);
  }
}

/**
 * Bot-token posting mode (webhooks cannot create threads): one header
 * message in the channel + a THREAD attached to it, with every item as its
 * own message inside the thread. Channel → "1 post, all items inside".
 */
/** Pack items into thread-message texts (≤ ~1850 chars): numbered bold titles
 * + "> summary", like "【Part 16/22】" — the format of the Chinese daily bot. */
function packTextParts(items) {
  const parts = [];
  let current = '';
  for (const [index, item] of items.entries()) {
    const line = `${index + 1}. **${clip(item.title, 250)}**`
      + (item.summary ? `\n   > ${clip(item.summary, 400)}` : '');
    const candidate = current ? `${current}\n\n${line}` : line;
    if (candidate.length > 1850) {
      parts.push(current);
      current = line;
    } else {
      current = candidate;
    }
  }
  if (current) parts.push(current);
  return parts.map((part, index) => `【Part ${index + 1}/${parts.length}】\n\n${part}`);
}

async function postCategoryViaBot(webhookInfo, items, pageUrl, category, date, total) {
    const channel = webhookInfo.channel_id;
    const header = await botApi('POST', `/channels/${channel}/messages`, {
      embeds: [{
        title: clip(`${category.label} — ${date}`, 250),
        url: pageUrl,
        description: `${total} articles today · all items in the thread below. Full edition: **${pageUrl}**`,
        color: 0x2b6cb0,
        footer: { text: 'DailyInfo English edition' },
      }],
    });
    const thread = await botApi('POST', `/channels/${channel}/messages/${header.id}/threads`, {
      name: clip(`${category.label} — ${date}`, 100),
    });
    const parts = packTextParts(items);
    for (const part of parts) {
      await botApi('POST', `/channels/${thread.id}/messages`, { content: part });
      await sleep(POST_GAP_THREAD_MS);
    }
    return { threadId: thread.id, messages: parts.length };
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
    const allItems = extractItems(body);
    const items = MAX_ITEMS > 0 ? allItems.slice(0, MAX_ITEMS) : allItems;
    const pageUrl = `${SITE.publicUrl}en/${date}/${category.slug}/`;
    const messages = packMessages(items, pageUrl, category, date, allItems.length);

    if (dry) {
      console.log(`[discord] DRY ${category.label}: ${items.length} items → ${messages.length} message(s) → ${pageUrl}`);
      continue;
    }

    try {
      if (BOT_TOKEN) {
        // Thread mode: 1 post in the channel + every item inside the thread.
        const webhookInfo = await fetch(webhookUrl, { signal: AbortSignal.timeout(15_000) }).then((r) => r.json());
        const outcome = await postCategoryViaBot(webhookInfo, items, pageUrl, category, date, allItems.length);
        console.log(`[discord] ${category.label}: thread with ${outcome.messages} message(s) → ${pageUrl}`);
      } else {
        // Webhook fallback: batched 10-embed messages (no thread support).
        for (const [index, payload] of messages.entries()) {
          await postToDiscord(webhookUrl, payload);
          if (index < messages.length - 1) {
            await new Promise((resolveDelay) => setTimeout(resolveDelay, POST_GAP_MS));
          }
        }
        console.log(`[discord] ${category.label}: ${items.length} items in ${messages.length} message(s) → ${pageUrl}`);
      }
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
