// Registers the /mc command. Runs as the Cloudflare build command.
// Locally: DISCORD_BOT_TOKEN=... node scripts/register.mjs
// Without DISCORD_GUILD_ID registers globally (up to 1h to appear).

import env from "./vars.mjs";

const { DISCORD_APP_ID: app, DISCORD_GUILD_ID: guild, DISCORD_BOT_TOKEN: token } = env;
if (!app) throw new Error("DISCORD_APP_ID is missing (wrangler.toml [vars])");
if (!token) throw new Error("DISCORD_BOT_TOKEN is missing (Cloudflare: Settings -> Build -> Variables and secrets)");

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
