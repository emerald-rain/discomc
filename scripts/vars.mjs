// [vars] from wrangler.toml, overridden by process.env.
import { readFileSync } from "node:fs";

const toml = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
const vars = Object.fromEntries([...toml.matchAll(/^(\w+)\s*=\s*"([^"]*)"/gm)].map((m) => [m[1], m[2]]));

export default { ...vars, ...process.env };
