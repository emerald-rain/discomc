// Discord interactions endpoint (Cloudflare Worker, no libraries).
// Every command replies "thinking..." at once (Discord allows 3s), then does its work
// in ctx.waitUntil and edits that reply. Long work runs on the server itself.

import cloudInit from "../server/cloud-init.yaml";
import compose from "../server/docker-compose.yml";

const LABEL = "app=discomc"; // Hetzner label of our server
const DOMAIN = "mc.knash.party";
const BACKUPS = "backups/";
const KEEP = 5; // backups to keep
const STOP = "state/stop"; // pending /mc stop: { url, server, at }, finished by the cron
const STOP_TIMEOUT = 15 * 60e3; // also the lifetime of the Discord reply token

const commands = { start, stop, status };

export default {
  async fetch(req, env, ctx) {
    if (req.method !== "POST") return new Response(null, { status: 405 });

    const body = await req.text();
    const ok = await verify(
      env.DISCORD_PUBLIC_KEY,
      req.headers.get("x-signature-ed25519"),
      req.headers.get("x-signature-timestamp") + body,
    );
    if (!ok) return new Response("bad signature", { status: 401 });

    const interaction = JSON.parse(body);
    if (interaction.type === 1) return Response.json({ type: 1 }); // PING -> PONG

    const sub = interaction.type === 2 && interaction.data.options?.[0]; // /mc <sub>
    const cmd = sub && commands[sub.name];
    if (!cmd) return Response.json({ type: 4, data: { content: "Unknown command.", flags: 64 } });

    const opts = Object.fromEntries((sub.options ?? []).map((o) => [o.name, o.value]));
    const url = messageUrl(env, interaction.token);
    ctx.waitUntil(
      cmd(env, opts, url)
        .catch((e) => `Error: ${e.message}`)
        .then((content) => edit(url, content)),
    );
    return Response.json({ type: 5 }); // DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE
  },

  // Every minute: finish a pending /mc stop once the server has powered off.
  async scheduled(_, env) {
    const obj = await env.WORLD.get(STOP);
    if (!obj) return;
    const { url, server, at } = await obj.json();
    const done = (content) => Promise.all([edit(url, content), env.WORLD.delete(STOP)]);
    try {
      const msg = await finishStop(env, server, at);
      if (msg) await done(msg);
    } catch (e) {
      await done(`Error: ${e.message}`);
    }
  },
};

// --- Commands ---------------------------------------------------------------

async function start(env, { type = "cx23", location = "hel1" }, url) {
  const { servers } = await hetzner(env, `/servers?label_selector=${LABEL}`);
  if (servers.length) return `Server already exists (${servers[0].status}).`;

  const backup = latest(await listAll(env.WORLD, BACKUPS));
  const mcEnv = [
    `BACKUP=${backup?.key ?? ""}`,
    `DISCORD_MESSAGE=${url}`, // the server edits this reply when Minecraft is up
    "RCLONE_CONFIG_R2_TYPE=s3",
    "RCLONE_CONFIG_R2_PROVIDER=Cloudflare",
    `RCLONE_CONFIG_R2_ACCESS_KEY_ID=${env.R2_ACCESS_KEY_ID}`,
    `RCLONE_CONFIG_R2_SECRET_ACCESS_KEY=${env.R2_SECRET_ACCESS_KEY}`,
    `RCLONE_CONFIG_R2_ENDPOINT=https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    "RCLONE_CONFIG_R2_NO_CHECK_BUCKET=true",
  ].join("\n");

  const { server } = await hetzner(env, "/servers", {
    method: "POST",
    body: JSON.stringify({
      name: "mc",
      server_type: type,
      location,
      image: "debian-13",
      labels: { app: "discomc" },
      ssh_keys: env.HETZNER_SSH_KEY ? [env.HETZNER_SSH_KEY] : [], // a key here avoids the root password email
      user_data: cloudInit.replace("__MC_ENV__", b64(mcEnv + "\n")).replace("__COMPOSE__", b64(compose)),
    }),
  });
  await setDns(env, server.public_net.ipv4.ip);

  const world = backup ? `restoring \`${backup.key}\` (${size(backup.size)})` : "fresh world";
  return `Starting ${type} in ${location}, ${world}... This message updates when the server is online.`;
}

// ACPI shutdown; the server backs itself up while shutting down (mc-backup.service).
async function stop(env, _, url) {
  const { servers } = await hetzner(env, `/servers?label_selector=${LABEL}`);
  const s = servers[0];
  if (!s) return "No server is running.";
  if (await env.WORLD.head(STOP)) return "Already stopping.";

  await env.WORLD.put(STOP, JSON.stringify({ url, server: s.id, at: Date.now() }));
  if (s.status !== "off") await hetzner(env, `/servers/${s.id}/actions/shutdown`, { method: "POST" });
  return "Stopping: saving the world to R2... This message updates when done.";
}

// Returns the final message, or nothing to check again next minute.
async function finishStop(env, id, at) {
  const { server } = await hetzner(env, `/servers/${id}`);
  if (server.status !== "off") {
    if (Date.now() - at > STOP_TIMEOUT) return `Error: server is still ${server.status} after 15 min.`;
    return;
  }

  const backups = (await listAll(env.WORLD, BACKUPS)).sort((a, b) => b.uploaded - a.uploaded);
  const fresh = backups[0]?.uploaded > at && backups[0];
  if (!fresh) return "Error: server is off but no new backup in R2. Server kept, check it.";

  await hetzner(env, `/servers/${id}`, { method: "DELETE" });
  const old = backups.slice(KEEP).map((o) => o.key);
  if (old.length) await env.WORLD.delete(old);
  return `Saved \`${fresh.key}\` (${size(fresh.size)}). Server deleted.`;
}

async function status(env) {
  const [{ servers }, objects] = await Promise.all([
    hetzner(env, `/servers?label_selector=${LABEL}`),
    listAll(env.WORLD),
  ]);

  const s = servers[0];
  const server = !s
    ? "offline"
    : s.status === "running"
      ? `online — ${s.public_net.ipv4.ip} (${s.server_type.name}, ${s.datacenter.location.name})`
      : s.status; // initializing, starting, stopping, off, ...

  const used = objects.reduce((sum, o) => sum + o.size, 0);
  const backups = objects
    .filter((o) => o.key.startsWith(BACKUPS))
    .sort((a, b) => b.uploaded - a.uploaded)
    .slice(0, 10)
    .map((o) => `• \`${o.key}\` — ${size(o.size)} — ${o.uploaded.toISOString().slice(0, 16).replace("T", " ")}`);

  return [
    `**Server:** ${server}`,
    `**R2:** ${size(used)} in ${objects.length} file(s)`,
    backups.length ? backups.join("\n") : "No backups yet.",
  ].join("\n");
}

// --- APIs -------------------------------------------------------------------

const messageUrl = (env, token) =>
  `https://discord.com/api/v10/webhooks/${env.DISCORD_APP_ID}/${token}/messages/@original`;

const edit = (url, content) =>
  fetch(url, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: content.slice(0, 2000) }),
  });

async function api(url, token, init = {}) {
  const res = await fetch(url, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  });
  const body = await res.json();
  if (!res.ok) {
    const msg = body.error?.message ?? body.errors?.[0]?.message ?? "unknown error";
    throw new Error(`${new URL(url).hostname} ${res.status}: ${msg}`);
  }
  return body;
}

const hetzner = (env, path, init) => api(`https://api.hetzner.cloud/v1${path}`, env.HETZNER_TOKEN, init);

// Point DOMAIN at ip (DNS only: Cloudflare's proxy does not carry Minecraft traffic).
async function setDns(env, ip) {
  const base = `https://api.cloudflare.com/client/v4/zones/${env.CF_ZONE_ID}/dns_records`;
  const { result } = await api(`${base}?type=A&name=${DOMAIN}`, env.CF_DNS_TOKEN);
  const record = JSON.stringify({ type: "A", name: DOMAIN, content: ip, ttl: 60, proxied: false });
  const id = result[0]?.id;
  await api(id ? `${base}/${id}` : base, env.CF_DNS_TOKEN, { method: id ? "PUT" : "POST", body: record });
}

async function listAll(bucket, prefix) {
  const out = [];
  let cursor;
  do {
    const page = await bucket.list({ prefix, cursor });
    out.push(...page.objects);
    cursor = page.truncated && page.cursor;
  } while (cursor);
  return out;
}

// --- Helpers ----------------------------------------------------------------

const latest = (objects) => objects.sort((a, b) => b.uploaded - a.uploaded)[0];
const size = (b) => (b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : `${(b / 1e6).toFixed(1)} MB`);
const b64 = (s) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));

async function verify(keyHex, sigHex, message) {
  if (!keyHex || !sigHex) return false;
  try {
    const key = await crypto.subtle.importKey("raw", hex(keyHex), "Ed25519", false, ["verify"]);
    return await crypto.subtle.verify("Ed25519", key, hex(sigHex), new TextEncoder().encode(message));
  } catch {
    return false;
  }
}

const hex = (s) => Uint8Array.from(s.match(/../g), (b) => parseInt(b, 16));
