# Malayalam Commute

Hands-free Malayalam speaking practice for a commute, built for one goal:
talking with parents (Amma and Achan) from Kottayam. One tap starts a session
and the rest is by voice.

## Two modes

**Drill.** It asks "How do you say …?", records your answer, checks it, and
decides what to practise next. Phrases you get right come back after 1, 2, 4,
8, then 16 days; phrases you miss come back a few turns later. Each session
brings in five new phrases plus whatever is due.

**Conversation.** A live voice role-play (a phone call with Amma, a meal at
home, an evening with Achan) with the Gemini Live model. It is told which
phrases you have passed in the drill and steers the talk towards them. Each
session uses the next scenario in turn.

## Run it

Needs Node 22.9 or later and a Gemini API key with billing enabled. Put the key
in a file named `.env` in this folder:

```
GEMINI_API_KEY=your-key
```

Then:

```bash
npm start
```

Nothing needs installing to run it; `npm install` is only for the tests.

Open http://localhost:8787 in Chrome and allow the microphone. Browsers only
allow the microphone on `localhost` or over HTTPS, so using this on a phone
means hosting it somewhere with HTTPS first. There is no login: do not put it
on the public internet as is, because anyone who finds it could spend your key.

## How it is put together

- `public/` is the page. `audio.js` owns the microphone and playback,
  `drill.js` and `live.js` are the two modes, `app.js` wires up the screen.
  Progress is kept in the browser's local storage.
- `server.mjs` serves the page and keeps the API key off it. It grades drill
  recordings (`lib/grading.mjs`, Gemini Decisions API) and mints a short-lived
  token for each conversation (`lib/live.mjs`), with the model, voice and
  instructions locked into the token. The page then talks to the Live API
  directly over a WebSocket.
- In conversation mode the microphone is closed while the tutor is speaking,
  so the tutor's voice from the speakers is not mistaken for yours. You cannot
  interrupt the tutor.

## Change the phrases

Edit `content/phrases.json`, then render audio for whatever changed:

```bash
npm run render
```

Speech models allow about 100 requests a day on the first billing tier. When
the preferred model runs out, the rest are rendered with a fallback model;
`npm run render -- --upgrade` redoes those later.

The conversation scenarios and the tutor's instructions are in `lib/live.mjs`.

## Tests

```bash
npm run test:grader      # grades synthesised right and wrong attempts for every phrase
node test/drill.e2e.mjs  # drill mode in a browser with a simulated microphone (server must be running)
node test/live.e2e.mjs   # conversation mode in a browser against a stand-in for the Live API
```

All three make real API calls. `SAVE_RECORDINGS=<dir> npm start` keeps every
graded drill attempt with its verdict, for checking the grader against a real
voice.

## Known limits

- **Conversation mode has not been run against the real Live API.** It was
  built from the API documentation and tested against a stand-in server that
  speaks the same message format. Whether the tutor's Malayalam is natural is
  also unchecked.
- **The grader has only been measured on synthesised speech.** There it accepts
  the correct phrase and rejects a different lesson phrase, English, and
  silence. It does not reliably catch a sentence that is one word or one ending
  away from the target (about half slip through), so small grammar slips can be
  marked correct. For the same reason the lesson avoids pairs of phrases that
  differ by a single word, such as "ചോറുണ്ടോ?" next to "അമ്മ ചോറുണ്ടോ?".
- The phrases have not been checked by a native speaker.
- The voices speak standard Malayalam, not with a Kottayam accent.
