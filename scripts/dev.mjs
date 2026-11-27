// Local dev: plain Node HTTP server in front of the Worker + cloudflared quick tunnel.
// Usage: node scripts/dev.mjs  (needs cloudflared in PATH or $CLOUDFLARED)
// Paste the printed trycloudflare.com URL into
// Discord Developer Portal -> General Information -> Interactions Endpoint URL.

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import worker from "../src/index.js";
import env from "./vars.mjs";

const port = Number(env.PORT ?? 8787);

createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const request = new Request(`http://localhost${req.url}`, {
    method: req.method,
    headers: req.headers,
    body: chunks.length ? Buffer.concat(chunks) : undefined,
  });
  try {
    const r = await worker.fetch(request, env);
    res.writeHead(r.status, Object.fromEntries(r.headers));
    res.end(Buffer.from(await r.arrayBuffer()));
  } catch (err) {
    console.error(err);
    res.writeHead(500).end();
  }
}).listen(port, () => {
  console.log(`listening on http://localhost:${port}`);
  if (process.argv.includes("--no-tunnel")) return;

  const tunnel = spawn(process.env.CLOUDFLARED ?? "cloudflared", ["tunnel", "--url", `http://localhost:${port}`]);
  tunnel.on("error", () => console.error("cloudflared not found (install it or set $CLOUDFLARED, or use --no-tunnel)"));
  tunnel.stderr.on("data", (d) => {
    const url = String(d).match(/https:\/\/\S+\.trycloudflare\.com/);
    if (url) console.log(`tunnel: ${url[0]}`);
  });
  process.on("exit", () => tunnel.kill());
  process.on("SIGINT", () => process.exit());
});
