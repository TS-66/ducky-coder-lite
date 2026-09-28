/**
 * A static file server, for screenshots.
 *
 * The demo page loads the app bundle as an ES module, and Chromium refuses
 * `file://` module loads under CORS -- so a `file://` screenshot comes back
 * blank. Serving over HTTP is the fix.
 *
 *   node scripts/serve.mjs [port]
 *
 * Deliberately tiny: no dependency, no cache headers, no directory listing.
 * It is a test fixture, not a web server.
 */

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const DIST = join(ROOT, "dist");
const PORT = Number(process.argv[2] ?? 5199);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    // Resolve inside dist and refuse anything that climbs out of it.
    const rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
    let file = join(DIST, rel);
    if (rel === "/" || rel === "\\" || rel.endsWith("/")) file = join(file, "index.html");

    const body = await readFile(file);
    res.writeHead(200, {
      "content-type": TYPES[extname(file)] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`serving dist/ on http://127.0.0.1:${PORT}/`);
});
