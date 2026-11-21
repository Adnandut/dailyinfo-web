console.log("[discord-hooks] registering loader hook");
/**
 * Registers the ws-proxy loader hook. Loaded via `--import` BEFORE the app,
 * so the patch applies before discord.js imports the `ws` package.
 */
import { register } from 'node:module';

register('./discord-hooks-loader.mjs', import.meta.url);
