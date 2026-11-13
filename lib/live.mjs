// Conversation mode: a real-time voice role-play with the Gemini Live API.
//
// The browser talks to the Live API directly over a WebSocket. This module
// only decides what the session is (model, voice, instructions) and mints a
// short-lived token with that setup locked in, so the API key and the
// instructions stay on the server.

import { createLiveToken } from "./gemini.mjs";

const MODEL = process.env.LIVE_MODEL ?? "gemini-3.8-live";
const VOICE = process.env.LIVE_VOICE ?? "Kore";
const WS_URL =
  process.env.LIVE_WS_URL ??
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained";

export const SCENARIOS = [
  {
    id: "call-amma",
    title: "Phone call with Amma",
    role: "Amma",
    brief:
      "You are Amma, phoning your grown child who lives in America. Ask whether they have eaten, how work was today, and when they are coming home to visit. Mention something small from your own day.",
  },
  {
    id: "table-amma",
    title: "At the table with Amma",
    role: "Amma",
    brief:
      "You are Amma, serving a meal at home. Offer rice, curry and tea, ask whether the food is good and whether they want more, and react when they say they are full.",
  },
  {
    id: "evening-achan",
    title: "Evening with Achan",
    role: "Achan",
    brief:
      "You are Achan, chatting at home in the evening. Ask what they did today, how work is going and what they plan to do tomorrow. Mention your own day and ask them to remind you about your medicine.",
  },
];

/** The scenario after `afterId`, so each session is a different one. */
export function nextScenario(afterId) {
  const i = SCENARIOS.findIndex((s) => s.id === afterId);
  return SCENARIOS[(i + 1) % SCENARIOS.length];
}

function instructions(scenario, known) {
  const practised = known.length
    ? known.map((p) => `- ${p.ml} (${p.en})`).join("\n")
    : "- None yet. Start with greetings and very simple questions.";
  return `You are a Malayalam conversation partner for an adult heritage learner, playing a role.

The learner grew up in America hearing their parents speak Malayalam at home. They understand basic household conversation but have never spoken the language. Their goal is to talk with their parents, whom they call Amma and Achan, who are in their sixties and from Kottayam, Kerala.

Your role: ${scenario.brief}

How to speak:
- Speak the colloquial Malayalam used at home in Kottayam, not formal or written Malayalam. For example say "എന്നാ" rather than "എന്താണ്", and "ചെയ്യുവാ" rather than "ചെയ്യുന്നു".
- Speak slowly and clearly, as a parent would to a child who is learning.
- Keep every turn to one or two short sentences, then stop and wait for the learner.
- End each turn with one simple question the learner can answer in a short Malayalam sentence.
- Stay in character as ${scenario.role}. Address the learner as നീ, as a parent would, and do not use gendered words such as മോനേ or മോളേ.
- The learner should address you as ${scenario.role}, never as നീ. If they call you നീ, show them the sentence with ${scenario.role} instead.

How to help:
- If the learner answers in English, tell them in one short English sentence how to say it in Malayalam, say the Malayalam, and ask them to repeat it. Then continue in Malayalam.
- If the learner makes a mistake, say the corrected sentence naturally and have them repeat it once. Do not explain grammar.
- If the learner is silent, says they did not understand, or asks you to repeat, say it again more slowly. If they are still stuck, give the meaning in English.
- Praise briefly when they get something right. Do not overpraise.
- Use English only for these short helps. Everything else is Malayalam.

Phrases the learner has practised. Give them chances to use these, and build new sentences from the same pieces:
${practised}

Begin by greeting the learner in Malayalam, in character, and ask your first question.`;
}

function setup(scenario, known, handle) {
  return {
    model: `models/${MODEL}`,
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE } } },
    },
    systemInstruction: { parts: [{ text: instructions(scenario, known) }] },
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    // Learners pause mid-sentence; wait longer before deciding they have finished.
    realtimeInputConfig: {
      automaticActivityDetection: { endOfSpeechSensitivity: "END_SENSITIVITY_LOW", silenceDurationMs: 1200 },
    },
    // Connections last about ten minutes; a handle lets the next one carry on.
    sessionResumption: handle ? { handle } : {},
    // Lets a session run past the fifteen-minute audio limit.
    contextWindowCompression: { slidingWindow: {} },
  };
}

/**
 * Everything the page needs to open one connection: where to connect and
 * which scenario it is. `handle` resumes an earlier connection's session.
 */
export async function openLiveSession({ scenario, known, handle }) {
  const token = await createLiveToken(setup(scenario, known, handle));
  return {
    url: `${WS_URL}?access_token=${encodeURIComponent(token)}`,
    model: `models/${MODEL}`,
    scenario: { id: scenario.id, title: scenario.title, role: scenario.role },
  };
}
