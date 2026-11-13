// Minimal Gemini REST client: speech generation and the Decisions API.
// The key comes from GEMINI_API_KEY; in a cloud session where the proxy injects
// the key, the placeholder value is replaced on the way out.

const BASE = "https://generativelanguage.googleapis.com/v1beta";
const KEY = process.env.GEMINI_API_KEY || "proxy-injected";

async function call(path, body, { method = "POST", retries = 8 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${BASE}/${path}`, {
      method,
      headers: { "x-goog-api-key": KEY, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.ok) return res.json();
    const text = await res.text();
    // A spent daily quota will not recover by waiting a few seconds.
    const dailyQuota = res.status === 429 && /per day/i.test(text);
    const retryable = !dailyQuota && (res.status === 429 || res.status >= 500);
    if (!retryable || attempt >= retries) {
      const err = new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
      err.dailyQuota = dailyQuota;
      throw err;
    }
    // Per-minute limits say how long to wait; otherwise back off.
    const asked = Number(/retry in ([\d.]+)s/i.exec(text)?.[1]);
    const wait = asked ? asked * 1000 + 1000 : Math.min(30000, 2000 * 2 ** attempt);
    await new Promise((r) => setTimeout(r, wait));
  }
}

export async function listModels() {
  const out = [];
  let pageToken = "";
  do {
    const page = await call(`models?pageSize=200${pageToken ? `&pageToken=${pageToken}` : ""}`, null, { method: "GET" });
    out.push(...(page.models ?? []));
    pageToken = page.nextPageToken ?? "";
  } while (pageToken);
  return out.map((m) => m.name.replace(/^models\//, ""));
}

/** Wrap raw 16-bit mono PCM in a WAV container. */
export function pcmToWav(pcm, sampleRate) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** Near-silent WAV (faint noise), standing in for "the learner said nothing". */
export function silenceWav(seconds = 3, sampleRate = 24000) {
  const pcm = Buffer.alloc(seconds * sampleRate * 2);
  for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(Math.round((Math.random() - 0.5) * 40), i);
  return pcmToWav(pcm, sampleRate);
}

/** Speak `text` and return a WAV buffer. */
export async function speak(text, { model, voice = "Kore" }) {
  const res = await call(`models/${model}:generateContent`, {
    contents: [{ parts: [{ text }] }],
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
    },
  });
  const part = res.candidates?.[0]?.content?.parts?.find((p) => p.inlineData);
  if (!part) throw new Error(`No audio returned for "${text}": ${JSON.stringify(res).slice(0, 300)}`);
  const { mimeType, data } = part.inlineData;
  const bytes = Buffer.from(data, "base64");
  if (/wav/i.test(mimeType)) return bytes;
  const rate = Number(/rate=(\d+)/.exec(mimeType)?.[1] ?? 24000);
  return pcmToWav(bytes, rate);
}

/**
 * Mint a short-lived token a browser can use to open one Live API session.
 * `setup` is locked into the token, so the page cannot change the model or
 * instructions. Returns the token string.
 */
export async function createLiveToken(setup, { minutes = 30 } = {}) {
  const at = (ms) => new Date(Date.now() + ms).toISOString();
  const token = await call("auth_tokens", {
    uses: 1,
    expireTime: at(minutes * 60000),
    newSessionExpireTime: at(60000),
    bidiGenerateContentSetup: setup,
  });
  return token.name;
}

/** Ask typed questions about shared input; returns { answers, usage }. */
export function decide(input, questions, model = "gemini-decision-1") {
  return call("decisions", { model, input, questions });
}
