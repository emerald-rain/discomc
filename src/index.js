// Discord interactions endpoint (Cloudflare Worker, no libraries).
// Backend is stubbed for now.

const json = (data, status = 200) => Response.json(data, { status });
const msg = (content, ephemeral) => ({
  type: 4, // CHANNEL_MESSAGE_WITH_SOURCE
  data: { content, flags: ephemeral ? 64 : 0 },
});

const commands = {
  start: () => msg("Starting... (backend not wired yet)"),
  stop: () => msg("Stopping... (backend not wired yet)"),
  status: () => msg("Server: offline (backend not wired yet)"),
};

export default {
  async fetch(req, env) {
    if (req.method !== "POST") return new Response(null, { status: 405 });

    const body = await req.text();
    const ok = await verify(
      env.DISCORD_PUBLIC_KEY,
      req.headers.get("x-signature-ed25519"),
      req.headers.get("x-signature-timestamp") + body,
    );
    if (!ok) return new Response("bad signature", { status: 401 });

    const { type, data } = JSON.parse(body);
    if (type === 1) return json({ type: 1 }); // PING -> PONG

    const handler = type === 2 && commands[data.options?.[0]?.name]; // /mc <sub>
    return json(handler ? handler() : msg("Unknown command.", true));
  },
};

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
