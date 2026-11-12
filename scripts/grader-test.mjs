#!/usr/bin/env node
// Does the Decisions API grade spoken Malayalam usefully?
//
// For each phrase this synthesises five attempts and grades each one:
//   correct      the phrase, spoken in Malayalam        -> pass
//   wrong-phrase a different Malayalam phrase           -> wrong
//   english      the English translation                -> english
//   anglicised   the romanisation read as English text  -> anything but pass
//   silence      near-silent audio                      -> silence
//
// Clips are cached in test-output/clips so you can listen to the voice too.
//
//   node scripts/grader-test.mjs

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { listModels, silenceWav, speak } from "../lib/gemini.mjs";
import { gradeAttempt } from "../lib/grading.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const clipDir = join(root, "test-output", "clips");
const phrases = JSON.parse(await readFile(join(root, "content", "phrases.json"), "utf8"));

const models = await listModels();
// Speech models to try in order; when one runs out of daily quota, move on.
const ttsModels = process.env.TTS_MODEL
  ? [process.env.TTS_MODEL]
  : models.filter((m) => /tts/i.test(m)).sort().reverse();
if (!ttsModels.length) throw new Error(`No speech model found. Available: ${models.join(", ")}`);
if (!models.includes("gemini-decision-1")) {
  console.warn("Warning: gemini-decision-1 is not in this key's model list; the grading calls may fail.");
}

async function say(text) {
  while (ttsModels.length) {
    try {
      return await speak(text, { model: ttsModels[0] });
    } catch (err) {
      if (!err.dailyQuota) throw err;
      console.warn(`  (${ttsModels.shift()} is out of daily quota)`);
    }
  }
  throw new Error("All speech models are out of daily quota.");
}

await mkdir(clipDir, { recursive: true });

async function clip(name, make) {
  const file = join(clipDir, `${name}.wav`);
  if (existsSync(file)) return readFile(file);
  const wav = await make();
  await writeFile(file, wav);
  return wav;
}

const rows = [];
for (const [i, phrase] of phrases.entries()) {
  const other = phrases[(i + 1) % phrases.length];
  const attempts = {
    correct: () => say(phrase.ml),
    "wrong-phrase": () => say(other.ml),
    english: () => say(phrase.en),
    anglicised: () =>
      say(`Read this aloud as an American English speaker would, with English sounds: ${phrase.roman}`),
    silence: async () => silenceWav(),
  };
  for (const [kind, make] of Object.entries(attempts)) {
    try {
      const wav = await clip(`${phrase.id}.${kind}`, make);
      rows.push({ phrase: phrase.id, kind, ...(await gradeAttempt(wav, phrase)) });
    } catch (err) {
      rows.push({ phrase: phrase.id, kind, error: err.message });
    }
    const r = rows.at(-1);
    console.log(
      r.error
        ? `${r.phrase.padEnd(18)} ${r.kind.padEnd(13)} ERROR ${r.error.split("\n")[0]}`
        : `${r.phrase.padEnd(18)} ${r.kind.padEnd(13)} ${r.verdict.padEnd(8)} lang=${r.language.padEnd(9)} (${r.languageConfidence.toFixed(2)})  same=${r.same.toFixed(2)}  pron=${r.pronunciation === null ? "-" : r.pronunciation.toFixed(2) + "/3"}`,
    );
  }
}

// Verdicts: what the grader has to get right for the drill loop to work.
const ok = rows.filter((r) => !r.error);
const by = (kind) => ok.filter((r) => r.kind === kind);
const rate = (list, test) => (list.length ? `${list.filter(test).length}/${list.length}` : "n/a");

console.log("\nSummary");
console.log(`  correct -> pass:              ${rate(by("correct"), (r) => r.verdict === "pass")}`);
console.log(`  wrong phrase -> wrong:        ${rate(by("wrong-phrase"), (r) => r.verdict === "wrong")}`);
console.log(`  English -> english:           ${rate(by("english"), (r) => r.verdict === "english")}`);
console.log(`  silence -> silence:           ${rate(by("silence"), (r) => r.verdict === "silence")}`);
console.log(`  anglicised -> not a pass:     ${rate(by("anglicised"), (r) => r.verdict !== "pass")}`);
console.log(`  false passes (any non-correct clip passing): ${rate(ok.filter((r) => r.kind !== "correct"), (r) => r.verdict === "pass")}`);
console.log(`  errors:                       ${rows.length - ok.length}/${rows.length}`);

await writeFile(join(root, "test-output", "grader-results.json"), JSON.stringify(rows, null, 2));
console.log("\nFull results: test-output/grader-results.json; clips: test-output/clips/");
