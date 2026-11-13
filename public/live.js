// Conversation mode: a live voice role-play over the Gemini Live API.
//
// The page connects straight to the Live API with a short-lived token from our
// server, streams the microphone up, and plays the tutor's audio as it arrives.
//
// The microphone is closed while the tutor is speaking. That gives up
// interrupting the tutor, but it stops the tutor's own voice (from car
// speakers, say) being heard as the learner talking.

import { session, setMic, sampleRate, to16k, createPcmPlayer, whenStopped } from "./audio.js";

const SEND_MS = 100; // microphone audio per message
const TAIL_MS = 300; // keep the microphone closed this long after the tutor stops
const SETUP_TIMEOUT_MS = 12000;
const MAX_RECONNECTS = 3; // in a row, without a completed tutor turn between
const SCENARIO_STORE = "malayalam-commute.scenario.v1";

function toBase64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function pcmFromBase64(data) {
  const bin = atob(data);
  const bytes = new Uint8Array(bin.length - (bin.length % 2));
  for (let i = 0; i < bytes.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Int16Array(bytes.buffer);
}

const parse = async (data) => JSON.parse(typeof data === "string" ? data : await data.text());

function lastScenario() {
  try { return localStorage.getItem(SCENARIO_STORE) ?? undefined; } catch { return undefined; }
}
function rememberScenario(id) {
  try { localStorage.setItem(SCENARIO_STORE, id); } catch { /* private mode */ }
}

/**
 * Run one conversation until it is stopped (resolves) or cannot continue
 * (rejects). `known` is the ids of phrases the learner has practised.
 */
export function conversation(ui, known) {
  return new Promise((resolve, reject) => {
    const player = createPcmPlayer();
    let ws = null; // the current connection
    let scenario = null;
    let handle = null; // lets a new connection resume this session
    let reconnects = 0, moving = false, leaving = false, over = false;
    let tutorStarted = false; // the tutor has begun speaking on this session
    let tutorText = "", learnerText = "", tutorFresh = true, learnerFresh = true;
    let inbox = Promise.resolve(); // messages are handled strictly in order

    function end(err) {
      if (over) return;
      over = true;
      setMic(null);
      player.flush();
      const socket = ws;
      ws = null;
      try { socket?.close(); } catch { /* already closed */ }
      err ? reject(err) : resolve();
    }
    whenStopped(() => end());

    const send = (message) => { if (ws?.ready && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message)); };

    // ----- connection -----

    async function connect(resume) {
      const res = await fetch("api/live-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ known, scenario: scenario?.id, after: lastScenario(), handle: resume ? handle : undefined }),
      });
      if (!res.ok) throw new Error(`Could not start the conversation (${res.status})`);
      const info = await res.json();
      if (over) return;
      if (!scenario) {
        scenario = info.scenario;
        rememberScenario(scenario.id);
        ui.title(scenario.title);
      }

      const socket = new WebSocket(info.url);
      ws = socket;
      await new Promise((ready, fail) => {
        const timer = setTimeout(() => fail(new Error("The voice service did not answer")), SETUP_TIMEOUT_MS);
        socket.onopen = () => socket.send(JSON.stringify({ setup: { model: info.model } }));
        socket.onmessage = (event) => {
          inbox = inbox.then(() => parse(event.data)).then((message) => {
            if (socket !== ws) return;
            if (message.setupComplete) { clearTimeout(timer); socket.ready = true; ready(); }
            else receive(message);
          }).catch((err) => console.warn("Unreadable message from the voice service", err));
        };
        socket.onerror = () => { /* onclose follows with the details */ };
        socket.onclose = (event) => {
          clearTimeout(timer);
          const why = `${event.code}${event.reason ? `: ${event.reason}` : ""}`;
          fail(new Error(`The voice service closed the connection (${why})`));
          if (socket === ws && socket.ready && !over) reconnect();
        };
      });
    }

    const begin = () => send({ realtimeInput: { text: "Begin the scene now." } });

    /** Replace the connection, resuming the same session when possible. */
    async function reconnect() {
      if (over || moving) return;
      moving = true;
      try {
        if (++reconnects > MAX_RECONNECTS) throw new Error("The connection to the voice service kept dropping");
        const old = ws;
        ws = null;
        try { old?.close(); } catch { /* already closed */ }
        try {
          await connect(Boolean(handle));
        } catch (err) {
          if (!handle || over) throw err;
          handle = null; // could not resume: start the scene again
          await connect(false);
        }
        if (!handle) { tutorStarted = false; begin(); }
      } catch (err) {
        end(err);
      } finally {
        moving = leaving = false;
      }
    }

    /** The service said this connection is ending: move once the tutor has finished speaking. */
    function leaveWhenQuiet() {
      if (over) return;
      if (player.playing()) setTimeout(leaveWhenQuiet, 250);
      else reconnect();
    }

    // ----- from the tutor -----

    function receive(message) {
      const update = message.sessionResumptionUpdate;
      if (update?.resumable && update.newHandle) handle = update.newHandle;
      if (message.goAway && !leaving) { leaving = true; leaveWhenQuiet(); }

      const content = message.serverContent;
      if (!content) return;
      if (content.interrupted) player.flush();
      for (const part of content.modelTurn?.parts ?? []) {
        if (!part.inlineData?.data) continue;
        const rate = Number(/rate=(\d+)/.exec(part.inlineData.mimeType ?? "")?.[1] ?? 24000);
        player.enqueue(pcmFromBase64(part.inlineData.data), rate);
        tutorStarted = true;
      }
      if (content.outputTranscription?.text) {
        if (tutorFresh) { tutorText = ""; tutorFresh = false; }
        learnerFresh = true;
        tutorText += content.outputTranscription.text;
        ui.tutor(tutorText.trim());
      }
      if (content.inputTranscription?.text) {
        if (learnerFresh) { learnerText = ""; learnerFresh = false; }
        learnerText += content.inputTranscription.text;
        ui.learner(learnerText.trim());
      }
      if (content.turnComplete) { tutorFresh = true; reconnects = 0; }
    }

    // ----- to the tutor -----

    function listen() {
      const rate = sampleRate();
      let chunks = [], total = 0, closed = false, tutorHeardAt = 0, shown = "";
      setMic((chunk) => {
        const speaking = player.playing();
        if (speaking) tutorHeardAt = performance.now();
        const state = !tutorStarted ? "waiting" : speaking ? "tutor" : "you";
        if (state !== shown) {
          shown = state;
          if (state === "waiting") ui.phase("Connecting…");
          else if (state === "tutor") ui.phase(`${scenario.role} is speaking`);
          else ui.phase("Your turn", "listen");
        }

        if (state !== "you" || performance.now() - tutorHeardAt < TAIL_MS) {
          if (!closed) {
            closed = true;
            chunks = []; total = 0;
            send({ realtimeInput: { audioStreamEnd: true } }); // the stream is pausing; flush what was sent
          }
          return;
        }
        closed = false;
        chunks.push(chunk);
        total += chunk.length;
        if (total >= (rate * SEND_MS) / 1000) {
          const pcm = to16k(chunks, total, rate);
          send({ realtimeInput: { audio: { data: toBase64(new Uint8Array(pcm.buffer)), mimeType: "audio/pcm;rate=16000" } } });
          chunks = []; total = 0;
        }
      });
    }

    (async () => {
      ui.phase("Connecting…");
      await connect(false);
      if (over || !session.running) return;
      listen();
      begin();
    })().catch(end);
  });
}
