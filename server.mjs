// Serves the drill page and grades recordings. The Gemini key stays on the
// server; the browser only ever sends audio and receives a verdict.

import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { gradeAttempt } from "./lib/grading.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const publicDir = join(root, "public");
const phrases = JSON.parse(await readFile(join(root, "content", "phrases.json"), "utf8"));
const byId = new Map(phrases.map((p) => [p.id, p]));

// Set SAVE_RECORDINGS=<dir> to keep every graded attempt (audio plus verdict),
// for checking the grader against a real voice. Off by default.
const saveDir = process.env.SAVE_RECORDINGS;
if (saveDir) await mkdir(saveDir, { recursive: true });

const MAX_AUDIO_BYTES = 2 * 1024 * 1024; // ~60 s of 16 kHz mono; attempts are a few seconds
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".wav": "audio/wav",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
};

function send(res, status, body, type = "application/json") {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_AUDIO_BYTES) throw Object.assign(new Error("Recording too large"), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function grade(req, res, url) {
  const phrase = byId.get(url.searchParams.get("id"));
  if (!phrase) return send(res, 404, { error: "Unknown phrase" });
  const wav = await readBody(req);
  if (wav.length < 44 || wav.toString("ascii", 0, 4) !== "RIFF") return send(res, 400, { error: "Expected a WAV recording" });
  const started = Date.now();
  const result = await gradeAttempt(wav, phrase, phrases);
  if (saveDir) {
    const name = join(saveDir, `${new Date().toISOString().replace(/[:.]/g, "-")}_${phrase.id}_${result.verdict}`);
    await writeFile(`${name}.wav`, wav);
    await writeFile(`${name}.json`, JSON.stringify(result, null, 2));
  }
  send(res, 200, { ...result, ms: Date.now() - started });
}

async function serveStatic(res, pathname) {
  const rel = pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
  const file = normalize(join(publicDir, rel));
  if (!file.startsWith(publicDir + sep)) return send(res, 403, "Forbidden", "text/plain");
  try {
    const data = await readFile(file);
    const audio = extname(file) === ".wav";
    res.writeHead(200, {
      "Content-Type": TYPES[extname(file)] ?? "application/octet-stream",
      "Cache-Control": audio ? "public, max-age=86400" : "no-cache",
    });
    res.end(data);
  } catch {
    send(res, 404, "Not found", "text/plain");
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  try {
    if (url.pathname === "/api/lesson" && req.method === "GET") return send(res, 200, phrases);
    if (url.pathname === "/api/grade" && req.method === "POST") return await grade(req, res, url);
    if (req.method === "GET") return await serveStatic(res, url.pathname);
    send(res, 405, "Method not allowed", "text/plain");
  } catch (err) {
    console.error(err.message);
    send(res, err.status ?? 502, { error: err.status ? err.message : "Grading failed" });
  }
});

const port = Number(process.env.PORT ?? 8787);
server.listen(port, () => console.log(`Malayalam commute drill on http://localhost:${port}`));
