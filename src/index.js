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
const PANEL = "state/panel"; // { channel, message }
const STOP = "state/stop"; // pending stop: { at }
const VM = "state/vm"; // written by the server: online | error: ... | saving | saved
const NOTE = "state/note"; // last error, shown on the panel until the next click
const LAST = "state/last"; // last drawn panel, to skip identical edits

const LOCATIONS = { hel1: "Helsinki", nbg1: "Nuremberg", fsn1: "Falkenstein" };
// Tried in order; the first one Hetzner has in stock is used.
const CHOICES = [
  ["cx23", "hel1"],
  ["cx23", "nbg1"],
  ["cx23", "fsn1"],
  ["cpx12", "hel1"],
];
const actions = { start, stop, remove };

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

    // Button on the panel.
    if (interaction.type === 3) {
      const id = interaction.data.custom_id;
      ctx.waitUntil(
        del(env, NOTE)
          .then(() => actions[id]?.(env, { origin }))
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
  const [type, location] = await pick(env);
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
    "RCLONE_CONFIG_R2_NO_HEAD=true", // R2 has no HEAD ?versionId=, which rclone runs after small uploads
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

// First [type, location] from CHOICES that is available now (read-only API calls).
async function pick(env) {
  const [{ datacenters }, { server_types }] = await Promise.all([
    hetzner(env, "/datacenters"),
    hetzner(env, "/server_types?per_page=50"),
  ]);
  const ids = Object.fromEntries(server_types.map((t) => [t.name, t.id]));
  const found = CHOICES.find(([type, loc]) =>
    datacenters.some((d) => d.location.name === loc && d.server_types.available.includes(ids[type])),
  );
  if (!found) throw new Error("No server available right now (cx23 anywhere, cpx12 in Helsinki).");
  return found;
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
  const body = JSON.stringify(await view(env));
  const msg = await discord(env, `/channels/${channel}/messages`, { method: "POST", body });
  await Promise.all([put(env, PANEL, JSON.stringify({ channel, message: msg.id })), put(env, LAST, body)]);
  if (old) await discord(env, `/channels/${old.channel}/messages/${old.message}`, { method: "DELETE" }).catch(() => {});
}

async function refresh(env) {
  const panel = await json(env, PANEL);
  if (!panel) return;
  const body = JSON.stringify(await view(env));
  if (body === (await get(env, LAST))) return;
  await discord(env, `/channels/${panel.channel}/messages/${panel.message}`, { method: "PATCH", body });
  await put(env, LAST, body);
}

// Panel look. Icons can be custom emoji: "<:name:id>".
const ICONS = { offline: "⚫", starting: "🟡", online: "🟢", stopping: "🟡", problem: "🔴", note: "⚠️" };
const COLORS = { offline: 0x747f8d, starting: 0xfaa61a, online: 0x3ba55c, stopping: 0xfaa61a, problem: 0xed4245 };
const V2 = 1 << 15; // IS_COMPONENTS_V2 message flag

// Panel message for the current state: one container whose stripe color shows the state.
// Times use Discord <t:..> tags, so they tick without edits.
async function view(env) {
  const [[s], objects, pending, vm, note] = await Promise.all([
    servers(env),
    listAll(env.WORLD),
    env.WORLD.head(STOP),
    get(env, VM),
    get(env, NOTE),
  ]);

  let state, title, lines, buttons = [];
  const problem = (text) => {
    [state, title, lines] = ["problem", "Problem", [text]];
    buttons = [
      ...(s.status === "running" ? [button("stop", "Stop and save", 1)] : []),
      button("remove", "Delete without saving", 4),
    ];
  };

  if (!s) {
    const next = await pick(env).catch(() => null);
    [state, title] = ["offline", "Offline"];
    lines = [next ? `Next start: ${next[0]} · ${LOCATIONS[next[1]]}` : "No server available at Hetzner right now."];
    buttons = [button("start", "Start", 3)];
  } else {
    const where = `${s.server_type.name} · ${LOCATIONS[s.location.name] ?? s.location.name}`;
    const since = `<t:${Math.floor(Date.parse(s.created) / 1000)}:R>`;
    if (s.status === "off" && !pending) problem("Server is off but has no new backup.");
    else if (pending || vm === "saving" || vm === "saved") {
      [state, title] = ["stopping", "Stopping"];
      lines = [vm === "saved" ? "World saved, powering off…" : "Saving the world…"];
    } else if (vm?.startsWith("error")) problem(vm.replace(/^error: */, ""));
    else if (s.status === "running" && vm === "online") {
      [state, title] = ["online", "Online"];
      lines = [`\`\`\`${DOMAIN}\`\`\``, `${where} · up since ${since} · ${cost(s)} so far`];
      buttons = [button("stop", "Stop", 4)];
    } else if (Date.now() - Date.parse(s.created) > START_TIMEOUT) problem("Not online after 20 min.");
    else {
      [state, title] = ["starting", "Starting"];
      lines = [`${where} · created ${since}`, "Takes a few minutes."];
    }
  }

  const backups = objects.filter((o) => o.key.startsWith(BACKUPS)).sort((a, b) => b.uploaded - a.uploaded);
  const used = objects.reduce((sum, o) => sum + o.size, 0);
  const last = backups[0];
  const saves = last
    ? `-# Last save <t:${Math.floor(last.uploaded / 1000)}:f> (${size(last.size)}) · ${backups.length} backup(s) · ${size(used)} in R2`
    : "-# No backups yet: Start makes a fresh world.";

  const parts = [
    text(`## ${ICONS[state]} ${title}\n${lines.join("\n")}`),
    note && text(`${ICONS.note} ${note}`),
    { type: 14 }, // separator
    text(saves),
    buttons.length && { type: 1, components: buttons },
  ].filter(Boolean);
  return { flags: V2, components: [{ type: 17, accent_color: COLORS[state], components: parts }] };
}

const text = (content) => ({ type: 10, content });
const button = (custom_id, label, style) => ({ type: 2, custom_id, label, style });

// Hetzner bills every started hour, at the gross hourly price of the server's location.
function cost(s) {
  const price = s.server_type.prices?.find((p) => p.location === s.location.name)?.price_hourly.gross;
  if (!price) return "€?";
  const hours = Math.ceil((Date.now() - Date.parse(s.created)) / 3600e3);
  return `€${(hours * price).toFixed(2)}`;
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
