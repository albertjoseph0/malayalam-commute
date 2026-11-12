#!/usr/bin/env node
// Pre-render every clip the drill plays into public/audio/. A manifest records
// the text and speech model behind each file, so rerunning after editing
// content/ renders only what changed and removes clips that are no longer used.
//
// Speech models have a daily request limit. When the preferred model runs out,
// the remaining clips are rendered with the next one so the lesson is complete;
// --upgrade redoes those with the preferred model once its quota is back.
//
//   npm run render
//   npm run render -- --upgrade

import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { speak } from "../lib/gemini.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "public", "audio");
const manifestFile = join(out, "manifest.json");
const models = (process.env.TTS_MODELS ?? "gemini-3.8-flash-tts,gemini-3.8-flash-lite-tts").split(",");
const preferred = models[0];
const upgrade = process.argv.includes("--upgrade");
const phrases = JSON.parse(await readFile(join(root, "content", "phrases.json"), "utf8"));
const cues = JSON.parse(await readFile(join(root, "content", "cues.json"), "utf8"));
const manifest = existsSync(manifestFile) ? JSON.parse(await readFile(manifestFile, "utf8")) : {};

const wanted = Object.fromEntries([
  ...phrases.map((p) => [`ml/${p.id}.wav`, p.ml]),
  ...phrases.map((p) => [`en/${p.id}.wav`, `How do you say: ${p.en}`]),
  ...Object.entries(cues).map(([name, text]) => [`cue/${name}.wav`, text]),
]);

// Remove clips nothing refers to any more.
for (const dir of ["ml", "en", "cue"]) {
  if (!existsSync(join(out, dir))) continue;
  for (const name of await readdir(join(out, dir))) {
    const file = `${dir}/${name}`;
    if (!(file in wanted)) {
      await rm(join(out, file));
      delete manifest[file];
      console.log(`  removed ${file}`);
    }
  }
}

const stale = ([file, text]) =>
  manifest[file]?.text !== text || !existsSync(join(out, file)) || (upgrade && manifest[file].model !== preferred);
const jobs = Object.entries(wanted).filter(stale);
console.log(`${jobs.length} clips to render`);

async function say(text) {
  while (models.length) {
    const model = models[0];
    try {
      return { wav: await speak(text, { model }), model };
    } catch (err) {
      if (!err.dailyQuota) throw err;
      // Workers share the list; only the first to notice drops the model.
      if (models[0] === model) console.warn(`  (${models.shift()} is out of daily quota)`);
    }
  }
  throw new Error("Every speech model is out of daily quota; try again tomorrow.");
}

let failed = 0;
async function worker() {
  for (let job; (job = jobs.shift()); ) {
    const [file, text] = job;
    try {
      const { wav, model } = await say(text);
      await mkdir(dirname(join(out, file)), { recursive: true });
      await writeFile(join(out, file), wav);
      manifest[file] = { text, model };
      console.log(`  ${file}${model === preferred ? "" : `  (${model})`}`);
    } catch (err) {
      failed++;
      console.error(`  FAILED ${file}: ${err.message.split("\n")[0]}`);
    }
  }
}
await Promise.all([worker(), worker()]);
await writeFile(manifestFile, JSON.stringify(manifest, null, 2) + "\n");
const fallback = Object.values(manifest).filter((m) => m.model !== preferred).length;
if (fallback) console.log(`${fallback} clips use a fallback voice model; run "npm run render -- --upgrade" after the daily quota resets.`);
if (failed) process.exitCode = 1;
