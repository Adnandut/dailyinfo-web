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
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
    this.ackMessage = await this.message.reply({ content: clip(text, MAX_MESSAGE_CHARS) });
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

function looksLikeGithubRepo(text) {
  if (/github\.com\//i.test(text)) return true;
  const bare = text.trim().match(/^[\w.-]+\/[\w.-]+$/);
  return Boolean(bare && /\b(do|does|repo|github|what|about)\b/i.test(text));
}

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

async function classify(text, contextTitle, chat, history = '') {
  const searchMatch = text.match(/^search\s+(.+)/i);
  if (searchMatch) return { action: 'search', argument: searchMatch[1] };
  if (/^(summarize|summarise|总结)\s*(this|it)?\s*[.!]?$/i.test(text)) return { action: 'summarize', argument: '' };
  if (looksLikeGithubRepo(text)) return { action: 'github', argument: text };

  const json = await chat(
    [
      {
        role: 'system',
        content:
          'You route messages for a research assistant. Reply ONLY with minified JSON: {"action":"fetch|summarize|ask|github|web|search|chat","argument":"..."}. '
          + 'Rules: "fetch" = the user wants a specific paper fetched/summarized (title, arXiv link or ID, DOI) — argument is the title/link. '
          + '"summarize" = user says summarize this/it referring to the last fetched paper — argument empty. '
          + '"github" = asks what a GitHub repo does or names a repo — argument is the repo slug or URL. '
          + '"web" = the user asks to find something ONLINE, needs a link/URL, asks about a notice/program/deadline (including items mentioned in the thread context), or wants current web info. argument is a SHORT web search query (3-10 words) that includes the institution/program/year specifics from the thread context where available. '
          + '"ask" = a question answerable from the user\'s own daily digest corpus — argument is the question. '
          + '"search" = explicit corpus search ("search ..." phrasing) — argument the keywords. '
          + '"chat" = greetings, small talk, or anything that is none of the above — argument the message.',
      },
      {
        role: 'user',
        content: `Context (last fetched paper title): ${contextTitle || '(none)'}\n${history ? `Thread context:\n${clip(history, 1400)}\n\n` : ''}Message: ${clip(text, 600)}`,
      },
    ],
    { maxTokens: 200, temperature: 0 },
  );

  try {
    const parsed = JSON.parse(json.replaceAll(/```json|```/g, '').trim());
    if (parsed && parsed.action) return parsed;
  } catch {
    /* fall through to chat */
  }
  return { action: 'chat', argument: text };
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
  const route = await classify(text, io.contextTitle, chat, history);

  await io.ack(`⏳ ${route.action}${route.argument ? `: ${clip(route.argument, 120)}` : ''}…`);

  if (route.action === 'github') {
    const reply = await githubRepoSummary(route.argument || text, chat);
    await io.send(reply);
    return;
  }
  if (route.action === 'web') {
    const reply = await webResearch(route.argument || text, chat, io, history);
    await io.send(reply);
    return;
  }
  if (route.action === 'chat') {
    const reply = await chat(
      [
        { role: 'system', content: 'You are the DailyInfo assistant. The user has a daily research digest (papers, AI news, code, resources). Answer helpfully in English; if their message looks like a paper title, offer to fetch it. If they ask you to find something online, say the word "find" and what to search for. If their message refers to earlier thread messages, use them as context.' },
        { role: 'user', content: `${history ? `Thread context:\n${clip(history, 1200)}\n\n` : ''}Message: ${text}` },
      ],
      { maxTokens: 900, temperature: 0.4 },
    );
    await io.send(reply);
    return;
  }
  if (route.action === 'summarize') {
    const lastTitle = threadPaper.get(io.contextKey) ?? readAgentState().lastPaperTitle;
    if (!lastTitle) { await io.send('No paper fetched in this session yet — send me a paper title or link first.'); return; }
    await io.send(`📌 summarizing the last fetched paper: ${lastTitle}`);
  }

  if (runner.busy()) { await io.send('⏳ another job is still running — try again in a moment.'); return; }
  const summarizeTarget = route.action === 'summarize' ? threadPaper.get(io.contextKey) ?? readAgentState().lastPaperTitle : null;
  const command = route.action === 'summarize'
    ? `summarize ${bot.slugifyFile(summarizeTarget ?? '')}`
    : `${route.action} ${route.argument ?? ''}`.trim();
  const job = runner.submit(command);
  io.contextTitle = io.contextTitle ?? '';

  // Stream progress into the thread while the job runs.
  const progressTimer = setInterval(async () => {
    try {
      const tail = job.log.join('').split('\n').filter(Boolean).slice(-2).join('\n');
      if (tail) await io.progress(tail);
    } catch {
      /* cosmetic */
    }
  }, PROGRESS_EDIT_MS);
  try {
    await job.done;
  } finally {
    clearInterval(progressTimer);
  }

  const reply = cleanLogForReply(job.log) || job.result || '(no output)';
  if (job.status === 'error') {
    await io.send(`⚠️ ${job.result}`);
    return;
  }
  const chunks = chunkText(reply);
  for (const chunk of chunks) await io.send(chunk);
  if (route.action === 'fetch') {
    // The hot-reloaded job module loses its internal state between jobs —
    // recover the fetched paper title from the log for per-thread context.
    const fetchedTitle = job.log.join('').match(/^Paper: (.+)$/m)?.[1]
      ?? bot.getLastFetchedPaper()?.title;
    if (fetchedTitle) {
      threadPaper.set(io.contextKey, fetchedTitle);
      io.contextTitle = fetchedTitle;
      writeAgentState({ lastPaperTitle: fetchedTitle });
    }
  }
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
      try { await message.reply({ content: clip(`⚠️ ${error.message}`, MAX_MESSAGE_CHARS) }); } catch { /* channel may be unusable */ }
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
