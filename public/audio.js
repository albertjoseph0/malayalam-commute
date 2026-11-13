// Shared audio for both modes: one AudioContext, one microphone, playback.

/** Set by the page. Everything here checks it so a session unwinds on Stop. */
export const session = { running: false };

let ctx;
let micStream;
let micHandler = null; // receives (Float32Array chunk, level) while a mode is listening
let levelListener = null;
let playing = null; // the clip currently sounding
let cancelRecording = null;
let stopHook = null;

export const pause = (ms) => new Promise((r) => setTimeout(r, ms));
export const sampleRate = () => ctx.sampleRate;
export const now = () => ctx.currentTime;

/** Show microphone level somewhere; called with 0..1 for every chunk. */
export function onLevel(fn) { levelListener = fn; }
export function setMic(handler) { micHandler = handler; }
/** Register cleanup for the running session; called once when it is stopped. */
export function whenStopped(fn) { stopHook = fn; }

// ---------- setup ----------

const CAPTURE_WORKLET = `
registerProcessor("capture", class extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0][0];
    if (ch) this.port.postMessage(ch.slice(0));
    return true;
  }
});`;

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
  node.port.onmessage = (e) => {
    const chunk = e.data;
    let sum = 0;
    for (let i = 0; i < chunk.length; i++) sum += chunk[i] * chunk[i];
    const level = Math.sqrt(sum / chunk.length);
    levelListener?.(micHandler ? level : 0);
    micHandler?.(chunk, level);
  };
}

/** Must be called from a tap: starts audio output and asks for the microphone. */
export async function ensureAudio() {
  ctx ??= new AudioContext();
  await ctx.resume();
  if (!micStream) await openMic();
}

/** Cut off whatever is sounding or recording, so the running session can unwind. */
export function stopAudio() {
  cancelRecording?.();
  micHandler = null;
  try { playing?.stop(); } catch { /* already ended */ }
  const hook = stopHook;
  stopHook = null;
  hook?.();
}

// ---------- playback ----------

const buffers = new Map();

function buffer(url) {
  if (!buffers.has(url)) {
    buffers.set(url, fetch(url).then((r) => {
      if (!r.ok) throw new Error(`Missing audio: ${url}`);
      return r.arrayBuffer();
    }).then((data) => ctx.decodeAudioData(data)));
  }
  return buffers.get(url);
}

/** Play a clip to the end (or until Stop). */
export async function play(url) {
  const data = await buffer(url);
  if (!session.running) return;
  const source = ctx.createBufferSource();
  source.buffer = data;
  source.connect(ctx.destination);
  playing = source;
  await new Promise((done) => { source.onended = done; source.start(); });
  playing = null;
}

export async function beep() {
  if (!session.running) return;
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

/**
 * Plays raw 16-bit PCM as it streams in, back to back. `playing()` is true
 * while queued audio is still sounding.
 */
export function createPcmPlayer() {
  const live = new Set();
  let next = 0;
  return {
    enqueue(samples, rate) {
      if (!samples.length) return;
      const buf = ctx.createBuffer(1, samples.length, rate);
      const ch = buf.getChannelData(0);
      for (let i = 0; i < samples.length; i++) ch[i] = samples[i] / 32768;
      const source = ctx.createBufferSource();
      source.buffer = buf;
      source.connect(ctx.destination);
      const at = Math.max(ctx.currentTime + 0.03, next);
      source.start(at);
      next = at + buf.duration;
      live.add(source);
      source.onended = () => live.delete(source);
    },
    flush() {
      for (const source of live) { try { source.stop(); } catch { /* already ended */ } }
      live.clear();
      next = 0;
    },
    playing: () => ctx.currentTime < next,
  };
}

// ---------- recording ----------

/** Merge captured chunks and downsample to 16 kHz 16-bit by averaging each window. */
export function to16k(chunks, total, rate) {
  const all = new Float32Array(total);
  let offset = 0;
  for (const c of chunks) { all.set(c, offset); offset += c.length; }
  const step = rate / 16000;
  const out = new Int16Array(Math.floor(total / step));
  for (let i = 0; i < out.length; i++) {
    const from = Math.floor(i * step), to = Math.max(from + 1, Math.min(total, Math.floor((i + 1) * step)));
    let sum = 0;
    for (let j = from; j < to; j++) sum += all[j];
    const s = Math.max(-1, Math.min(1, sum / (to - from)));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

function wav16k(samples) {
  const view = new DataView(new ArrayBuffer(44 + samples.length * 2));
  const text = (at, s) => { for (let i = 0; i < s.length; i++) view.setUint8(at + i, s.charCodeAt(i)); };
  text(0, "RIFF"); view.setUint32(4, 36 + samples.length * 2, true); text(8, "WAVEfmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true); view.setUint32(28, 32000, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  text(36, "data"); view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) view.setInt16(44 + i * 2, samples[i], true);
  return new Blob([view], { type: "audio/wav" });
}

/**
 * Record one utterance. Resolves with a 16 kHz WAV blob, or null if nobody
 * spoke. Ends after a stretch of quiet following speech.
 */
export function record({ waitMs = 5000, maxMs = 9000, quietMs = 900 } = {}) {
  if (!session.running) return Promise.resolve(null);
  return new Promise((resolve) => {
    const rate = ctx.sampleRate;
    const chunks = [];
    let samples = 0, floor = null, floorN = 0, loudMs = 0, quiet = 0, startedAt = -1;
    const chunkMs = (n) => (n / rate) * 1000;
    const finish = (wav) => { micHandler = cancelRecording = null; resolve(wav); };
    cancelRecording = () => finish(null);

    micHandler = (data, level) => {
      chunks.push(data);
      samples += data.length;
      const elapsed = chunkMs(samples);

      // First 150 ms calibrates the noise floor (road noise varies a lot).
      if (elapsed < 150) { floor = ((floor ?? 0) * floorN + level) / ++floorN; return; }
      const threshold = Math.max(0.012, (floor ?? 0) * 3);

      if (level > threshold) {
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
        finish(spoke ? wav16k(to16k(chunks, samples, rate)) : null);
      }
    };
  });
}
