#!/usr/bin/env node
// End-to-end check of the drill in a real browser. The microphone is replaced
// by a stream the test can "speak" clips into, so each turn is deterministic:
//   phrase 1: correct Malayalam                    -> Correct
//   phrase 2: English, then a different phrase     -> In Malayalam, then Not quite
//   phrase 3: silence, then correct Malayalam      -> Didn't hear you, then Correct
// Needs the server running (npm start) and makes real grading calls.

import { createRequire } from "node:module";

// require() so a globally installed Playwright (NODE_PATH) is found too.
const { chromium } = createRequire(import.meta.url)("playwright");

const base = process.env.BASE_URL ?? "http://localhost:8787";
const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("PAGE ERROR", e.message));

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

await page.goto(base);
const lesson = await (await page.request.get(`${base}/api/lesson`)).json();
const [p1, p2, p3] = lesson;
const ml = (p) => `audio/ml/${p.id}.wav`;

// What to say on each "your turn", in order. null = stay silent.
const script = [ml(p1), `audio/en/${p2.id}.wav`, ml(p3), null /* repeat-after-me */, null, ml(p3)];
const seen = [];
let turn = 0;

await page.exposeFunction("__phase", async (text) => {
  if (!text) return;
  seen.push(text);
  console.log(`  ${text}`);
  if (/^Your turn|^Repeat after me/.test(text)) {
    const clip = script[turn++];
    if (clip) await page.evaluate((u) => setTimeout(() => window.__speak(u), 250), clip);
  }
});
await page.evaluate(() => {
  const el = document.getElementById("phase");
  new MutationObserver(() => window.__phase(el.textContent)).observe(el, { childList: true, characterData: true, subtree: true });
});

await page.click("#go");
// Three phrases' worth of turns, then stop.
const deadline = Date.now() + 150000;
while (turn < script.length && Date.now() < deadline) await page.waitForTimeout(500);
// Wait for the third phrase's result to be saved before stopping.
await page.waitForFunction((id) => id in JSON.parse(localStorage.getItem("malayalam-commute.progress.v1") ?? "{}"), p3.id, { timeout: 40000 });
await page.click("#go");
await page.waitForFunction(() => document.getElementById("go").textContent === "Start session" && !document.getElementById("go").disabled, null, { timeout: 15000 });

const progress = await page.evaluate(() => JSON.parse(localStorage.getItem("malayalam-commute.progress.v1")));
const note = await page.textContent("#note");
await browser.close();

const passes = seen.filter((t) => /^Correct|^Right words/.test(t)).length;
const checks = {
  "phrase 1 passed and is scheduled for tomorrow": progress[p1.id]?.box === 1,
  "phrase 2 English was caught": seen.includes("In Malayalam"),
  "phrase 2 wrong answer was caught and requeued": seen.some((t) => t.startsWith("Not quite")) && progress[p2.id]?.box === 0,
  "phrase 3 silence was caught": seen.includes("Didn't hear you"),
  "phrase 3 passed on the second try (not promoted)": passes === 2 && progress[p3.id]?.box === 0,
  "no error shown": !note,
};
console.log("\nprogress:", JSON.stringify(progress));
let failed = false;
for (const [name, ok] of Object.entries(checks)) { console.log(`${ok ? "PASS" : "FAIL"}  ${name}`); failed ||= !ok; }
process.exit(failed ? 1 : 0);
