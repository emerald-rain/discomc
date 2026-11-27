// Discord interactions endpoint (Cloudflare Worker, no libraries).
// Every command replies "thinking..." at once (Discord allows 3s), then does its work
// in ctx.waitUntil and edits that reply.

const json = (data, status = 200) => Response.json(data, { status });
const LABEL = "app=discomc"; // Hetzner label of our server

const commands = {
  start: async () => "Starting... (not wired yet)",
  stop: async () => "Stopping... (not wired yet)",
  status,
};

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

    const { type, data, token } = JSON.parse(body);
    if (type === 1) return json({ type: 1 }); // PING -> PONG

    const cmd = type === 2 && commands[data.options?.[0]?.name]; // /mc <sub>
    if (!cmd) return json({ type: 4, data: { content: "Unknown command.", flags: 64 } });

    ctx.waitUntil(
      cmd(env)
        .catch((e) => `Error: ${e.message}`)
        .then((content) => reply(env, token, content)),
    );
    return json({ type: 5 }); // DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE
  },
};

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
    .sort((a, b) => b.uploaded - a.uploaded)
    .slice(0, 10)
    .map((o) => `• \`${o.key}\` — ${size(o.size)} — ${o.uploaded.toISOString().slice(0, 16).replace("T", " ")}`);

  return [
    `**Server:** ${server}`,
    `**R2:** ${size(used)} in ${objects.length} file(s)`,
    backups.length ? backups.join("\n") : "No backups yet.",
  ].join("\n");
}

// Edit the deferred "thinking..." reply.
const reply = (env, token, content) =>
  fetch(`https://discord.com/api/v10/webhooks/${env.DISCORD_APP_ID}/${token}/messages/@original`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: content.slice(0, 2000) }),
  });

async function hetzner(env, path, init = {}) {
  const res = await fetch(`https://api.hetzner.cloud/v1${path}`, {
    ...init,
    headers: { authorization: `Bearer ${env.HETZNER_TOKEN}`, "content-type": "application/json" },
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`Hetzner ${res.status}: ${body.error?.message}`);
  return body;
}

async function listAll(bucket) {
  const out = [];
  let cursor;
  do {
    const page = await bucket.list({ cursor });
    out.push(...page.objects);
    cursor = page.truncated && page.cursor;
  } while (cursor);
  return out;
}

const size = (b) => (b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : `${(b / 1e6).toFixed(1)} MB`);

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
