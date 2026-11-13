#!/usr/bin/env node
// Browser check of conversation mode against a stand-in for the Gemini Live
// API. The stand-in speaks the documented message format, so this covers the
// page's side of the protocol: setup, playing the tutor's audio, keeping the
// microphone closed while the tutor speaks, streaming the learner's speech,
// transcripts, and resuming on a new connection when told the old one is ending.
//
// It does NOT show that the real service behaves this way or that the tutor
// speaks good Malayalam; only a session against the real API can.
//
// Starts its own app server; needs the Gemini key because tokens are still
// minted for real.

import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { WebSocketServer } from "ws";

const { chromium } = createRequire(import.meta.url)("playwright");
const MOCK_PORT = 8799, APP_PORT = 8788;
const base = `http://localhost:${APP_PORT}`;

const clip = async (id) => (await readFile(new URL(`../public/audio/ml/${id}.wav`, import.meta.url))).subarray(44); // 24 kHz PCM
const tutorClips = [await clip("amma-well"), await clip("amma-eat")];
const TUTOR_LINES = ["സുഖമാണോ?", "ചോറുണ്ടോ?"];
const LEARNER_LINE = "എനിക്ക് സുഖമാണ്";

// ---------- stand-in Live API ----------

const log = []; // everything the stand-in saw, in order
const note = (type, more = {}) => log.push({ type, ...more });
const wss = new WebSocketServer({ port: MOCK_PORT });
let connections = 0;

wss.on("connection", (socket, req) => {
  const n = ++connections;
  note("connect", { n, hasToken: new URL(req.url, "ws://x").searchParams.has("access_token") });
  let turns = 0, speechMs = 0, quietMs = 0, tutorFrom = 0, tutorUntil = 0;
  // The real service sends JSON in binary frames; send both kinds.
  const send = (message, binary = true) => socket.send(Buffer.from(JSON.stringify(message)), { binary });

  function tutorTurn() {
    const pcm = tutorClips[turns], text = TUTOR_LINES[turns++];
    tutorFrom = Date.now();
    tutorUntil = tutorFrom + (pcm.length / 2 / 24000) * 1000;
    send({ serverContent: { outputTranscription: { text } } });
    for (let i = 0; i < pcm.length; i += 9600) {
      const data = pcm.subarray(i, i + 9600).toString("base64");
      send({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data } }] } } });
    }
    send({ serverContent: { generationComplete: true } });
    send({ serverContent: { turnComplete: true } });
  }

  socket.on("message", (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.setup) {
      note("setup", { n });
      send({ setupComplete: {} });
      send({ sessionResumptionUpdate: { newHandle: `handle-${n}`, resumable: true } }, false);
      return;
    }
    const input = message.realtimeInput ?? {};
    if (input.text) { note("text", { n }); tutorTurn(); }
    if (input.audioStreamEnd) note("streamEnd", { n });
    if (input.audio) {
      const pcm = Buffer.from(input.audio.data, "base64");
      let sum = 0;
      for (let i = 0; i + 1 < pcm.length; i += 2) sum += (pcm.readInt16LE(i) / 32768) ** 2;
      const rms = Math.sqrt(sum / (pcm.length / 2)), ms = pcm.length / 2 / 16;
      const t = Date.now();
      note("audio", { n, mime: input.audio.mimeType, ms, loud: rms > 0.02, duringTutor: t > tutorFrom + 150 && t < tutorUntil - 100 });
      if (rms > 0.02) { speechMs += ms; quietMs = 0; } else if (speechMs > 300) quietMs += ms;
      if (turns === 1 && speechMs > 300 && quietMs >= 600) {
        send({ serverContent: { inputTranscription: { text: LEARNER_LINE } } });
        tutorTurn();
        setTimeout(() => send({ goAway: { timeLeft: "5s" } }), 500); // "this connection is ending"
      }
    }
  });
  socket.on("close", () => note("close", { n }));
});

// ---------- app server and browser ----------

const server = spawn(process.execPath, ["server.mjs"], {
  cwd: new URL("..", import.meta.url),
  env: { ...process.env, PORT: String(APP_PORT), LIVE_WS_URL: `ws://localhost:${MOCK_PORT}/live` },
  stdio: ["ignore", "ignore", "inherit"],
});
const cleanup = async (code) => { server.kill(); wss.close(); process.exit(code); };
for (let i = 0; ; i++) {
  try { if ((await fetch(`${base}/api/lesson`)).ok) break; } catch { /* not up yet */ }
  if (i > 50) { console.error("App server did not start"); await cleanup(1); }
  await new Promise((r) => setTimeout(r, 100));
}

const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("PAGE ERROR", e.message));

// A microphone the test can "speak" clips into.
await page.addInitScript(() => {
  const ac = new AudioContext();
  const dest = ac.createMediaStreamDestination();
  navigator.mediaDevices.getUserMedia = async () => dest.stream;
  window.__speak = async (url) => {
    await ac.resume();
    const buf = await ac.decodeAudioData(await (await fetch(url)).arrayBuffer());
    const src = ac.createBufferSource();
    src.buffer = buf;
    src.connect(dest);
    src.start();
  };
});

const tokenRequests = [], tokenResponses = [];
page.on("request", (r) => { if (r.url().endsWith("/api/live-token")) tokenRequests.push(JSON.parse(r.postData())); });
page.on("response", async (r) => { if (r.url().endsWith("/api/live-token")) tokenResponses.push(await r.json().catch(() => null)); });

await page.goto(base);
await page.evaluate(() => localStorage.setItem("malayalam-commute.progress.v1", JSON.stringify({ "amma-well": { box: 1, due: 0 } })));

const phases = [], tutorShown = new Set(), learnerShown = new Set();
await page.exposeFunction("__seen", async (phase, ml, sub) => {
  if (phase && phases.at(-1) !== phase) {
    phases.push(phase);
    if (phase === "Your turn") await page.evaluate(() => setTimeout(() => window.__speak("audio/ml/im-fine.wav"), 400));
  }
  if (ml) tutorShown.add(ml);
  if (sub) learnerShown.add(sub);
});
await page.evaluate(() => {
  const get = (id) => document.getElementById(id).textContent;
  new MutationObserver(() => window.__seen(get("phase"), get("ml"), get("roman")))
    .observe(document.querySelector("main"), { childList: true, characterData: true, subtree: true });
});

await page.click("#talk");
const until = async (what, test, ms = 30000) => {
  for (const end = Date.now() + ms; Date.now() < end; ) { if (test()) return true; await page.waitForTimeout(200); }
  console.log(`  (timed out waiting for ${what})`);
  return false;
};
await until("a second connection", () => connections >= 2);
await until("audio on the second connection", () => log.some((e) => e.type === "audio" && e.n === 2), 15000);
const title = await page.textContent("#en");
await page.click("#stop");
await page.waitForFunction(() => !document.getElementById("drill").hidden, null, { timeout: 10000 }).catch(() => {});
await until("the last connection to close", () => log.some((e) => e.type === "close" && e.n === connections), 5000);
const noteText = await page.textContent("#note");
await browser.close();

// ---------- checks ----------

const of = (type, n) => log.filter((e) => e.type === type && (n === undefined || e.n === n));
const audio = of("audio");
const first = log.filter((e) => e.n === 1).map((e) => e.type);
const role = tokenResponses[0]?.scenario?.role;
const checks = {
  "connected with a token and sent setup first, then the opening prompt": of("connect", 1)[0]?.hasToken && first[1] === "setup" && first[2] === "text",
  "sent the learner's practised phrases when asking for a session": tokenRequests[0]?.known?.includes("amma-well"),
  "showed the scenario title": title === tokenResponses[0]?.scenario?.title,
  "showed both tutor lines": TUTOR_LINES.every((t) => tutorShown.has(t)),
  "showed who is speaking, then the learner's turn": phases.includes(`${role} is speaking`) && phases.includes("Your turn"),
  "microphone audio is 16 kHz PCM in ~100 ms messages": audio.length > 0 && audio.every((e) => e.mime === "audio/pcm;rate=16000" && e.ms >= 90 && e.ms <= 130),
  "no microphone audio was sent while the tutor was speaking": !audio.some((e) => e.duringTutor),
  "told the service when the microphone stream paused": of("streamEnd").length > 0,
  "the learner's speech reached the service": audio.some((e) => e.loud),
  "showed the learner's transcript": learnerShown.has(`You: ${LEARNER_LINE}`),
  "reconnected after the going-away notice, resuming the same session": connections === 2 && tokenRequests[1]?.handle === "handle-1" && tokenRequests[1]?.scenario === tokenResponses[0]?.scenario?.id,
  "did not restart the scene after resuming": of("text", 2).length === 0,
  "kept streaming on the new connection": of("audio", 2).length > 0,
  "Stop closed the connection and showed no error": of("close", 2).length === 1 && !noteText,
};
console.log("phases:", phases.join(" → "));
let failed = false;
for (const [name, ok] of Object.entries(checks)) { console.log(`${ok ? "PASS" : "FAIL"}  ${name}`); failed ||= !ok; }
if (failed) console.log("\nlog:", JSON.stringify(log.filter((e) => e.type !== "audio")), "\ntoken requests:", JSON.stringify(tokenRequests), "\nnote:", noteText);
await cleanup(failed ? 1 : 0);
