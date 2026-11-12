// The questions asked about every spoken attempt. Shared by the test harness
// and (later) the app, so what is tested is what ships.

import { decide } from "./gemini.mjs";

export const QUESTIONS = {
  said_target: {
    type: "noul",
    instructions:
      "Does the speaker in the audio say the target Malayalam phrase, or a Malayalam sentence with the same meaning?",
    criteria: {
      true_description:
        "The speaker says the target phrase in Malayalam, or a Malayalam sentence that means the same thing, even with an accent or small slips.",
      false_description:
        "The speaker says something with a different meaning, answers in English, or says nothing intelligible.",
    },
  },
  language: {
    type: "choice",
    instructions: "What language does the speaker in the audio use?",
    criteria: {
      malayalam: "The speech is in Malayalam.",
      english: "The speech is in English.",
      mixed: "Malayalam and English are mixed in the same utterance.",
      silence: "There is no speech, only silence or background noise.",
    },
  },
  pronunciation: {
    type: "score",
    instructions:
      "How close is the speaker's pronunciation to a native Malayalam speaker saying the target phrase?",
    criteria: [
      "Not Malayalam, or unintelligible as Malayalam.",
      "Recognisable but heavily foreign-accented; several sounds are wrong.",
      "Clear with a noticeable accent; a native speaker understands easily.",
      "Native or near-native pronunciation.",
    ],
  },
  fluency: {
    type: "score",
    instructions: "How fluent is the speaker's delivery?",
    criteria: [
      "Halting: long pauses, restarts, or word-by-word delivery.",
      "Steady with minor hesitation.",
      "Natural conversational pace.",
    ],
  },
};

/** Grade one WAV recording of a learner attempting `phrase`. */
export async function gradeAttempt(wav, phrase) {
  const input = [
    {
      type: "text",
      text: `Target phrase (Malayalam): ${phrase.ml}\nRomanised: ${phrase.roman}\nMeaning: ${phrase.en}\nThe audio is a learner's attempt to say the target phrase.\n`,
    },
    { type: "audio", data: wav.toString("base64"), mime_type: "audio/wav" },
  ];
  const { answers, usage } = await decide(input, QUESTIONS);
  return {
    saidTarget: answers.said_target.noul,
    language: answers.language.choice,
    languageConfidence: answers.language.confidence,
    pronunciation: answers.pronunciation.score,
    fluency: answers.fluency.score,
    usage,
  };
}
