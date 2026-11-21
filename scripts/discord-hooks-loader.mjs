/**
 * Loader hook: patches the `ws` package so every WebSocket it creates uses
 * the HTTPS_PROXY agent. discord.js's gateway relies on the `ws` package,
 * which ignores env proxies and the global dispatcher — without this hook
 * the gateway connection cannot leave the network.
 */
let seen = 0;

export async function load(url, context, nextLoad) {
  if ((seen = seen + 1) < 4) {
    console.log(`[discord-hooks] load: ${url.slice(0, 100)} (${context.format ?? '?'})`);
  }
  const result = await nextLoad(url, context);
  if (url.endsWith('/node_modules/ws/index.js') && result.format === 'commonjs') {
    console.log('[discord-hooks] patching ws module — agent:', process.env.HTTPS_PROXY ?? 'NOT SET');
    const patch = `
;(function () {
  try {
    if (module.exports.__dailyInfoAgentPatched) return;
    const { HttpsProxyAgent } = require('https-proxy-agent');
    const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || 'http://127.0.0.1:7890';
    const agent = new HttpsProxyAgent(proxy);
    const Original = module.exports;
    class PatchedWebSocket extends Original {
      constructor(address, protocols, options) {
        super(address, protocols, { ...options, agent });
      }
    }
    Object.setPrototypeOf(PatchedWebSocket, Original);
    module.exports = PatchedWebSocket;
    module.exports.__dailyInfoAgentPatched = true;
  } catch (error) {
    console.error('[discord-hooks] ws patch failed:', error.message);
  }
})();`;
    return { ...result, source: `${result.source}${patch}` };
  }
  return result;
}
