// Drill mode: play a prompt, record the answer, grade it, decide what's next.

import { session, play, beep, pause, record } from "./audio.js";

const NEW_PER_SESSION = 5;
const INTERVAL_DAYS = [0, 1, 2, 4, 8, 16]; // review gap per box
const MAX_REQUEUES = 2; // times a missed phrase comes back in one session
const STORE = "malayalam-commute.progress.v1";
const DAY = 86400000;

const cue = (name) => play(`audio/cue/${name}.wav`);
const sayMl = (p) => play(`audio/ml/${p.id}.wav`);
const sayEn = (p) => play(`audio/en/${p.id}.wav`);

// ---------- progress ----------

export function loadProgress() {
  try { return JSON.parse(localStorage.getItem(STORE)) ?? {}; } catch { return {}; }
}
function saveProgress(progress) {
  try { localStorage.setItem(STORE, JSON.stringify(progress)); } catch { /* private mode: session still works */ }
}

/** Ids of phrases answered correctly at least once. */
export function knownPhraseIds() {
  return Object.entries(loadProgress()).filter(([, p]) => p.box >= 1).map(([id]) => id);
}

function buildQueue(phrases, progress) {
  const now = Date.now();
  const due = phrases.filter((p) => progress[p.id] && progress[p.id].due <= now)
    .sort((a, b) => progress[a.id].due - progress[b.id].due);
  const fresh = phrases.filter((p) => !progress[p.id]).slice(0, NEW_PER_SESSION);
  if (due.length || fresh.length) return [...due, ...fresh];
  // Nothing due and nothing new: practise the weakest phrases anyway.
  return [...phrases].sort((a, b) => progress[a.id].box - progress[b.id].box).slice(0, 8);
}

// ---------- one phrase ----------

async function grade(wav, phrase) {
  const res = await fetch(`api/grade?id=${encodeURIComponent(phrase.id)}`, {
    method: "POST", headers: { "Content-Type": "audio/wav" }, body: wav,
  });
  if (!res.ok) throw new Error(`Grading failed (${res.status})`);
  return res.json();
}

/** Prompt, up to two tries, then the answer. Returns true on a first-try pass. */
async function attempt(p, ui) {
  ui.card(p, false);
  ui.phase("Listen");
  await sayEn(p);

  for (let tries = 0; tries < 2 && session.running; tries++) {
    ui.phase("Your turn — say it in Malayalam", "listen");
    await beep();
    const wav = await record();
    if (!session.running) return false;

    let result = { verdict: "silence" };
    if (wav) {
      ui.phase("Checking…");
      try { result = await grade(wav, p); }
      catch (err) { ui.note(`${err.message}. Skipping the check for this one.`); result = { verdict: "ungraded" }; }
    }

    if (result.verdict === "pass") {
      ui.card(p, true);
      ui.phase(result.rough ? "Right words — listen to the sounds" : "Correct", "pass");
      await cue(result.rough ? "sounds" : "good");
      await sayMl(p);
      return tries === 0;
    }
    if (tries === 0 && result.verdict === "silence") { ui.phase("Didn't hear you", "miss"); await cue("nohear"); continue; }
    if (tries === 0 && result.verdict === "english") { ui.phase("In Malayalam", "miss"); await cue("malayalam"); continue; }
    break;
  }
  if (!session.running) return false;

  // Missed: give the answer and have them say it back.
  ui.card(p, true);
  ui.phase("Not quite — listen", "miss");
  await cue("notquite");
  await sayMl(p);
  await pause(400);
  await sayMl(p);
  await cue("repeat");
  ui.phase("Repeat after me", "listen");
  await beep();
  await record({ waitMs: 4000 });
  return false;
}

// ---------- a session ----------

export async function drill(ui) {
  const phrases = await (await fetch("api/lesson")).json();
  const progress = loadProgress();
  const queue = buildQueue(phrases, progress).map((p) => ({ p, requeues: 0 }));
  let done = 0;

  await cue("welcome");
  while (queue.length && session.running) {
    const item = queue.shift();
    const { p } = item;
    ui.count(`${done + 1} / ${done + 1 + queue.length}`);

    if (!progress[p.id] && item.requeues === 0) {
      ui.card(p, true);
      ui.phase("New phrase");
      await cue("new");
      await sayMl(p);
      await pause(500);
      await sayMl(p);
      await pause(300);
    }

    const passed = await attempt(p, ui);
    if (!session.running) break;

    const box = progress[p.id]?.box ?? 0;
    if (passed) {
      const next = Math.min(INTERVAL_DAYS.length - 1, box + 1);
      progress[p.id] = { box: next, due: Date.now() + INTERVAL_DAYS[next] * DAY };
    } else {
      progress[p.id] = { box: 0, due: Date.now() };
      if (item.requeues < MAX_REQUEUES) {
        item.requeues++;
        queue.splice(Math.min(3, queue.length), 0, item); // come back after a few others
      }
    }
    saveProgress(progress);
    done++;
    await pause(600);
  }

  if (session.running) {
    ui.phase("Session complete", "pass");
    ui.title("Done for now");
    await cue("done");
  }
}
