// The page: two modes behind one screen, started by a tap and then run by voice.

import { session, ensureAudio, stopAudio, onLevel } from "./audio.js";
import { drill, knownPhraseIds } from "./drill.js";
import { conversation } from "./live.js";

const $ = (id) => document.getElementById(id);
const el = {
  phase: $("phase"), title: $("en"), ml: $("ml"), sub: $("roman"), level: $("level"),
  drill: $("drill"), talk: $("talk"), stop: $("stop"), note: $("note"), count: $("count"),
};

const ui = {
  phase(text, kind = "") { el.phase.textContent = text; el.phase.dataset.kind = kind; },
  title(text) { el.title.textContent = text; el.ml.textContent = el.sub.textContent = ""; },
  card(phrase, reveal) {
    el.title.textContent = phrase.en;
    el.ml.textContent = reveal ? phrase.ml : "";
    el.sub.textContent = reveal ? phrase.roman : "";
  },
  count(text) { el.count.textContent = text; },
  note(text) { el.note.textContent = text; },
  tutor(text) { el.ml.textContent = text; },
  learner(text) { el.sub.textContent = text ? `You: ${text}` : ""; },
};

onLevel((level) => { el.level.style.width = `${Math.min(100, level * 900)}%`; });

function showRunning(running) {
  el.drill.hidden = el.talk.hidden = running;
  el.stop.hidden = !running;
  el.stop.disabled = false;
}

async function run(mode) {
  session.running = true;
  showRunning(true);
  ui.note("");
  let wakeLock;
  try {
    await ensureAudio();
    wakeLock = await navigator.wakeLock?.request("screen").catch(() => null);
    await mode();
  } catch (err) {
    ui.phase("");
    ui.note(err.name === "NotAllowedError"
      ? "Microphone access was blocked. Allow it for this site and start again."
      : `Something went wrong: ${err.message}`);
  }
  // The session has fully unwound; only now can another one start.
  session.running = false;
  stopAudio();
  wakeLock?.release().catch(() => {});
  ui.count("");
  showRunning(false);
}

/** Ask the running session to end: cut the audio and let it unwind. */
function stop() {
  session.running = false;
  el.stop.disabled = true;
  ui.phase("");
  stopAudio();
}

el.drill.addEventListener("click", () => run(() => drill(ui)));
el.talk.addEventListener("click", () => run(() => conversation(ui, knownPhraseIds())));
el.stop.addEventListener("click", stop);
