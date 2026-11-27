// Discord interactions endpoint (Cloudflare Worker, no libraries).
// The bot is one panel message with buttons (posted by /mc panel). It is redrawn from the
// real state (Hetzner + R2) after every click, every minute by the cron, and whenever the
// server calls POST /refresh (Minecraft online, backup started/saved). Long work runs on the
// server itself.

import cloudInit from "../server/cloud-init.yaml";
import compose from "../server/docker-compose.yml";

const LABEL = "app=discomc"; // Hetzner label of our server
const DOMAIN = "mc.knash.party";
const BACKUPS = "backups/";
const KEEP = 5; // backups to keep
const STOP_TIMEOUT = 15 * 60e3;
const START_TIMEOUT = 20 * 60e3;

// State in R2
const PANEL = "state/panel"; // { channel, message, type, location }
const STOP = "state/stop"; // pending stop: { at }
const VM = "state/vm"; // written by the server: online | error: ... | saving | saved
const NOTE = "state/note"; // last error, shown on the panel until the next click
const LAST = "state/last"; // last drawn panel, to skip identical edits

const TYPES = { cx23: "cx23", cpx12: "cpx12" };
const LOCATIONS = { hel1: "Helsinki", nbg1: "Nuremberg", fsn1: "Falkenstein" };
const actions = { start, stop, remove, type: choose, location: choose };

export default {
  async fetch(req, env, ctx) {
    if (req.method !== "POST") return new Response(null, { status: 405 });
    const { origin, pathname } = new URL(req.url);

    // The server reports a state change. No auth needed: it only redraws from the real state.
    if (pathname === "/refresh") {
      ctx.waitUntil(settle(env).catch(console.error));
      return new Response(null, { status: 204 });
    }

    const body = await req.text();
    const ok = await verify(
      env.DISCORD_PUBLIC_KEY,
      req.headers.get("x-signature-ed25519"),
      req.headers.get("x-signature-timestamp") + body,
    );
    if (!ok) return new Response("bad signature", { status: 401 });

    const interaction = JSON.parse(body);
    if (interaction.type === 1) return Response.json({ type: 1 }); // PING -> PONG

    // /mc panel: post the panel in this channel, answer privately.
    if (interaction.type === 2) {
      const url = messageUrl(env, interaction.token);
      ctx.waitUntil(
        postPanel(env, interaction.channel_id)
          .then(() => "Panel posted.", (e) => `Error: ${e.message}`)
          .then((content) => edit(url, content)),
      );
      return Response.json({ type: 5, data: { flags: 64 } }); // deferred, ephemeral
    }

    // Button or select on the panel.
    if (interaction.type === 3) {
      const { custom_id: id, values } = interaction.data;
      ctx.waitUntil(
        del(env, NOTE)
          .then(() => actions[id]?.(env, { id, value: values?.[0], origin }))
          .catch((e) => put(env, NOTE, e.message))
          .then(() => refresh(env))
          .catch(console.error),
      );
      return Response.json({ type: 6 }); // DEFERRED_UPDATE_MESSAGE
    }

    return Response.json({ type: 4, data: { content: "Unknown interaction.", flags: 64 } });
  },

  async scheduled(_, env) {
    await tick(env);
    await refresh(env);
  },
};

// --- Actions ----------------------------------------------------------------

async function start(env, { origin }) {
  if ((await servers(env)).length) throw new Error("Server already exists.");
  const { type = "cx23", location = "hel1" } = (await json(env, PANEL)) ?? {};
  await del(env, VM);

  const backup = latest(await listAll(env.WORLD, BACKUPS));
  const mcEnv = [
    `BACKUP=${backup?.key ?? ""}`,
    `WORKER=${origin}`, // the server calls $WORKER/refresh on state changes
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
}

// ACPI shutdown; the server backs itself up while shutting down (mc-backup.service).
async function stop(env) {
  const [s] = await servers(env);
  if (!s || (await env.WORLD.head(STOP))) return;
  await put(env, STOP, JSON.stringify({ at: Date.now() }));
  if (s.status !== "off") await hetzner(env, `/servers/${s.id}/actions/shutdown`, { method: "POST" });
}

// Delete without saving. Only offered when something went wrong.
async function remove(env) {
  const [s] = await servers(env);
  if (s) await hetzner(env, `/servers/${s.id}`, { method: "DELETE" });
  await Promise.all([del(env, VM), del(env, STOP)]);
}

// Server type / location select.
async function choose(env, { id, value }) {
  const panel = await json(env, PANEL);
  const options = id === "type" ? TYPES : LOCATIONS;
  if (panel && value in options) await put(env, PANEL, JSON.stringify({ ...panel, [id]: value }));
}

// --- Stop handling ----------------------------------------------------------

// Delete a server that has powered off with a fresh backup (after Stop, the idle timer or
// a poweroff from the Hetzner panel). Returns true while a saved server is still shutting down.
async function tick(env) {
  const [[s], pending, vm] = await Promise.all([servers(env), json(env, STOP), get(env, VM)]);
  if (!s) {
    if (pending) await del(env, STOP);
    return false;
  }

  if (s.status !== "off") {
    if (pending && Date.now() - pending.at > STOP_TIMEOUT) {
      await Promise.all([put(env, NOTE, `Server is still ${s.status} 15 min after Stop.`), del(env, STOP)]);
    }
    return vm === "saved";
  }

  try {
    await finish(env, s, pending?.at ?? Date.parse(s.created)); // a backup counts if newer than this
  } catch (e) {
    console.log(e.message);
    if (pending) await put(env, NOTE, e.message);
  }
  if (pending) await del(env, STOP);
  return false;
}

async function finish(env, s, at) {
  const backups = (await listAll(env.WORLD, BACKUPS)).sort((a, b) => b.uploaded - a.uploaded);
  if (!(backups[0]?.uploaded > at)) throw new Error("Server is off but there is no new backup in R2. Server kept.");

  await hetzner(env, `/servers/${s.id}`, { method: "DELETE" });
  const old = backups.slice(KEEP).map((o) => o.key);
  if (old.length) await env.WORLD.delete(old);
  await del(env, VM);
}

// After a server report: redraw, and if the backup is saved, keep checking for a few
// seconds until the server is off, so the panel shows "Offline" right away.
async function settle(env) {
  for (let i = 0; i < 8 && (await tick(env)); i++) {
    await refresh(env);
    await sleep(3000);
  }
  await refresh(env);
}

// --- Panel ------------------------------------------------------------------

async function postPanel(env, channel) {
  const old = await json(env, PANEL);
  const panel = { channel, type: old?.type ?? "cx23", location: old?.location ?? "hel1" };
  const body = JSON.stringify(await view(env, panel));
  const msg = await discord(env, `/channels/${channel}/messages`, { method: "POST", body });
  await Promise.all([put(env, PANEL, JSON.stringify({ ...panel, message: msg.id })), put(env, LAST, body)]);
  if (old) await discord(env, `/channels/${old.channel}/messages/${old.message}`, { method: "DELETE" }).catch(() => {});
}

async function refresh(env) {
  const panel = await json(env, PANEL);
  if (!panel) return;
  const body = JSON.stringify(await view(env, panel));
  if (body === (await get(env, LAST))) return;
  await discord(env, `/channels/${panel.channel}/messages/${panel.message}`, { method: "PATCH", body });
  await put(env, LAST, body);
}

// Panel message (content + components) for the current state.
async function view(env, panel) {
  const [[s], objects, pending, vm, note] = await Promise.all([
    servers(env),
    listAll(env.WORLD),
    env.WORLD.head(STOP),
    get(env, VM),
    get(env, NOTE),
  ]);

  let line;
  let buttons = [];
  const problem = (text) => {
    line = `🔴 **Problem:** ${text}`;
    buttons = [
      ...(s.status === "running" ? [button("stop", "Stop and save", 1)] : []),
      button("remove", "Delete without saving", 4),
    ];
  };
  const where = s && `${s.server_type.name}, ${LOCATIONS[s.location.name] ?? s.location.name}`;

  if (!s) {
    line = "⚫ **Offline**";
    buttons = [button("start", "Start", 3)];
  } else if (s.status === "off" && !pending) problem("server is off but has no new backup.");
  else if (pending || vm === "saving" || vm === "saved") {
    line = `🟡 **Stopping…** ${vm === "saved" ? "world saved, powering off" : "saving the world"}`;
  } else if (vm?.startsWith("error")) problem(vm.replace(/^error: */, ""));
  else if (s.status === "running" && vm === "online") {
    line = `🟢 **Online** — \`${DOMAIN}\` (${where})`;
    buttons = [button("stop", "Stop", 4)];
  } else if (Date.now() - Date.parse(s.created) > START_TIMEOUT) problem("not online after 20 min.");
  else line = `🟡 **Starting…** ${where}, takes a few minutes`;

  const backups = objects.filter((o) => o.key.startsWith(BACKUPS)).sort((a, b) => b.uploaded - a.uploaded);
  const used = objects.reduce((sum, o) => sum + o.size, 0);
  const last = backups[0];
  const info = last
    ? `Last save: <t:${Math.floor(last.uploaded / 1000)}:f> (${size(last.size)}) · ${backups.length} backup(s), ${size(used)} in R2`
    : "No backups yet: Start makes a fresh world.";

  const rows = [];
  if (!s) rows.push(select("type", TYPES, panel.type), select("location", LOCATIONS, panel.location));
  if (buttons.length) rows.push({ type: 1, components: buttons });
  return { content: [line, info, note && `⚠️ ${note}`].filter(Boolean).join("\n"), components: rows };
}

const button = (custom_id, label, style) => ({ type: 2, custom_id, label, style });
const select = (custom_id, options, current) => ({
  type: 1,
  components: [
    {
      type: 3,
      custom_id,
      options: Object.entries(options).map(([value, label]) => ({ label, value, default: value === current })),
    },
  ],
});

// --- APIs -------------------------------------------------------------------

const messageUrl = (env, token) =>
  `https://discord.com/api/v10/webhooks/${env.DISCORD_APP_ID}/${token}/messages/@original`;

const edit = (url, content) =>
  fetch(url, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: content.slice(0, 2000) }),
  });

async function api(url, authorization, init = {}) {
  const res = await fetch(url, { ...init, headers: { authorization, "content-type": "application/json" } });
  const body = res.status === 204 ? null : await res.json();
  if (!res.ok) {
    const msg = body?.error?.message ?? body?.errors?.[0]?.message ?? body?.message ?? "unknown error";
    throw new Error(`${new URL(url).hostname} ${res.status}: ${msg}`);
  }
  return body;
}

const hetzner = (env, path, init) => api(`https://api.hetzner.cloud/v1${path}`, `Bearer ${env.HETZNER_TOKEN}`, init);
const discord = (env, path, init) => api(`https://discord.com/api/v10${path}`, `Bot ${env.DISCORD_BOT_TOKEN}`, init);
const servers = async (env) => (await hetzner(env, `/servers?label_selector=${LABEL}`)).servers;

// Point DOMAIN at ip (DNS only: Cloudflare's proxy does not carry Minecraft traffic).
async function setDns(env, ip) {
  const base = `https://api.cloudflare.com/client/v4/zones/${env.CF_ZONE_ID}/dns_records`;
  const auth = `Bearer ${env.CF_DNS_TOKEN}`;
  const { result } = await api(`${base}?type=A&name=${DOMAIN}`, auth);
  const record = JSON.stringify({ type: "A", name: DOMAIN, content: ip, ttl: 60, proxied: false });
  const id = result[0]?.id;
  await api(id ? `${base}/${id}` : base, auth, { method: id ? "PUT" : "POST", body: record });
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

const get = async (env, key) => (await env.WORLD.get(key))?.text();
const json = async (env, key) => JSON.parse((await get(env, key)) ?? "null");
const put = (env, key, value) => env.WORLD.put(key, value);
const del = (env, key) => env.WORLD.delete(key);

// --- Helpers ----------------------------------------------------------------

const latest = (objects) => objects.sort((a, b) => b.uploaded - a.uploaded)[0];
const size = (b) => (b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : `${(b / 1e6).toFixed(1)} MB`);
const b64 = (s) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
