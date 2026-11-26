#!/usr/bin/env node
/**
 * DailyInfo Discord agent — conversational front-end for the local agent.
 *
 *   npm run discord-bot
 *
 * The owner (DISCORD_OWNER_NAME / DISCORD_OWNER_ID) just TALKS to it in any
 * channel or thread — no slash commands. Messages go through an LLM intent
 * router; the bot executes and replies in a thread it creates:
 *
 *   paper title / arXiv link / DOI → fetch + PDF + structured summary
 *   "summarize this"               → summarize the last fetched paper
 *   "what does owner/repo do?"     → GitHub repo explainer (README + metadata)
 *   "find it online / need details"→ web research (search + read + cite)
 *   "anything new in hydrology?"   → corpus Q&A with citations
 *   "search <keywords>"            → raw corpus search
 *   anything else                  → conversational reply
 *
 * Requires: Message Content Intent enabled in the Developer Portal, the bot
 * invited with Send Messages / Create Public Threads / Send Messages in
 * Threads / Embed Links, and network access (proxy env) for the LLM APIs.
 * Online only while this process runs on the PC.
 */
import { Client, GatewayIntentBits, Events } from 'discord.js';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import https from 'node:https';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { createJobRunner } from './agent-jobs.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OWNER_NAME = (process.env.DISCORD_OWNER_NAME || '').toLowerCase();
const OWNER_ID = process.env.DISCORD_OWNER_ID || '';
const MAX_MESSAGE_CHARS = 1990;
const PROGRESS_EDIT_MS = 6000;

const runner = createJobRunner();
const statePath = join(repo, 'runtime/agent-state.json');

function readAgentState() {
  try {
    return JSON.parse(readFileSync(statePath, 'utf8'));
  } catch {
    return {};
  }
}

function writeAgentState(patch) {
  const state = { ...readAgentState(), ...patch };
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}
const threadPaper = new Map(); // threadId → last fetched paper title (context memory)

function clip(text, limit) {
  if (!text) return '';
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function isOwner(message) {
  if (message.author.bot) return false;
  if (OWNER_ID && message.author.id === OWNER_ID) return true;
  return Boolean(OWNER_NAME) && message.author.username.toLowerCase() === OWNER_NAME;
}

/** Split long text into ≤MAX_MESSAGE_CHARS chunks at line boundaries. */
function chunkText(text) {
  const clean = String(text ?? '').trim();
  if (clean.length <= MAX_MESSAGE_CHARS) return [clean];
  const chunks = [];
  let rest = clean;
  while (rest.length > MAX_MESSAGE_CHARS) {
    let cut = rest.lastIndexOf('\n', MAX_MESSAGE_CHARS);
    if (cut < MAX_MESSAGE_CHARS / 2) cut = MAX_MESSAGE_CHARS;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, '');
  }
  if (rest) chunks.push(rest);
  return chunks;
}

/** Discord I/O adapter: first send becomes an acknowledgment message + a
 * thread (in channel context); everything else lands inside the thread.
 * progress() edits the acknowledgment so the channel stays clean. */
class DiscordIO {
  constructor(message) {
    this.message = message;
    this.ackMessage = null; // NB: never name this `ack` — it shadows the ack() method
    this.thread = null;
    this.lastEdit = 0;
    this.typingTimer = null;
    this.finished = false;
    // "DailyInfo is typing…" like WhatsApp — sendTyping lasts ~10s, renew early.
    this.startTyping();
  }

  /** best-effort: never let cosmetics break the agent */
  async tryReact(emoji) {
    try { await this.message.react(emoji); } catch { /* Add Reactions may be missing */ }
  }

  async tryRemoveReactions() {
    try {
      for (const reaction of this.message.reactions.cache.values()) {
        await reaction.users.remove(this.message.client.user.id);
      }
    } catch { /* cosmetic */ }
  }

  startTyping() {
    if (this.typingTimer) return;
    const send = () => { try { void (this.thread ?? this.message.channel).sendTyping(); } catch { /* cosmetic */ } };
    send();
    this.typingTimer = setInterval(send, 8500);
  }

  stopTyping() {
    if (this.typingTimer) { clearInterval(this.typingTimer); this.typingTimer = null; }
  }

  /** Final lifecycle state on the owner's message: ✅ done / ⚠️ failed. */
  finish(ok = true) {
    if (this.finished) return;
    this.finished = true;
    this.stopTyping();
    void (async () => {
      await this.tryRemoveReactions();
      await this.tryReact(ok ? '✅' : '⚠️');
    })();
  }

  get contextKey() {
    return this.thread?.id ?? this.message.channel.id;
  }
  async ack(text) {
    const payload = { content: clip(text, MAX_MESSAGE_CHARS) };
    try {
      this.ackMessage = await this.message.reply(payload);
    } catch {
      // Some messages cannot be replied to (threads under webhook digest
      // posts, system messages) — fall back to a plain channel message.
      this.ackMessage = await this.message.channel.send(payload);
    }
    await this.tryReact('⏳');
    if (!this.message.channel.isThread()) {
      try {
        this.thread = await this.ackMessage.startThread({ name: clip(text, 60) || 'agent', autoArchiveDuration: 1440 });
      } catch {
        /* thread creation is best-effort — replies continue in the channel */
      }
    }
    return this.ackMessage;
  }
  async progress(text) {
    if (!this.ackMessage) return;
    if (Date.now() - this.lastEdit < PROGRESS_EDIT_MS) return this.ackMessage;
    this.lastEdit = Date.now();
    try {
      await this.ackMessage.edit({ content: clip(text, MAX_MESSAGE_CHARS) });
    } catch {
      /* progress edits are cosmetic */
    }
    return this.ackMessage;
  }
  async send(text) {
    const chunks = chunkText(text);
    const target = this.thread ?? this.message.channel;
    for (const chunk of chunks) await target.send({ content: clip(chunk, MAX_MESSAGE_CHARS) });
  }
  async sendFile(text, name) {
    const target = this.thread ?? this.message.channel;
    await target.send({ files: [{ attachment: Buffer.from(text, 'utf8'), name }] });
  }

  /** Recent conversation context: the thread's starter message (often the
   * digest notice the user is asking about) plus recent messages. */
  async fetchHistory(limit = 8) {
    const parts = [];
    try {
      const channel = this.thread ?? this.message.channel;
      if (typeof channel.fetchStarterMessage === 'function') {
        const starter = await channel.fetchStarterMessage();
        if (starter?.content?.trim()) parts.push(`[thread starter — the notice/topic this thread is about]\n${clip(starter.content.replace(/<@!?\d+>/g, ''), 700)}`);
      }
      const msgs = await channel.messages.fetch({ limit: limit + 1, before: this.message.id });
      const lines = [...msgs.values()].reverse()
        .filter((m) => m.id !== this.message.id && m.author.id !== this.message.client.user.id && m.content?.trim())
        .map((m) => `${m.author.username}: ${clip(m.content.replace(/<@!?\d+>/g, ''), 240)}`);
      if (lines.length) parts.push(`[recent messages]\n${lines.join('\n')}`);
    } catch {
      /* history is best-effort */
    }
    return parts.join('\n\n');
  }
}

// ---------------------------------------------------------------------------
// Agent core — testable without Discord (io is the I/O adapter).
// ---------------------------------------------------------------------------

async function githubRepoSummary(argument, chat) {
  const match = argument.match(/github\.com\/([\w.-]+)\/([\w.-]+)/i)
    ?? argument.trim().match(/^([\w.-]+)\/([\w.-]+)$/);
  if (!match) return 'Give me a GitHub link (github.com/owner/repo) or "owner/repo".';
  const slug = `${match[1]}/${match[2]}`.replace(/\.git$/, '');
  const meta = await fetch(`https://api.github.com/repos/${slug}`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'DailyInfo-agent' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!meta.ok) return `GitHub API ${meta.status} for ${slug} — does the repo exist?`;
  const repoMeta = await meta.json();
  let readme = '';
  try {
    readme = await fetch(`https://api.github.com/repos/${slug}/readme`, {
      headers: { Accept: 'application/vnd.github.raw', 'User-Agent': 'DailyInfo-agent' },
      signal: AbortSignal.timeout(20_000),
    }).then((r) => (r.ok ? r.text() : ''));
  } catch {
    /* readme is best-effort */
  }
  const summary = await chat(
    [
      { role: 'system', content: 'You explain GitHub repositories in 3-5 short sentences: what it is, what it does, who it is for. Plain English, no marketing fluff, based only on the provided information.' },
      { role: 'user', content: `Repo: ${repoMeta.full_name}\nDescription: ${repoMeta.description ?? '(none)'}\nLanguage: ${repoMeta.language ?? '?'}\nStars: ${repoMeta.stargazers_count ?? '?'}\n\nREADME:\n${clip(readme, 6000)}` },
    ],
    { maxTokens: 700, temperature: 0.2 },
  );
  return `**${repoMeta.full_name}** — ⭐ ${repoMeta.stargazers_count ?? '?'} · ${repoMeta.language ?? '?'}\n${repoMeta.description ? `${repoMeta.description}\n\n` : ''}${summary}\n${repoMeta.html_url}`;
}

// ---------------------------------------------------------------------------
// Web research: search the open web (DuckDuckGo HTML), read the top pages,
// and synthesize a cited answer. Used for "find it online" requests.
// ---------------------------------------------------------------------------

function htmlToText(html) {
  return String(html ?? '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#x?27;|&#39;/gi, "'")
    .replace(/&#x?\w+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeDdgLink(href) {
  let url = href;
  if (url.startsWith('//')) url = `https:${url}`;
  const redirect = url.match(/[?&]uddg=([^&]+)/);
  if (redirect) url = decodeURIComponent(redirect[1]);
  return url;
}

function unwrapBingLink(href) {
  const url = href.replaceAll('&amp;', '&');
  const wrapped = url.match(/[?&]u=a1([\w-]+)/);
  if (wrapped) {
    try {
      const b64 = wrapped[1].replace(/-/g, '+').replace(/_/g, '/');
      const decoded = Buffer.from(b64, 'base64').toString('utf8');
      if (/^https?:\/\//.test(decoded)) return decoded;
    } catch {
      /* keep the wrapped url */
    }
  }
  return url;
}

async function bingSearch(query, limit = 6) {
  const res = await fetch(`https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=en&count=${limit + 4}`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    signal: AbortSignal.timeout(25_000),
  });
  if (!res.ok) throw new Error(`Bing search failed: HTTP ${res.status}`);
  const html = await res.text();
  const results = [];
  const li = /<li class="b_algo"[^>]*>([\s\S]*?)<\/li>/g;
  let m;
  while ((m = li.exec(html)) && results.length < limit) {
    const blockHtml = m[1];
    const link = blockHtml.match(/<h2[^>]*><a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i)
      ?? blockHtml.match(/<a[^>]+href="(https?:[^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!link) continue;
    const url = unwrapBingLink(link[1]);
    const title = htmlToText(link[2]);
    if (!/^https?:\/\//.test(url) || !title) continue;
    const p = blockHtml.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    results.push({ url, title, snippet: p ? htmlToText(p[1]) : '' });
  }
  return results;
}

async function baiduSearch(query, limit = 6) {
  const res = await fetch(`https://www.baidu.com/s?wd=${encodeURIComponent(query)}&rn=${limit + 4}`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.6',
    },
    signal: AbortSignal.timeout(25_000),
  });
  if (!res.ok) throw new Error(`Baidu search failed: HTTP ${res.status}`);
  const html = await res.text();
  const results = [];
  const block = /<h3[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = block.exec(html)) && results.length < limit) {
    const title = htmlToText(m[2]);
    const url = m[1].replaceAll('&amp;', '&');
    if (!title || !url) continue;
    results.push({ url, title, snippet: '' });
  }
  return results;
}

async function sogouSearch(query, limit = 6) {
  const res = await fetch(`https://www.sogou.com/web?query=${encodeURIComponent(query)}`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.6',
    },
    signal: AbortSignal.timeout(25_000),
  });
  if (!res.ok) throw new Error(`Sogou search failed: HTTP ${res.status}`);
  const html = await res.text();
  const results = [];
  const block = /<h3[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = block.exec(html)) && results.length < limit) {
    let url = m[1].replaceAll('&amp;', '&');
    if (url.startsWith('/')) url = `https://www.sogou.com${url}`;
    const title = htmlToText(m[2]);
    if (!title || !url) continue;
    results.push({ url, title, snippet: '' });
  }
  return results;
}

function dedupe(results) {
  const seen = new Set();
  const out = [];
  for (const r of results) {
    const key = (r.url.replace(/\/+$/, '') + '|' + r.title).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

async function webSearch(query, limit = 6) {
  // Sogou first — reliable from this network and strong on Chinese sources
  // (NSFC/university notices). Bing next; DuckDuckGo last.
  try {
    const results = await sogouSearch(query, limit);
    if (results.length) return results;
  } catch {
    /* fall through */
  }
  try {
    const results = await bingSearch(query, limit);
    if (results.length) return results;
  } catch {
    /* fall through */
  }
  const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) DailyInfo-agent' },
    signal: AbortSignal.timeout(25_000),
  });
  if (!res.ok) throw new Error(`DuckDuckGo search failed: HTTP ${res.status}`);
  const html = await res.text();
  const results = [];
  const block = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippet = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  const titles = [];
  let m;
  while ((m = block.exec(html)) && titles.length < limit) {
    titles.push({ url: decodeDdgLink(m[1]), title: htmlToText(m[2]) });
  }
  let s;
  let i = 0;
  while ((s = snippet.exec(html)) && i < titles.length) {
    titles[i].snippet = htmlToText(s[1]);
    i += 1;
  }
  for (const t of titles) if (t.url && t.title) results.push(t);
  return results;
}

async function fetchPageText(url, limit = 4000) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) DailyInfo-agent', Accept: 'text/html,*/*' },
    signal: AbortSignal.timeout(25_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const type = res.headers.get('content-type') ?? '';
  if (!/text\/html|text\/plain|application\/(xhtml|xml|json)/.test(type)) throw new Error(`not a text page (${type})`);
  return { url: res.url || url, text: clip(htmlToText(await res.text()), limit) };
}

async function webResearch(query, chat, io, contextNote = '') {
  await io.progress('🔎 searching the web…');
  const results = await webSearch(query);
  if (!results.length) return `I could not find anything for "${query}". Try rephrasing?`;

  // Read the top pages (skip obvious dead ones) to ground the answer.
  const pages = [];
  for (const r of results.slice(0, 4)) {
    try {
      const page = await fetchPageText(r.url);
      if (page.text.length > 200) pages.push({ ...r, ...page });
    } catch {
      /* page unreadable — the search snippet still helps */
    }
  }

  await io.progress(`📖 reading ${pages.length || 'no'} pages…`);
  const sources = results
    .map((r, i) => `[${i + 1}] ${r.title}\n    ${r.url}\n    ${clip(r.snippet ?? '', 200)}`)
    .join('\n');
  const extracts = pages
    .map((p) => `=== ${p.url} ===\n${p.text}`)
    .join('\n\n');
  const context = contextNote ? `\n\nContext from the user's thread (they are asking about this specific item):\n${clip(contextNote, 900)}` : '';

  const answer = await chat(
    [
      {
        role: 'system',
        content:
          'You are a research assistant answering from web search results. '
          + 'Answer the user\'s question in short, information-dense English. '
          + 'Lead with the direct answer (what it is + the key details: who can apply, deadline, link, requirements — whichever are relevant). '
          + 'If the thread context identifies a specific institution (e.g. Dalian University of Technology), connect the web findings to it — the user wants to know if THEY can still apply and what the deadline is. '
          + 'Cite sources inline as [1], [2] matching the numbered list. '
          + 'If the results do not contain the answer, say so plainly and give the closest official link you have. '
          + 'Never invent URLs or deadlines.',
      },
      {
        role: 'user',
        content: `Question: ${query}\n\nSearch results:\n${sources}\n\nPage extracts:\n${clip(extracts, 9000)}${context}`,
      },
    ],
    { maxTokens: 1100, temperature: 0.2 },
  );

  const links = results.slice(0, 5).map((r) => `<${r.url}>`).join('\n');
  return `${answer}\n\n**Sources:**\n${links}`;
}

// ---------------------------------------------------------------------------
// Agent loop — the LLM plans tool calls step by step, observes each result,
// and continues until the request is satisfied. This is what makes it an
// agent instead of a command router: "find this paper and save it to
// Zotero" becomes fetch → observe → save → report, in one conversation turn.
// ---------------------------------------------------------------------------

const AGENT_SYSTEM =
  'You are DailyInfo, a research AGENT on Discord serving one owner (a DUT researcher with a daily digest of papers, AI news, code, resources). '
  + 'You work toward the user\'s request by calling tools step by step, observing each result, and deciding what to do next. '
  + 'Guidelines: '
  + '• A research-paper title (often pasted verbatim, sometimes followed by "explain the method"/"summarize") → call fetch_paper. The fetch output answers abstract-level questions; if a PDF was saved and the user asked for depth, also call summarize_pdf. '
  + '• Paywalled paper → say so plainly, give the DOI, and mention university (WebVPN) access as their manual option. Never pretend you read the full text. '
  + '• Notices, programs, deadlines, official links, current info → web_search (include institution/program/year specifics from the thread context). '
  + '• "what\'s in today\'s digest" style questions about their own feed → corpus_search. '
  + '• Multi-step requests ("find X and save it to Zotero") → plan the minimal tool sequence yourself. '
  + '• zotero_save needs the Zotero desktop app open on this PC; if the result says it is not running, tell the user to open it and say "zotero" again. '
  + '• Citation saving works for ANY fetched paper — paywalled or not. Metadata (title/authors/DOI) is enough; NEVER suggest manual citation entry or make PDF availability a condition for saving. '
  + '• Ordinal references ("article number 2", "the second paper", "paper #3") resolve against the numbered list in the thread context: identify that item\'s exact TITLE and call fetch_paper with it. Never echo a digest part back and never search for strings like "part 18". '
  + '• Paywalled paper + the user wants the full text → offer the university flow: "open the paper via webvpn.dlut.edu.cn, copy the PDF or article URL from the address bar, then say uni <that link>". If they paste such a link, call uni_fetch with it (and append " | <the paywalled paper page URL>" when known) — access is checked with their own session cookie, the PDF is downloaded + summarized, and the link pattern is learned per journal for next time. The uni output is already user-facing; do not repeat it. '
  + '• Small talk or anything needing no tool → reply with {"answer": "..."} immediately. '
  + '• Recurring multi-step workflows have SKILLS — if one matches the request, call use_skill and then follow its instructions step by step with the other tools. '
  + '• Tool output already delivered to the user must NOT be repeated in the final answer — synthesize, add next steps, or keep the answer to one line.';

const TOOL_SPEC = [
  'TOOLS — reply with EXACTLY ONE JSON object per turn:',
  '{"tool":"fetch_paper","argument":"<paper title | arXiv link/ID | DOI>"}',
  '{"tool":"summarize_pdf","argument":"<slug of a fetched paper>"}',
  '{"tool":"corpus_search","argument":"<keywords>"}',
  '{"tool":"web_search","argument":"<short query>"}',
  '{"tool":"github_repo","argument":"<owner/repo or URL>"}',
  '{"tool":"zotero_save","argument":""}',
  '{"tool":"ris_file","argument":""}',
  '{"tool":"use_skill","argument":"<skill-name> [: extra details]"}',
  '{"tool":"weekly_draft","argument":""}',
  '{"tool":"read_weekly_draft","argument":"<optional date, empty = latest>"}',
  '{"tool":"long_write","argument":"<filename (in runtime/briefings/weekly/) to write the generated article to>"}',
  '{"tool":"post_article","argument":"<channel name, default ai-news>"}',
  '{"tool":"uni_fetch","argument":"<webvpn-url [| publisher-url]>"}',
  '{"answer":"<final reply to the user>"}',
].join('\n');

/** Skills are plain markdown files in skills/ — "When:" line describes the
 * trigger, everything after `---` is the procedure the agent follows. Users
 * add or edit skills without touching code; they are re-read every message. */
function loadSkills() {
  const dir = join(repo, 'skills');
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => {
        try {
          const raw = readFileSync(join(dir, f), 'utf8');
          const when = raw.match(/^When:\s*(.+)$/m)?.[1]?.trim() ?? '';
          const dash = raw.indexOf('\n---');
          const instructions = (dash >= 0 ? raw.slice(dash + 4) : raw.replace(/^When:.*$/m, '')).trim();
          return { name: f.replace(/\.md$/, ''), when, instructions };
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** Parse {"tool":...}|{"answer":...} out of a possibly chatty LLM reply.
 * Handles three failure shapes seen in the wild: chatty wrappers, raw
 * newlines inside strings, and JSON truncated by the token cap (unclosed
 * string — recover the payload instead of leaking the wrapper). */
export function parseDecision(raw) {
  const cleaned = String(raw ?? '').replace(/```json|```/g, '').trim();
  const start = cleaned.indexOf('{');
  if (start >= 0) {
    const jsonish = cleaned.slice(start);
    for (let end = jsonish.length; end > 1; end--) {
      try {
        const parsed = JSON.parse(jsonish.slice(0, end));
        if (parsed && typeof parsed === 'object') {
          if (parsed.answer !== undefined) return { answer: String(parsed.answer) };
          if (parsed.tool) return { tool: String(parsed.tool), argument: parsed.argument == null ? '' : String(parsed.argument) };
        }
      } catch {
        /* shrink the window and retry */
      }
    }
    const unescape = (s) => s
      .replace(/\\n/g, '\n')
      .replace(/\\"/g, '"')
      .replace(/\\t/g, '\t')
      .replace(/\\\\/g, '\\');
    // LLMs emit multi-line answer strings (raw newlines = invalid JSON).
    const answerMatch = jsonish.match(/^\{\s*"answer"\s*:\s*"([\s\S]*)"\s*\}?\s*$/);
    if (answerMatch) return { answer: unescape(answerMatch[1]) };
    // Truncated by the token cap: unclosed string — take what is there.
    if (/^\{\s*"answer"\s*:/.test(jsonish)) {
      const payload = jsonish.replace(/^\{\s*"answer"\s*:\s*"/, '').replace(/"\s*\}?[\s.]*$/, '');
      return { answer: unescape(payload) };
    }
    if (/^\{\s*"tool"\s*:/.test(jsonish)) {
      const tool = jsonish.match(/"tool"\s*:\s*"([^"]+)"/)?.[1];
      const arg = jsonish.match(/"argument"\s*:\s*"([\s\S]*)"/)?.[1];
      if (tool) return { tool, argument: arg ? unescape(arg.replace(/"\s*\}?[\s.]*$/, '')) : '' };
    }
  }
  return { answer: cleaned || '(no output)' };
}

async function runTool(tool, argument, ctx) {
  const { text, bot, corpus, chat, io, messages } = ctx;
  switch (tool) {
    case 'fetch_paper': {
      if (runner.busy()) return 'BUSY: another job is still running — wait a moment, then continue.';
      const job = runner.submit(`fetch ${argument ?? ''}`.trim());
      await job.done;
      if (job.status === 'error') return `FETCH FAILED: ${job.result}`;
      const logText = job.log.join('');
      const fetchedTitle = logText.match(/^Paper: (.+)$/m)?.[1];
      const paperUrl = logText.match(/^Paper page: (\S+)$/m)?.[1] ?? '';
      if (!fetchedTitle) {
        // No confident match — hand the ranking to the loop as an observation
        // so it can re-pick with --pick N or fall back to web_search, instead
        // of dumping the CLI candidate list into the chat.
        const ranking = logText.split('\n').filter((l) => /^\s+\d+\./.test(l)).slice(0, 5).join('\n');
        return `FETCH: no confident match for "${argument}". Candidates (pick one by re-running fetch with "--pick N"):\n${ranking}`;
      }
      threadPaper.set(io.contextKey, fetchedTitle);
      writeAgentState({ lastPaperTitle: fetchedTitle, lastPaperUrl: paperUrl });
      // The fetch output IS the user-facing content — deliver it directly.
      // NB: no chained summarize here. When an OA PDF exists, the fetch has
      // ALREADY produced the full-text summary; when paywalled, there is no
      // PDF to summarize. Chaining only burned tokens twice (user-reported).
      await io.send(cleanLogForReply(job.log) || job.result || '(no output)');
      await io.send('💾 save it: say **zotero** (desktop app must be open) or **ris** (Mendeley file).' + (logText.includes('No open-access PDF') ? '\n🔗 full text: open the paper via **webvpn.dlut.edu.cn**, copy the PDF/article URL, then say `uni <link>` — I will download it with your session and summarize it.' : ''));
      return `Fetched "${fetchedTitle}". The full summary is ALREADY delivered above — do NOT call summarize_pdf for it again.`;
    }
    case 'summarize_pdf': {
      const job = runner.submit(`summarize ${argument}`.trim());
      await job.done;
      const out = cleanLogForReply(job.log) || job.result || '(no output)';
      if (job.status !== 'done') return `SUMMARIZE FAILED: ${job.result}`;
      await io.send(out);
      return 'Summary delivered to the user.';
    }
    case 'corpus_search': {
      const hits = bot.search(corpus, argument || '').slice(0, 5);
      if (!hits.length) return 'No corpus matches.';
      return hits.map((h, i) => `[${i + 1}] ${h.title}\n    (${h.category}${h.sourceUrl ? ` · ${h.sourceUrl}` : ''})`).join('\n');
    }
    case 'web_search':
      return webResearch(argument, chat, io);
    case 'github_repo':
      return githubRepoSummary(argument, chat);
    case 'zotero_save': {
      const job = runner.submit(`zotero ${readAgentState().lastPaperUrl ?? ''}`.trim());
      await job.done;
      const out = cleanLogForReply(job.log) || job.result || '(no output)';
      if (job.status !== 'done') return `ZOTERO FAILED: ${job.result}`;
      await io.send(out);
      if (/not running/i.test(out)) {
        return 'ZOTERO DESKTOP NOT RUNNING. Tell the user exactly this and nothing else: open the Zotero desktop app on this PC, then say "zotero" again. Do not fetch, do not retry, do not suggest manual citation entry.';
      }
      return 'Zotero result delivered to the user.';
    }
    case 'ris_file': {
      const job = runner.submit(`ris ${readAgentState().lastPaperUrl ?? ''}`.trim());
      await job.done;
      const out = cleanLogForReply(job.log) || job.result || '(no output)';
      if (job.status !== 'done') return `RIS FAILED: ${job.result}`;
      await io.send(out);
      return 'RIS result delivered to the user.';
    }
    case 'use_skill': {
      const skills = loadSkills();
      const [name, ...rest] = String(argument ?? '').split(/[:\s]+/).filter(Boolean);
      const skill = skills.find((s) => s.name.toLowerCase() === (name ?? '').toLowerCase());
      if (!skill) {
        return `UNKNOWN SKILL "${name}". Available: ${skills.map((s) => s.name).join(', ') || '(none)'}.`;
      }
      const details = rest.join(' ').trim();
      return [
        `SKILL "${skill.name}" LOADED. Follow these instructions now using the other tools as needed.`,
        skill.instructions,
        details ? `\nUser request details for this skill: ${details}` : '',
      ].join('\n');
    }
    case 'weekly_draft': {
      if (runner.busy()) return 'BUSY: another job is still running — wait a moment, then continue.';
      const job = runner.submit('weekly');
      await job.done;
      const out = cleanLogForReply(job.log) || job.result || '(no output)';
      if (job.status !== 'done') return `WEEKLY DRAFT FAILED: ${job.result}`;
      await io.send(out);
      return 'Weekly draft generated and the path was delivered to the user. Read it with read_weekly_draft.';
    }
    case 'read_weekly_draft': {
      const dir = join(repo, 'runtime', 'briefings', 'weekly');
      if (!existsSync(dir)) return 'NO WEEKLY DRAFTS — call weekly_draft first.';
      const wanted = String(argument ?? '').trim();
      const file = readdirSync(dir)
        .filter((f) => f.startsWith('weekly_recap_') && f.endsWith('.md') && !f.includes('_polished') && (!wanted || f.includes(wanted)))
        .sort()
        .pop();
      if (!file) return 'NO WEEKLY DRAFTS — call weekly_draft first.';
      return `DRAFT FILE: ${file}\n\n${readFileSync(join(dir, file), 'utf8')}`;
    }
    case 'long_write': {
      // Long-form generation for skill rewrites: the loop's decision JSON is
      // too small for whole articles, so this tool generates from the full
      // conversation context with a large budget and writes the file.
      const generated = await chat(
        [...messages, { role: 'user', content: 'Now produce the FINAL article exactly as instructed. Output ONLY the article markdown — no commentary, no code fences.' }],
        { maxTokens: 4000, temperature: 0.3 },
      );
      const safeName = (String(argument ?? '').trim() || `weekly_recap_${new Date().toISOString().slice(0, 10)}_polished.md`)
        .replace(/[^\w.-]/g, '');
      const outDir = join(repo, 'runtime', 'briefings', 'weekly');
      mkdirSync(outDir, { recursive: true });
      writeFileSync(join(outDir, safeName), `${generated.trim()}\n`, 'utf8');
      await io.send(`📝 article written: runtime/briefings/weekly/${safeName} (${generated.length} chars)`);
      return `Article written to runtime/briefings/weekly/${safeName} (${generated.length} chars). It can be posted with post_article.`;
    }
    case 'post_article': {
      const guild = io.message?.guild;
      if (!guild) return 'NO GUILD: not connected to a server (test environment) — posting skipped.';
      const channelName = (String(argument ?? '').trim() || 'ai-news').replace(/^#/, '');
      const channel = guild.channels.cache.find((c) => c.name === channelName && c.isTextBased());
      if (!channel) return `CHANNEL NOT FOUND: #${channelName}`;
      const dir = join(repo, 'runtime', 'briefings', 'weekly');
      const file = existsSync(dir)
        ? readdirSync(dir).filter((f) => f.includes('_polished')).sort().pop()
        : null;
      if (!file) return 'NO POLISHED ARTICLE FOUND — run the polish first.';
      const content = readFileSync(join(dir, file), 'utf8');
      const parts = chunkText(content);
      for (let i = 0; i < parts.length; i++) {
        await channel.send({ content: `【Part ${i + 1}/${parts.length}】\n${clip(parts[i], MAX_MESSAGE_CHARS - 20)}` });
      }
      return `Posted ${parts.length} part(s) of ${file} to #${channelName}.`;
    }
    case 'uni_fetch': {
      const job = runner.submit(`uni ${argument ?? ''}`.trim());
      await job.done;
      const out = cleanLogForReply(job.log) || job.result || '(no output)';
      await io.send(out);
      if (/PDF saved/i.test(out)) {
        // University access granted — the PDF is in runtime/papers; summarize it.
        const slugMatch = out.match(/PDF saved: (.*\.pdf)/);
        if (slugMatch) {
          const slug = slugMatch[1].split(/[\\/]/).pop().replace(/\.pdf$/, '');
          await io.send('⏳ summarizing the paper from your university copy…');
          const sumJob = runner.submit(`summarize ${slug}`);
          await sumJob.done;
          const sumOut = cleanLogForReply(sumJob.log) || sumJob.result || '';
          if (sumJob.status === 'done' && sumOut) await io.send(sumOut);
        }
      }
      return 'University access result delivered to the user.';
    }
    default:
      return `UNKNOWN TOOL "${tool}" — pick one from the list.`;
  }
}

function cleanLogForReply(log) {
  return log
    .join('')
    .split('\n')
    .filter((line) => !/^\s*(\[(bot|agent|discord|jobs)\]|===|---)/.test(line))
    .join('\n')
    .trim();
}

export async function agentHandle(text, io) {
  const bot = await import(`./dailyinfo-bot.mjs?ts=${Date.now()}`);
  const corpus = { items: bot.loadItems(), briefings: bot.loadBriefings() };
  const chat = (messages, options) => bot.chat(messages, options);
  io.contextTitle = threadPaper.get(io.contextKey) ?? '';
  const history = typeof io.fetchHistory === 'function' ? await io.fetchHistory() : '';
  const state = readAgentState();

  const contextBlock =
    `Last fetched paper: ${io.contextTitle || state.lastPaperTitle || '(none)'}`
    + (state.lastPaperUrl ? `\nIts link: ${state.lastPaperUrl}` : '')
    + (history ? `\n\nThread context:\n${clip(history, 1400)}` : '')
    + `\n\nUser message: ${text}`;

  const skills = loadSkills();
  const skillCatalog = skills.length
    ? `\n\nSKILLS (recurring workflows — call use_skill when one matches, then follow its instructions):\n${skills.map((s) => `- ${s.name}: ${s.when}`).join('\n')}`
    : '';
  const messages = [
    { role: 'system', content: `${AGENT_SYSTEM}\n\n${TOOL_SPEC}${skillCatalog}` },
    { role: 'user', content: contextBlock },
  ];

  let acked = false;
  let maxSteps = 6;
  for (let step = 1; step <= maxSteps; step++) {
    // 900 tokens: long answers (a digest part, a short recap) must fit — a
    // truncated decision JSON used to leak raw into the chat.
    const raw = await chat(messages, { maxTokens: 900, temperature: 0 });
    const decision = parseDecision(raw);

    if (decision.answer !== undefined) {
      if (decision.answer.trim()) await io.send(decision.answer);
      return;
    }
    if (!decision.tool) {
      if (raw.trim()) await io.send(raw);
      return;
    }

    // Skills drive long multi-phase workflows — give them headroom.
    if (decision.tool === 'use_skill') maxSteps = Math.max(maxSteps, 14);

    const label = `⏳ ${decision.tool}${decision.argument ? `: ${clip(decision.argument, 100)}` : ''}…`;
    if (!acked) { await io.ack(label); acked = true; }
    else await io.progress(label);

    let output;
    try {
      output = await runTool(decision.tool, decision.argument, { text, bot, corpus, chat, io, messages });
    } catch (error) {
      output = `TOOL ERROR: ${error.message}`;
    }

    messages.push({ role: 'assistant', content: raw });
    // Skill instructions must arrive intact (they are the procedure) — other
    // tool results stay clipped to keep the loop lean.
    const observationClip = decision.tool === 'use_skill' ? 24_000 : 2_800;
    messages.push({
      role: 'user',
      content: `TOOL RESULT (${decision.tool}):\n${clip(output, observationClip)}\n\nDecide the next step: call another tool if the request needs it, or reply with {"answer":"..."} to finish. The answer must not repeat output already delivered — synthesize or add next steps.`,
    });
  }
  await io.send('(step limit reached — tell me to continue if the task needs more)');
}

// ---------------------------------------------------------------------------
// Discord gateway
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Proxy routing
//
// REST goes through global fetch (env-proxy aware under --use-env-proxy).
// The gateway websocket uses the `ws` package, which is NOT proxy aware: it
// sets opts.createConnection (overriding agents and the global dispatcher) and
// calls https.request directly. Patching https.request to inject a proxy agent
// (and drop createConnection) is the one hook that actually works — verified
// against the live gateway.
// ---------------------------------------------------------------------------
function installProxyForWebSocket() {
  const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
  if (!proxy) return;
  const agent = new HttpsProxyAgent(proxy);
  const original = https.request;
  https.request = function patchedRequest(...args) {
    const first = args[0];
    if (first && typeof first === 'object' && !(first instanceof URL)) {
      first.agent = agent;
      delete first.createConnection;
    } else if (typeof first === 'string' || first instanceof URL) {
      const second = args[1];
      if (second && typeof second === 'object') {
        second.agent = agent;
        delete second.createConnection;
      } else {
        args.splice(1, 0, { agent });
      }
    }
    return original.apply(this, args);
  };
  console.log(`[discord-agent] websocket traffic routed via ${proxy}`);
}

function main() {
  installProxyForWebSocket();
  if (!process.env.DISCORD_BOT_TOKEN) {
    console.error('[discord-agent] DISCORD_BOT_TOKEN is not set (.env).');
    process.exitCode = 1;
    return;
  }
  if (!OWNER_NAME && !OWNER_ID) {
    console.error('[discord-agent] DISCORD_OWNER_NAME (or DISCORD_OWNER_ID) is not set — refusing to start (owner-only agent).');
    process.exitCode = 1;
    return;
  }
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
    // Route discord.js REST through the env proxy (global fetch honors
    // HTTPS_PROXY under --use-env-proxy).
    rest: process.env.HTTPS_PROXY ? { makeRequest: (url, init) => fetch(url, init) } : {},
  });
  client.once(Events.ClientReady, () => {
    console.log(`[discord-agent] online as ${client.user.tag} — owner: ${OWNER_NAME || OWNER_ID}`);
  });
  client.on(Events.ShardDisconnect, (event, shardId) => {
    console.error(`[discord-agent] shard ${shardId} disconnected:`, JSON.stringify(event));
  });
  client.on(Events.ShardError, (error, shardId) => {
    console.error(`[discord-agent] shard ${shardId} error:`, error.message);
  });
  client.on(Events.MessageCreate, async (message) => {
    try {
      if (!isOwner(message)) return;
      // Strip the @mention (if any) so the intent router sees clean text.
      const text = message.content.replace(/<@!?\d+>/g, '').trim() || message.content.trim();
      if (text.length < 2) return;
      console.log(`[discord-agent] ${message.author.username} in #${message.channel.name ?? 'dm'}: ${clip(text, 100)}`);
      const io = new DiscordIO(message);
      await io.tryReact('👀'); // instant "agent is alive" signal
      try {
        await agentHandle(text, io);
        io.finish(true);
      } catch (error) {
        io.finish(false);
        console.error(`[discord-agent] error: ${error.message}`);
        try { await message.reply({ content: clip(`⚠️ ${error.message}`, MAX_MESSAGE_CHARS) }); } catch { /* channel may be unusable */ }
      }
    } catch (error) {
      console.error(`[discord-agent] error: ${error.message}`);
      try {
        await message.reply({ content: clip(`⚠️ ${error.message}`, MAX_MESSAGE_CHARS) });
      } catch {
        try { await message.channel.send({ content: clip(`⚠️ ${error.message}`, MAX_MESSAGE_CHARS) }); } catch { /* channel may be unusable */ }
      }
    }
  });
  client.login(process.env.DISCORD_BOT_TOKEN).catch((error) => {
    console.error(`[discord-agent] login failed: ${error.message}`);
    process.exitCode = 1;
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
