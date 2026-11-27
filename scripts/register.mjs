// Registers the /mc command. Usage: node scripts/register.mjs
// Runs as the Cloudflare build command; locally reads .env if present.
// Without DISCORD_GUILD_ID registers globally (up to 1h to appear).

import { readFileSync } from "node:fs";

try { process.loadEnvFile(new URL("../.env", import.meta.url)); } catch {}
// Fallback: non-secret IDs from [vars] in wrangler.toml.
const toml = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
const fromToml = (k) => toml.match(new RegExp(`^${k}\\s*=\\s*"([^"]*)"`, "m"))?.[1];
const app = process.env.DISCORD_APP_ID ?? fromToml("DISCORD_APP_ID");
const guild = process.env.DISCORD_GUILD_ID ?? fromToml("DISCORD_GUILD_ID");
const token = process.env.DISCORD_BOT_TOKEN;
if (!app || !token) throw new Error("DISCORD_APP_ID and DISCORD_BOT_TOKEN are required");

const sub = (name, description) => ({ type: 1, name, description });

const commands = [
  {
    name: "mc",
    description: "Minecraft server control",
    contexts: [0], // guild only
    default_member_permissions: "0", // admins only; remove to allow everyone
    options: [
      sub("start", "Start the server"),
      sub("stop", "Stop the server"),
      sub("status", "Show server status"),
    ],
  },
];

const url = `https://discord.com/api/v10/applications/${app}${guild ? `/guilds/${guild}` : ""}/commands`;
const res = await fetch(url, {
  method: "PUT",
  headers: { authorization: `Bot ${token}`, "content-type": "application/json" },
  body: JSON.stringify(commands),
});
console.log(res.status, await res.text());
if (!res.ok) process.exit(1);
