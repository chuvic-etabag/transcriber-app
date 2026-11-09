# Transcriber

A web app for Chrome on Android that turns speech into text.

- **Live link:** https://chuvic-etabag.github.io/transcriber-app/
- **Build plan:** [docs/PLAN.md](docs/PLAN.md)

## Status

| Phase | What | Status |
|---|---|---|
| 1 | Project setup and folder structure | Done |
| 2 | Live microphone transcription | Done |
| 3 | File transcription (Whisper) | Not started (File tab says "Coming Soon") |
| 4 to 7 | Output tools, installable app, phone testing, polish | Not started |

## Files

| File | Purpose |
|---|---|
| `index.html` | The page |
| `styles.css` | Layout and colours |
| `app.js` | Tabs, buttons, transcript box |
| `live.js` | Live microphone transcription (Chrome's Web Speech API) |
| `file.js`, `whisper-worker.js` | File transcription (Phase 3, placeholders) |
| `manifest.json`, `service-worker.js`, `icons/` | Installable app (Phase 5; manifest and icons ready, not linked yet) |
| `tests/live.test.js` | Browser tests for the Live tab |

## Running the Tests

Needs Node.js, Python 3 and Playwright with Chromium.

```bash
node tests/live.test.js
```

The tests use a pretend microphone, so real speech still needs checking on a phone.
