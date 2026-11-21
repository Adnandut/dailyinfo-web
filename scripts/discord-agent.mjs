#!/usr/bin/env node
/**
 * DailyInfo Discord agent â€” conversational front-end for the local agent.
 *
 *   npm run discord-bot
 *
 * The owner (DISCORD_OWNER_NAME / DISCORD_OWNER_ID) just TALKS to it in any
 * channel or thread â€” no slash commands. Messages go through an LLM intent
 * router; the bot executes and replies in a thread it creates:
 *
 *   paper title / arXiv link / DOI â†’ fetch + PDF + structured summary
 *   "summarize this"               â†’ summarize the last fetched paper
 *   "what does owner/repo do?"     â†’ GitHub repo explainer (README + metadata)
 *   "anything new in hydrology?"   â†’ corpus Q&A with citations
 *   "search <keywords>"            â†’ raw corpus search
 *   anything else                  â†’ conversational reply
 *
 * Requires: Message Content Intent enabled in the Developer Portal, the bot
 * invited with Send Messages / Create Public Threads / Send Messages in
 * Threads / Embed Links, and network access (FlClash) for the LLM APIs.
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
const threadPaper = new Map(); // threadId â†’ last fetched paper title (context memory)

function clip(text, limit) {
  if (!text) return '';
  return text.length > limit ? `${text.slice(0, limit - 1)}â€¦` : text;
}

function isOwner(message) {
  if (message.author.bot) return false;
  if (OWNER_ID && message.author.id === OWNER_ID) return true;
  return Boolean(OWNER_NAME) && message.author.username.toLowerCase() === OWNER_NAME;
}

/** Split long text into â‰¤MAX_MESSAGE_CHARS chunks at line boundaries. */
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
    this.ackMessage = null; // NB: never name this `ack` - it shadows the ack() method
    this.thread = null;
    this.lastEdit = 0;
  }
  get contextKey() {
    return this.thread?.id ?? this.message.channel.id;
  }
  async ack(text) {
    this.ackMessage = await this.message.reply({ content: clip(text, MAX_MESSAGE_CHARS) });
    if (!this.message.channel.isThread()) {
      try {
        this.thread = await this.ackMessage.startThread({ name: clip(text, 60) || 'agent', autoArchiveDuration: 1440 });
      } catch {
        /* thread creation is best-effort â€” replies continue in the channel */
      }
    }
    return this.ackMessage;
  }
  async progress(text) {
    if (!this.ackMessage) return;
    if (Date.now() - this.lastEdit < PROGRESS_EDIT_MS) return this.ackMessage;
    this.lastEdit = Date.now();
    const target = this.thread ?? this.message.channel;
    try {
      await this.ackMessage.edit({ content: clip(text, MAX_MESSAGE_CHARS) });
    } catch {
      /* progress edits are cosmetic */
    }
    return this.ackMessage;
  }
  async ack0() { return this.message.reply('â³ workingâ€¦'); }
  async send(text) {
    const chunks = chunkText(text);
    const target = this.thread ?? this.message.channel;
    for (const chunk of chunks) await target.send({ content: clip(chunk, MAX_MESSAGE_CHARS) });
  }
  async sendFile(text, name) {
    const target = this.thread ?? this.message.channel;
    await target.send({ files: [{ attachment: Buffer.from(text, 'utf8'), name }] });
  }
}

// ---------------------------------------------------------------------------
// Agent core â€” testable without Discord (io is the I/O adapter).
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
  if (!meta.ok) return `GitHub API ${meta.status} for ${slug} â€” does the repo exist?`;
  const repo = await meta.json();
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
      { role: 'user', content: `Repo: ${repo.full_name}\nDescription: ${repo.description ?? '(none)'}\nLanguage: ${repo.language ?? '?'}\nStars: ${repo.stargazers_count ?? '?'}\n\nREADME:\n${clip(readme, 6000)}` },
    ],
    { maxTokens: 700, temperature: 0.2 },
  );
  return `**${repo.full_name}** â€” â­ ${repo.stargazers_count ?? '?'} Â· ${repo.language ?? '?'}\n${repo.description ? `${repo.description}\n\n` : ''}${summary}\n${repo.html_url}`;
}

async function classify(text, contextTitle, chat) {

  const searchMatch = text.match(/^search\s+(.+)/i);
  if (searchMatch) return { action: 'search', argument: searchMatch[1] };
  if (/^(summarize|summarise|æ€»ç»“)\s*(this|it)?\s*[.!]?$/i.test(text)) return { action: 'summarize', argument: '' };
  if (looksLikeGithubRepo(text)) return { action: 'github', argument: text };

  const json = await chat(
    [
      {
        role: 'system',
        content:
          'You route messages for a research assistant. Reply ONLY with minified JSON: {"action":"fetch|summarize|ask|github|search|chat","argument":"..."}. '
          + 'Rules: "fetch" = the user wants a specific paper fetched/summarized (title, arXiv link or ID, DOI) â€” argument is the title/link. '
          + '"summarize" = user says summarize this/it referring to the last fetched paper â€” argument empty. '
          + '"github" = asks what a GitHub repo does or names a repo â€” argument is the repo slug or URL. '
          + '"ask" = a question about the daily digest corpus â€” argument is the question. '
          + '"search" = explicit corpus search â€” argument the keywords. '
          + '"chat" = anything else â€” argument the message.',
      },
      {
        role: 'user',
        content: `Context (last fetched paper title): ${contextTitle || '(none)'}\nMessage: ${clip(text, 500)}`,
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
  const route = await classify(text, io.contextTitle, chat);

  await io.ack(`â³ ${route.action}${route.argument ? `: ${clip(route.argument, 120)}` : ''}â€¦`);

  if (route.action === 'github') {
    const reply = await githubRepoSummary(route.argument || text, chat);
    await io.send(reply);
    return;
  }
  if (route.action === 'chat') {
    const reply = await chat(
      [
        { role: 'system', content: 'You are the DailyInfo assistant. The user has a daily research digest (papers, AI news, code, resources). Answer helpfully in English; if their message looks like a paper title, offer to fetch it.' },
        { role: 'user', content: text },
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
    await io.send(`âš ï¸ ${job.result}`);
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
      await agentHandle(text, io);
    } catch (error) {
      console.error(`[discord-agent] error: ${error.message}`);
      try { await message.reply({ content: clip(`âš ï¸ ${error.message}`, MAX_MESSAGE_CHARS) }); } catch { /* channel may be unusable */ }
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
