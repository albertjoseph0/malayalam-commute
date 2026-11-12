#!/usr/bin/env node
// Does the Decisions API grade spoken Malayalam usefully?
//
// For each phrase this synthesises five attempts and grades each one:
//   correct      the phrase, spoken in Malayalam        -> should pass
//   wrong-phrase a different Malayalam phrase           -> should fail, language malayalam
//   english      the English translation                -> should fail, language english
//   anglicised   the romanisation read as English text  -> pronunciation should drop
//   silence      near-silent audio                      -> should fail, language silence
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
const ttsModel =
  process.env.TTS_MODEL ??
  models.filter((m) => /tts/i.test(m)).sort().reverse().find((m) => /flash/i.test(m)) ??
  models.find((m) => /tts/i.test(m));
if (!ttsModel) throw new Error(`No speech model found. Available: ${models.join(", ")}`);
if (!models.includes("gemini-decision-1")) {
  console.warn("Warning: gemini-decision-1 is not in this key's model list; the grading calls may fail.");
}
console.log(`Speech model: ${ttsModel}\n`);

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
    correct: () => speak(phrase.ml, { model: ttsModel }),
    "wrong-phrase": () => speak(other.ml, { model: ttsModel }),
    english: () => speak(phrase.en, { model: ttsModel }),
    anglicised: () =>
      speak(`Read this aloud as an American English speaker would, with English sounds: ${phrase.roman}`, {
        model: ttsModel,
      }),
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
        ? `${r.phrase.padEnd(18)} ${r.kind.padEnd(13)} ERROR ${r.error}`
        : `${r.phrase.padEnd(18)} ${r.kind.padEnd(13)} said=${r.saidTarget.toFixed(2)}  lang=${r.language.padEnd(9)} (${r.languageConfidence.toFixed(2)})  pron=${r.pronunciation.toFixed(2)}/3  fluency=${r.fluency.toFixed(2)}/2`,
    );
  }
}

// Verdicts: what the grader has to get right for the drill loop to work.
const ok = rows.filter((r) => !r.error);
const by = (kind) => ok.filter((r) => r.kind === kind);
const rate = (list, test) => (list.length ? `${list.filter(test).length}/${list.length}` : "n/a");
const mean = (list, key) => (list.length ? (list.reduce((s, r) => s + r[key], 0) / list.length).toFixed(2) : "n/a");

console.log("\nSummary");
console.log(`  correct accepted (said > 0.7):            ${rate(by("correct"), (r) => r.saidTarget > 0.7)}`);
console.log(`  wrong phrase rejected (said < 0.3):       ${rate(by("wrong-phrase"), (r) => r.saidTarget < 0.3)}`);
console.log(`  English rejected and labelled english:    ${rate(by("english"), (r) => r.saidTarget < 0.3 && r.language === "english")}`);
console.log(`  silence labelled silence:                 ${rate(by("silence"), (r) => r.language === "silence")}`);
console.log(`  mean pronunciation, correct vs anglicised: ${mean(by("correct"), "pronunciation")} vs ${mean(by("anglicised"), "pronunciation")}`);
console.log(`  errors:                                   ${rows.length - ok.length}/${rows.length}`);

await writeFile(join(root, "test-output", "grader-results.json"), JSON.stringify(rows, null, 2));
console.log("\nFull results: test-output/grader-results.json; clips: test-output/clips/");
