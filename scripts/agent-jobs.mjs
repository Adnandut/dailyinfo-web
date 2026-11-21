/**
 * Shared job runner for the agent front-ends (web UI + Discord bot).
 *
 * One command at a time; console output is captured per job so front-ends can
 * stream progress. The bot module is imported FRESH per job (query-string
 * import busts the module cache) so code updates and newly synced corpus
 * days apply without restarting the front-end.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');

export function createJobRunner() {
  const jobs = new Map();
  let counter = 0;
  let active = null;
  const queue = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);

  function routed(original, ...args) {
    if (active) active.log.push(String(args[0] ?? ''));
    original(...args);
  }

  function loadBot() {
    return import(`./dailyinfo-bot.mjs?ts=${Date.now()}`);
  }

  /** Submit a command; returns the job object (log/status/result) and a
   * `done` promise that resolves with the finished job. */
  function submit(command) {
    const job = { id: ++counter, command, status: 'running', log: [], result: '', done: null };
    job.done = new Promise((resolve) => { job._resolve = resolve; });
    jobs.set(job.id, job);
    queue.push(job);
    pump();
    return job;
  }

  function pump() {
    if (active || !queue.length) return;
    active = queue.shift();
    process.stdout.write = (...args) => routed(origOut, ...args);
    process.stderr.write = (...args) => routed(origErr, ...args);
    setTimeout(async () => {
      try {
        const bot = await loadBot();
        const corpus = { items: bot.loadItems(), briefings: bot.loadBriefings() };
        await bot.runCommand(corpus, active.command);
        active.status = 'done';
      } catch (error) {
        active.status = 'error';
        active.result = error.message;
      } finally {
        origOut(`[jobs] job ${active.id} ${active.status}\n`);
        process.stdout.write = origOut;
        process.stderr.write = origErr;
        const finished = active;
        active = null;
        finished._resolve(finished);
        pump();
      }
    }, 30);
  }

  return {
    submit,
    get: (id) => jobs.get(id),
    busy: () => Boolean(active) || queue.length > 0,
  };
}
