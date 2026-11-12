#!/usr/bin/env node
// How well does the grader judge spoken Malayalam?
//
// For every lesson phrase it grades these attempts:
//   correct      the lesson's own Malayalam clip             -> pass
//   wrong-phrase the most similar other lesson phrase        -> wrong
//   near-miss    a similar sentence that is not in the lesson -> wrong
//                (only for phrases listed in test/near-misses.json)
//   english      the English translation                     -> english
//   silence      near-silent audio                           -> silence
//   anglicised   the romanisation read as English text       -> no single right
//                answer: a pass should come with the "rough pronunciation" flag
//
// All speech is synthesised, so this measures whether the grader can tell right
// from wrong, not how it copes with a real learner's voice in a car.
// Generated clips are cached in test-output/clips.
//
//   npm run render       (the lesson clips must exist first)
//   npm run test:grader

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { listModels, silenceWav, speak } from "../lib/gemini.mjs";
import { gradeAttempt, similarPhrases } from "../lib/grading.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const clipDir = join(root, "test-output", "clips");
const lesson = JSON.parse(await readFile(join(root, "content", "phrases.json"), "utf8"));
const nearMisses = JSON.parse(await readFile(join(root, "test", "near-misses.json"), "utf8"));

// Speech models to try in order; when one runs out of daily quota, move on.
const ttsModels = process.env.TTS_MODEL
  ? [process.env.TTS_MODEL]
  : (await listModels()).filter((m) => /tts/i.test(m)).sort().reverse();

async function say(text) {
  while (ttsModels.length) {
    try {
      return await speak(text, { model: ttsModels[0] });
    } catch (err) {
      if (!err.dailyQuota) throw err;
      console.warn(`  (${ttsModels.shift()} is out of daily quota)`);
    }
  }
  throw new Error("Every speech model is out of daily quota; try again tomorrow.");
}

/** Synthesised clip for `text`, cached by kind and text. */
async function synth(kind, text) {
  const file = join(clipDir, `${kind}.${createHash("sha1").update(text).digest("hex").slice(0, 10)}.wav`);
  if (existsSync(file)) return readFile(file);
  const wav = await say(text);
  await writeFile(file, wav);
  return wav;
}
const lessonClip = (p) => readFile(join(root, "public", "audio", "ml", `${p.id}.wav`));

await mkdir(clipDir, { recursive: true });

// 1. Collect every attempt (speech generation is rate limited, so one at a time).
const attempts = [];
for (const phrase of lesson) {
  const similar = similarPhrases(phrase, lesson)[0];
  const sources = {
    correct: () => lessonClip(phrase),
    "wrong-phrase": () => lessonClip(similar),
    "near-miss": nearMisses[phrase.id] && (() => synth("near-miss", nearMisses[phrase.id].ml)),
    english: () => synth("english", phrase.en),
    silence: async () => silenceWav(),
    anglicised: () =>
      synth("anglicised", `Read this aloud as an American English speaker would, with English sounds: ${phrase.roman}`),
  };
  for (const [kind, make] of Object.entries(sources)) {
    if (!make) continue;
    const said = { "wrong-phrase": similar.roman, "near-miss": nearMisses[phrase.id]?.ml }[kind];
    try {
      attempts.push({ phrase, kind, said, wav: await make() });
    } catch (err) {
      console.error(`${phrase.id} ${kind}: could not get a clip: ${err.message.split("\n")[0]}`);
    }
  }
}

// 2. Grade them.
const rows = [];
const queue = [...attempts];
async function worker() {
  for (let a; (a = queue.shift()); ) {
    const row = { phrase: a.phrase.id, kind: a.kind, ...(a.said && { said: a.said }) };
    try {
      Object.assign(row, await gradeAttempt(a.wav, a.phrase, lesson));
    } catch (err) {
      row.error = err.message.split("\n")[0];
    }
    rows.push(row);
  }
}
await Promise.all([worker(), worker(), worker(), worker()]);

// 3. Report.
const EXPECTED = { correct: "pass", "wrong-phrase": "wrong", "near-miss": "wrong", english: "english", silence: "silence" };
const ok = rows.filter((r) => !r.error);
const by = (kind) => ok.filter((r) => r.kind === kind);
const rate = (list, test) => `${list.filter(test).length}/${list.length}`;
const order = new Map(lesson.map((p, i) => [p.id, i]));
rows.sort((a, b) => order.get(a.phrase) - order.get(b.phrase));

console.log("Misgraded attempts:");
const misses = ok.filter((r) => r.kind in EXPECTED && r.verdict !== EXPECTED[r.kind]);
for (const r of misses) {
  console.log(
    `  ${r.phrase.padEnd(17)} ${r.kind.padEnd(13)} graded ${r.verdict.padEnd(8)} heard=${r.heard} same=${r.same.toFixed(2)}${r.said ? `  (clip says: ${r.said})` : ""}`,
  );
}
if (!misses.length) console.log("  none");

const angl = by("anglicised");
console.log("\nSummary");
console.log(`  correct -> pass                     ${rate(by("correct"), (r) => r.verdict === "pass")}`);
console.log(`  correct, not flagged as rough       ${rate(by("correct"), (r) => r.verdict === "pass" && !r.rough)}`);
console.log(`  similar lesson phrase -> wrong      ${rate(by("wrong-phrase"), (r) => r.verdict === "wrong")}`);
console.log(`  near-miss sentence -> wrong         ${rate(by("near-miss"), (r) => r.verdict === "wrong")}`);
console.log(`  English -> english                  ${rate(by("english"), (r) => r.verdict === "english")}`);
console.log(`  silence -> silence                  ${rate(by("silence"), (r) => r.verdict === "silence")}`);
console.log(`  false passes (any of the four above) ${rate(ok.filter((r) => r.kind in EXPECTED && r.kind !== "correct"), (r) => r.verdict === "pass")}`);
console.log(
  `  anglicised: ${angl.filter((r) => r.verdict === "pass").length} pass (${angl.filter((r) => r.rough).length} flagged rough), ` +
    `${angl.filter((r) => r.verdict === "english").length} english, ${angl.filter((r) => r.verdict === "wrong").length} wrong, of ${angl.length}`,
);
console.log(`  errors                              ${rows.length - ok.length}/${rows.length}`);

await writeFile(join(root, "test-output", "grader-results.json"), JSON.stringify(rows, null, 2));
console.log("\nFull results: test-output/grader-results.json");
