// Grading for one spoken attempt. Shared by the test harness and the app, so
// what is tested is what ships.
//
// Two Decisions calls, because the questions need different input:
//   1. audio alone      -> is there speech, and in what language?
//   2. audio + target   -> is it the target sentence, and how is the pronunciation?
// Showing the target to the language question makes the model lean towards
// "Malayalam" even for silence, so that question never sees it. The verdict is
// composed in code from the separate answers.

import { decide } from "./gemini.mjs";

const HEARING = {
  has_speech: { type: "noul", instructions: "Does the audio contain a person speaking words?" },
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
};

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

export const PASS_THRESHOLD = 0.5;

/**
 * Grade one WAV recording of a learner attempting `phrase`.
 * verdict: "pass" | "wrong" | "english" | "unclear" | "silence"
 */
export async function gradeAttempt(wav, phrase) {
  const audio = { type: "audio", data: wav.toString("base64"), mime_type: "audio/wav" };
  const [hearing, matching] = await Promise.all([
    decide([audio], HEARING),
    decide([audio, { type: "text", text: `\nTarget sentence: ${phrase.ml}` }], MATCHING),
  ]);
  const language = hearing.answers.language.choice;
  const same = matching.answers.same.noul;

  let verdict;
  if (language === "no_speech") verdict = "silence";
  else if (language === "english") verdict = "english";
  else if (language === "other") verdict = "unclear";
  else verdict = same > PASS_THRESHOLD ? "pass" : "wrong";

  return {
    verdict,
    hasSpeech: hearing.answers.has_speech.noul,
    language,
    languageConfidence: hearing.answers.language.confidence,
    same,
    // Only meaningful when the speech is Malayalam.
    pronunciation: language === "malayalam" ? matching.answers.pronunciation.score : null,
  };
}
