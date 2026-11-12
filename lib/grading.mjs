// Grading for one spoken attempt. Shared by the test harness and the app, so
// what is tested is what ships.
//
// Two Decisions calls, run in parallel, because the questions need different
// input:
//   1. audio alone     -> what language is it, and which lesson phrase is it?
//   2. audio + target  -> is it the target sentence, and how is the pronunciation?
//
// Why split: shown the target, the language question calls silence "Malayalam".
// Why both "which" and "same": picking among the lesson's phrases is far better
// at telling similar sentences apart, but it will pick the closest phrase even
// for a sentence that is not in the lesson; the yes/no check covers that.
// The verdict is composed in code from the separate answers.

import { decide } from "./gemini.mjs";

const OTHER = "other";
const MAX_DISTRACTORS = 24;

export const SAME_FLOOR = 0.3;
// Below this (of 3) a passing answer is told to listen to the sounds again.
export const ROUGH_PRONUNCIATION = 1.8;

const words = (p) => new Set(p.ml.replace(/[?.!,]/g, "").split(/\s+/));

/** Other lesson phrases, most word overlap with `phrase` first. */
export function similarPhrases(phrase, lesson) {
  const mine = words(phrase);
  const overlap = (p) => [...words(p)].filter((w) => mine.has(w)).length;
  return lesson
    .filter((p) => p.id !== phrase.id)
    .map((p, i) => ({ p, score: overlap(p), i }))
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map((x) => x.p);
}

function hearingQuestions(phrase, lesson) {
  const options = [phrase, ...similarPhrases(phrase, lesson).slice(0, MAX_DISTRACTORS)];
  if (options.some((p) => p.id === OTHER)) throw new Error(`"${OTHER}" is reserved and cannot be a phrase id`);
  return {
    language: {
      type: "choice",
      instructions: "What language is spoken in the audio?",
      criteria: {
        malayalam: "Malayalam.",
        english: "English.",
        other: "Another language or a mix.",
        no_speech: "No speech; silence or noise only.",
      },
    },
    which: {
      type: "choice",
      instructions: "Which of these sentences does the speaker in the audio say?",
      criteria: {
        ...Object.fromEntries(options.map((p) => [p.id, p.ml])),
        [OTHER]: "None of these sentences, a different language, or no speech.",
      },
    },
  };
}

const MATCHING = {
  same: {
    type: "noul",
    instructions: "Does the speaker in the audio say the target sentence?",
    criteria: {
      true_description: "The spoken words are the target sentence, allowing for accent.",
      false_description:
        "The spoken words differ from the target sentence, are in another language, or there is no speech.",
    },
  },
  pronunciation: {
    type: "score",
    instructions: "How native-like is the Malayalam pronunciation in the audio?",
    criteria: [
      "No Malayalam speech.",
      "Heavy foreign accent; sounds are wrong.",
      "Understandable with a noticeable accent.",
      "Native-like.",
    ],
  },
};

/**
 * Grade one WAV recording of a learner attempting `phrase`, one of `lesson`.
 * verdict: "pass" | "wrong" | "english" | "silence"
 */
export async function gradeAttempt(wav, phrase, lesson) {
  const audio = { type: "audio", data: wav.toString("base64"), mime_type: "audio/wav" };
  const [hearing, matching] = await Promise.all([
    decide([audio], hearingQuestions(phrase, lesson)),
    decide([audio, { type: "text", text: `\nTarget sentence: ${phrase.ml}` }], MATCHING),
  ]);
  const { language, which } = hearing.answers;
  const lang = language.probabilities;
  const same = matching.answers.same.noul;

  let verdict;
  if (language.choice === "no_speech" && which.choice === OTHER) verdict = "silence";
  else if (lang.english > lang.malayalam + lang.other) verdict = "english";
  else verdict = which.choice === phrase.id && same > SAME_FLOOR ? "pass" : "wrong";

  const attempted = verdict === "pass" || verdict === "wrong";
  const pronunciation = attempted ? matching.answers.pronunciation.score : null;
  return {
    verdict,
    rough: verdict === "pass" && pronunciation < ROUGH_PRONUNCIATION,
    heard: which.choice, // the lesson phrase it sounded most like, or "other"
    same,
    pronunciation, // 0-3; only when the learner was attempting Malayalam
    language: language.choice,
  };
}
