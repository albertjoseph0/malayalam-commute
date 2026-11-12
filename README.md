# Malayalam Commute

A hands-free speaking drill for learning Malayalam on a commute. It asks "How do
you say …?", listens to your answer, checks it, and decides what to practise
next. The first phrase set is for talking with parents from Kottayam.

## How it works

- **The page** (`public/`) plays pre-rendered audio, records each answer until
  you stop speaking, and keeps a review schedule in the browser: phrases you get
  right come back after 1, 2, 4, 8, then 16 days; phrases you miss come back a
  few turns later.
- **The server** (`server.mjs`) grades each recording with the Gemini Decisions
  API (`lib/grading.mjs`) and returns one of `pass`, `wrong`, `english` or
  `silence`, plus a flag when the words were right but the sounds were rough.
  The API key never reaches the browser.

## Run it

Needs Node 22 and a Gemini API key with billing enabled.

```bash
export GEMINI_API_KEY=...
npm start
```

Open http://localhost:8787. The microphone only works on `localhost` or over
HTTPS, so using it on a phone means hosting the server somewhere with HTTPS.

## Change the phrases

Edit `content/phrases.json`, then render audio for whatever changed:

```bash
npm run render
```

Speech models allow about 100 requests a day on the first billing tier. When
the preferred model runs out, the rest are rendered with a fallback model;
`npm run render -- --upgrade` redoes those later.

## Tests

```bash
npm run test:grader     # grades synthesised right and wrong attempts for every phrase
node test/drill.e2e.mjs # drives the page in a browser with a simulated microphone (server must be running)
```

Both make real API calls. `SAVE_RECORDINGS=<dir> npm start` keeps every graded
attempt with its verdict, for checking the grader against a real voice.

## Known limits

- The grader has only been measured on synthesised speech. It reliably rejects
  a different phrase, English, and silence, but lets through some sentences
  that differ from the target by one word or one ending.
- The phrases have not been checked by a native speaker.
- The voice is standard Malayalam, not a Kottayam accent.
