// Voice drill: play a prompt, record the answer, grade it, decide what's next.

const NEW_PER_SESSION = 5;
const INTERVAL_DAYS = [0, 1, 2, 4, 8, 16]; // review gap per box
const MAX_REQUEUES = 2; // times a missed phrase comes back in one session
const STORE = "malayalam-commute.progress.v1";
const DAY = 86400000;

const $ = (id) => document.getElementById(id);
const ui = { phase: $("phase"), en: $("en"), ml: $("ml"), roman: $("roman"), level: $("level"), go: $("go"), note: $("note"), count: $("count") };

function setPhase(text, kind = "") { ui.phase.textContent = text; ui.phase.dataset.kind = kind; }
function showCard(p, reveal) {
  ui.en.textContent = p.en;
  ui.ml.textContent = reveal ? p.ml : "";
  ui.roman.textContent = reveal ? p.roman : "";
}

// ---------- progress ----------

function loadProgress() {
  try { return JSON.parse(localStorage.getItem(STORE)) ?? {}; } catch { return {}; }
}
function saveProgress(progress) {
  try { localStorage.setItem(STORE, JSON.stringify(progress)); } catch { /* private mode: session still works */ }
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

// ---------- audio out ----------

let ctx;
const buffers = new Map();

async function buffer(url) {
  if (!buffers.has(url)) {
    buffers.set(url, fetch(url).then((r) => {
      if (!r.ok) throw new Error(`Missing audio: ${url}`);
      return r.arrayBuffer();
    }).then((data) => ctx.decodeAudioData(data)));
  }
  return buffers.get(url);
}

let playing = null; // the source currently sounding, so Stop can cut it off

async function play(url) {
  const data = await buffer(url);
  if (!running) return;
  const source = ctx.createBufferSource();
  source.buffer = data;
  source.connect(ctx.destination);
  playing = source;
  await new Promise((done) => { source.onended = done; source.start(); });
  playing = null;
}
const cue = (name) => play(`audio/cue/${name}.wav`);
const sayMl = (p) => play(`audio/ml/${p.id}.wav`);
const sayEn = (p) => play(`audio/en/${p.id}.wav`);
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

async function beep() {
  if (!running) return;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.frequency.value = 880;
  gain.gain.setValueAtTime(0.15, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.15);
  osc.connect(gain).connect(ctx.destination);
  osc.start();
  osc.stop(ctx.currentTime + 0.15);
  await pause(200);
}

// ---------- audio in ----------

const CAPTURE_WORKLET = `
registerProcessor("capture", class extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0][0];
    if (ch) this.port.postMessage(ch.slice(0));
    return true;
  }
});`;

let micStream;
let onChunk = null; // set while recording
let cancelRecording = null;

async function openMic() {
  micStream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
  });
  const url = URL.createObjectURL(new Blob([CAPTURE_WORKLET], { type: "text/javascript" }));
  await ctx.audioWorklet.addModule(url);
  URL.revokeObjectURL(url);
  const node = new AudioWorkletNode(ctx, "capture");
  const mute = ctx.createGain();
  mute.gain.value = 0; // keep the node pulled by the graph without playing the mic back
  ctx.createMediaStreamSource(micStream).connect(node).connect(mute).connect(ctx.destination);
  node.port.onmessage = (e) => onChunk?.(e.data);
}

/**
 * Record one utterance. Resolves with a 16 kHz WAV blob, or null if nobody
 * spoke. Ends after a stretch of quiet following speech.
 */
function record({ waitMs = 5000, maxMs = 9000, quietMs = 900 } = {}) {
  if (!running) return Promise.resolve(null);
  return new Promise((resolve) => {
    const rate = ctx.sampleRate;
    const chunks = [];
    let samples = 0, floor = null, floorN = 0, loudMs = 0, quiet = 0, startedAt = -1;
    const chunkMs = (n) => (n / rate) * 1000;
    const finish = (wav) => { onChunk = cancelRecording = null; ui.level.style.width = "0"; resolve(wav); };
    cancelRecording = () => finish(null);

    onChunk = (data) => {
      chunks.push(data);
      samples += data.length;
      const elapsed = chunkMs(samples);
      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
      const rms = Math.sqrt(sum / data.length);
      ui.level.style.width = `${Math.min(100, rms * 900)}%`;

      // First 150 ms calibrates the noise floor (road noise varies a lot).
      if (elapsed < 150) { floor = ((floor ?? 0) * floorN + rms) / ++floorN; return; }
      const threshold = Math.max(0.012, (floor ?? 0) * 3);

      if (rms > threshold) {
        loudMs += chunkMs(data.length);
        quiet = 0;
        if (startedAt < 0 && loudMs > 120) startedAt = samples;
      } else if (startedAt >= 0) {
        quiet += chunkMs(data.length);
      } else {
        loudMs = Math.max(0, loudMs - chunkMs(data.length) / 2);
      }

      const spoke = startedAt >= 0;
      if ((spoke && quiet >= quietMs) || elapsed >= maxMs || (!spoke && elapsed >= waitMs)) {
        finish(spoke ? toWav(chunks, samples, rate) : null);
      }
    };
  });
}

function toWav(chunks, total, rate) {
  const all = new Float32Array(total);
  let offset = 0;
  for (const c of chunks) { all.set(c, offset); offset += c.length; }

  // Downsample to 16 kHz by averaging each window.
  const outRate = 16000, step = rate / outRate;
  const n = Math.floor(total / step);
  const view = new DataView(new ArrayBuffer(44 + n * 2));
  const text = (at, s) => { for (let i = 0; i < s.length; i++) view.setUint8(at + i, s.charCodeAt(i)); };
  text(0, "RIFF"); view.setUint32(4, 36 + n * 2, true); text(8, "WAVEfmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, outRate, true); view.setUint32(28, outRate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  text(36, "data"); view.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const from = Math.floor(i * step), to = Math.min(total, Math.floor((i + 1) * step) || from + 1);
    let sum = 0;
    for (let j = from; j < to; j++) sum += all[j];
    const s = Math.max(-1, Math.min(1, sum / Math.max(1, to - from)));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([view], { type: "audio/wav" });
}

// ---------- the drill ----------

async function grade(wav, phrase) {
  const res = await fetch(`api/grade?id=${encodeURIComponent(phrase.id)}`, {
    method: "POST", headers: { "Content-Type": "audio/wav" }, body: wav,
  });
  if (!res.ok) throw new Error(`Grading failed (${res.status})`);
  return res.json();
}

let running = false;

/** One phrase: prompt, up to two tries, then the answer. Returns true on a pass. */
async function attempt(p) {
  showCard(p, false);
  setPhase("Listen");
  await sayEn(p);

  for (let tries = 0; tries < 2 && running; tries++) {
    setPhase("Your turn — say it in Malayalam", "listen");
    await beep();
    const wav = await record();
    if (!running) return false;

    let result = { verdict: "silence" };
    if (wav) {
      setPhase("Checking…");
      try { result = await grade(wav, p); }
      catch (err) { ui.note.textContent = `${err.message}. Skipping the check for this one.`; result = { verdict: "ungraded" }; }
    }

    if (result.verdict === "pass") {
      const rough = result.rough;
      showCard(p, true);
      setPhase(rough ? "Right words — listen to the sounds" : "Correct", "pass");
      await cue(rough ? "sounds" : "good");
      await sayMl(p);
      return tries === 0;
    }
    if (tries === 0 && result.verdict === "silence") { setPhase("Didn't hear you", "miss"); await cue("nohear"); continue; }
    if (tries === 0 && result.verdict === "english") { setPhase("In Malayalam", "miss"); await cue("malayalam"); continue; }
    break;
  }
  if (!running) return false;

  // Missed: give the answer and have them say it back.
  showCard(p, true);
  setPhase("Not quite — listen", "miss");
  await cue("notquite");
  await sayMl(p);
  await pause(400);
  await sayMl(p);
  await cue("repeat");
  setPhase("Repeat after me", "listen");
  await beep();
  await record({ waitMs: 4000 });
  return false;
}

async function session() {
  const phrases = await (await fetch("api/lesson")).json();
  const progress = loadProgress();
  const queue = buildQueue(phrases, progress).map((p) => ({ p, requeues: 0 }));
  let done = 0;

  await cue("welcome");
  while (queue.length && running) {
    const item = queue.shift();
    const { p } = item;
    ui.count.textContent = `${done + 1} / ${done + 1 + queue.length}`;

    if (!progress[p.id] && item.requeues === 0) {
      showCard(p, true);
      setPhase("New phrase");
      await cue("new");
      await sayMl(p);
      await pause(500);
      await sayMl(p);
      await pause(300);
    }

    const passed = await attempt(p);
    if (!running) break;

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

  if (running) {
    setPhase("Session complete", "pass");
    ui.en.textContent = "Done for now";
    ui.ml.textContent = ui.roman.textContent = "";
    await cue("done");
  }
}

// ---------- start / stop ----------

async function start() {
  running = true;
  ui.go.textContent = "Stop";
  ui.go.classList.add("stop");
  ui.note.textContent = "";
  let wakeLock;
  try {
    ctx ??= new AudioContext();
    await ctx.resume();
    if (!micStream) await openMic();
    wakeLock = await navigator.wakeLock?.request("screen").catch(() => null);
    await session();
  } catch (err) {
    setPhase("");
    ui.note.textContent = err.name === "NotAllowedError"
      ? "Microphone access was blocked. Allow it for this site and start again."
      : `Something went wrong: ${err.message}`;
  }
  // The session has fully unwound; only now can another one start.
  running = false;
  wakeLock?.release().catch(() => {});
  ui.go.disabled = false;
  ui.go.textContent = "Start session";
  ui.go.classList.remove("stop");
  ui.count.textContent = "";
}

/** Ask the running session to end: cut the audio, drop the recording, let it unwind. */
function stop() {
  running = false;
  ui.go.disabled = true;
  setPhase("");
  cancelRecording?.();
  try { playing?.stop(); } catch { /* already ended */ }
}

ui.go.addEventListener("click", () => (running ? stop() : start()));
