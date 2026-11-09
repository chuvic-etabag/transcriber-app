# Transcriber

A web app for Chrome on Android that turns speech into text, live from the
microphone or from an audio or video file.

- **Live link:** https://chuvic-etabag.github.io/transcriber-app/
- **Build plan:** [docs/PLAN.md](docs/PLAN.md)

## Status

| Phase | What | Status |
|---|---|---|
| 1 | Project setup and folder structure | Done |
| 2 | Live microphone transcription | Done |
| 3 | File transcription (Whisper in the browser) | Done |
| 4 | Output tools: Copy, Download, Clear, word count, saved transcripts | Done |
| 5 to 7 | Installable app, phone testing, polish | Not started |

## How File Transcription Works

1. **Choose Audio or Video File** accepts MP3, M4A, WAV, OGG, OPUS, WEBM, FLAC
   and AAC audio, and MP4, MOV, M4V, WEBM, MKV and 3GP video (only the sound is used).
2. The file is read **a few minutes at a time** (`audio-reader.js`), never all
   at once, so 2 to 3 hour recordings work on a phone. Chrome decodes each
   section to 16 kHz mono, which is what Whisper needs.
3. Whisper runs in a **Web Worker** (`whisper-worker.js`) through Transformers.js,
   so the screen never freezes. **Fast** uses `whisper-tiny` (about 40 MB),
   **Accurate** uses `whisper-base` (about 80 MB); both are multilingual. The
   model downloads the first time only and is kept in the browser's cache.
4. The sound goes to Whisper in **pieces of up to 30 seconds**, cut at the
   quietest moment so words aren't split. Silent pieces are skipped.
5. Every finished piece is **saved in IndexedDB** (`job-store.js`). If the app
   closes or the phone restarts, choosing the same file again carries on from
   the last saved piece. The file is recognised by its contents, not its name.
6. The screen is kept on while working (`keep-awake.js`), and asked again if
   Android lets go.

**Auto-Detect** chooses between English and Filipino for each piece (the
library on its own would always assume English).

The audio never leaves the phone. The only downloads are the app itself and
the speech model from huggingface.co.

## Files

| File | Purpose |
|---|---|
| `index.html` | The page |
| `styles.css` | Layout and colours |
| `app.js` | Tabs, Live tab controls, output tools (Copy, Download, Clear, word count), saved Live transcript |
| `live.js` | Live microphone transcription (Chrome's Web Speech API) |
| `file.js` | File tab: choosing files, progress, Cancel, resume, messages |
| `audio-reader.js` | Reads audio and video files in sections, by format |
| `whisper-worker.js` | Runs Whisper in a Web Worker |
| `job-store.js` | Saves file progress in IndexedDB |
| `keep-awake.js` | Keeps the screen on (Live and File) |
| `vendor/transformers/` | Transformers.js 4.3.2 and the ONNX Runtime WebAssembly files it needs (unchanged copies from npm) |
| `manifest.json`, `service-worker.js`, `icons/` | Installable app (Phase 5; not linked yet) |
| `tests/` | Automated tests |

## Running the Tests

Needs Node.js, Python 3, ffmpeg, curl and Playwright with Chromium.

```bash
node tests/live.test.js
```

```bash
node tests/audio-reader.test.js
```

```bash
node tests/file.test.js
```

- `live.test.js`: the Live tab, with a pretend microphone.
- `audio-reader.test.js`: every supported format, read in sections, compared
  with a full decode by ffmpeg. Add `--long` to include 2.5-hour files.
- `file.test.js`: the File tab and output tools in Chromium with the real
  Whisper model. Add `--long` to include 2.5-hour files. The first run
  downloads the models and some speech recordings into a cache folder.

Real speech on a real phone still needs checking by hand.
