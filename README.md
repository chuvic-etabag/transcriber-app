# Transcriber

A web app for Chrome on Android (and Chrome on a computer) that turns English
speech into text, live from the microphone or from an audio or video file.

- **Live link:** https://chuvic-etabag.github.io/transcriber-app/
- **Build plan:** [docs/PLAN.md](docs/PLAN.md)

## Status

| Phase | What | Status |
|---|---|---|
| 1 | Project setup and folder structure | Done |
| 2 | Live microphone transcription | Done |
| 3 | File transcription | Done (TR Session B, on the phone with Whisper) |
| 4 | Output tools: Copy, Download, Clear, word count, saved transcripts | Done |
| C | File transcription with Speechmatics, numbered speaker turns, English only | Done (TR Session C) |
| 5 to 7 | Installable app, phone testing, polish | Not started |

## English Only

Both tabs work in English only. There is no language picker, no Auto-Detect
and no Filipino option. The Live tab listens with Chrome's English (US) speech
service (`LIVE_LANGUAGE` in `app.js`).

## How File Transcription Works (Speechmatics)

Every file in the File tab is transcribed by Speechmatics (English, the
"enhanced" model, with speaker diarization, word timings, and disfluencies such
as "um", "mhm" and "uh-huh" kept).

1. **Prepare** (`compact-audio.js`): the recording is read a few minutes at a
   time (`audio-reader.js`, from TR Session B, so big files and videos work)
   and turned into small mono Ogg Opus audio by Chrome's own encoder
   (16 kHz, 24 kbps, about 3 KB a second). A 3-hour recording becomes about
   33 MB, under Supabase's 50 MB limit (tested: 3 hours took 98 seconds on the
   build machine). Recordings over 4 hours get a lower bitrate so they still
   fit. The timeline is kept exact, so times in the transcript match the
   original file.
2. **Upload** (`tus-upload.js`): to the private Supabase Storage bucket
   `recordings`, in 6 MB pieces (resumable "tus" uploads). After each piece the
   place is saved, so an internet cut, a closed app or a phone restart carries
   on from the last piece. With no internet it waits and carries on by itself.
3. **Speechmatics**: the Edge Function `start-job` gives Speechmatics a
   short-lived signed link (1 hour) to fetch the audio. The app saves the
   Speechmatics job number and checks on it (`job-status`) until it is done.
   The app can be closed meanwhile: reopening it collects the transcript.
4. **Save**: the transcript (`job-result`) is saved on the device, then
   `delete-audio` deletes the uploaded audio from storage.

Everything is remembered in the browser (`cloud-store.js`, IndexedDB): the
prepared audio, the upload place, the job number and the finished transcript.
Choosing the same file again (recognised by its contents, not its name)
carries on, or shows the saved transcript, without paying twice.

The page only contains the public Supabase **publishable** key
(`cloud-config.js`). The Speechmatics key and Supabase's secret keys exist only
as Edge Function secrets.

### Transcript Format

`transcript-format.js` turns the Speechmatics result into numbered speaker
turns:

```text
1. [00:00:01 – 00:00:23] Speaker 1: So the first thing that happened was the car broke down ...
2. [00:00:05 – 00:00:05] Speaker 2 (overlap): Mhm.
3. [00:00:10 – 00:00:10] Speaker 2 (overlap): Oh no.
4. [00:00:23 – 00:00:25] Speaker 2: That sounds awful. What did you do?
```

- Turns are numbered in the order they start, each with a start-to-end time.
- A short response (up to 4 words, up to 3 seconds) said while the other person
  is still talking becomes its own turn at the moment it was said, tagged
  "(overlap)", and the other person's turn carries on around it. A short reply
  to a question, or after the other person has stopped, is a normal turn.
- A pause of 5 seconds or more starts a new turn. A turn longer than a minute
  is split at the next end of a sentence.
- Speakers are Speaker 1, Speaker 2, ... in the order they first talk. Tap a
  speaker's name (or a Rename button) to rename them everywhere.
- **Show Timestamps** hides or shows the times without transcribing again.
  Copy and Download Text File keep whichever view is showing.
- Tap a time to play the chosen file from that moment. Tap the words to correct
  them; corrections are saved.

The rules' numbers are in `RULES` at the top of `transcript-format.js`.

### Daily Limit

To protect the Speechmatics account, the Edge Functions refuse new jobs once
**60 minutes** of audio have been sent to Speechmatics in one day (all users
together, Philippine time). The app checks before it prepares or uploads
anything and shows a plain message. A job that starts under the limit runs to
the end. Jobs Speechmatics refuses are not counted.

To change the 60: edit `DAILY_LIMIT_MINUTES` in
[`supabase/functions/_shared/settings.js`](supabase/functions/_shared/settings.js),
then run the **Deploy Edge Functions** workflow.

## The On-Device Whisper Option (Hidden)

TR Session B's on-device Whisper transcription is **hidden from the screen and
not loaded by the app**, but its code is kept for later:

- `whisper-file.js` (the old File tab), `whisper-worker.js`, `job-store.js`,
  `vendor/transformers/`.
- `tests/whisper-page/` is a test-only copy of the old page so
  `tests/whisper.test.js` keeps checking that it still works.

To bring it back, load `job-store.js` and `whisper-file.js` in `index.html`
and give it its own button or tab.

## Supabase Setup

| Part | Where |
|---|---|
| Storage bucket, upload rule, daily counter | [`supabase/setup_1.sql`](supabase/setup_1.sql), run once in the SQL Editor |
| Edge Functions | [`supabase/functions/`](supabase/functions/): `check-limit`, `start-job`, `job-status`, `job-result`, `delete-audio` (plain JavaScript, shared code in `_shared/`) |
| Function settings | [`supabase/config.toml`](supabase/config.toml) (JWT check off, because the publishable key is not a JWT) |
| Deploy | GitHub Actions workflow **Deploy Edge Functions**, started by hand only |
| Secrets | Edge Function secret `SPEECHMATICS_API_KEY`; GitHub secrets `SUPABASE_ACCESS_TOKEN` and `SUPABASE_PROJECT_REF` |

## Files

| File | Purpose |
|---|---|
| `index.html` | The page |
| `styles.css` | Layout and colours |
| `app.js` | Tabs, Live tab controls, output tools (Copy, Download, Clear, word count), saved Live transcript |
| `live.js` | Live microphone transcription (Chrome's Web Speech API, English) |
| `file.js` | File tab: prepare, upload, Speechmatics, saved progress, transcript view, renaming, playing |
| `transcript-format.js` | Speechmatics result to numbered speaker turns, and turns to text |
| `compact-audio.js` | Any recording to small mono Ogg Opus audio |
| `tus-upload.js` | Resumable upload to Supabase Storage |
| `cloud-store.js` | Saves each file's progress and transcript in IndexedDB |
| `cloud-config.js` | Supabase address and publishable key (public values only) |
| `cloud-api.js` | Calls the Edge Functions |
| `audio-reader.js` | Reads audio and video files in sections, by format |
| `keep-awake.js` | Keeps the screen on (Live, and File while preparing and uploading) |
| `whisper-file.js`, `whisper-worker.js`, `job-store.js`, `vendor/transformers/` | Hidden on-device Whisper option (not loaded) |
| `supabase/` | Edge Functions, `config.toml`, `setup_1.sql` |
| `.github/workflows/deploy-edge-functions.yml` | The Deploy Edge Functions workflow |
| `manifest.json`, `service-worker.js`, `icons/` | Installable app (Phase 5; not linked yet) |
| `tests/` | Automated tests |

## Running the Tests

Needs Node.js 22, Python 3, ffmpeg, curl, Playwright with Chromium, and
PostgreSQL 14 or newer (for the functions test).

```bash
node tests/transcript-format.test.js
```

```bash
node tests/functions.test.mjs
```

```bash
node tests/compact-audio.test.js
```

```bash
node tests/file.test.js
```

```bash
node tests/live.test.js
```

```bash
node tests/audio-reader.test.js
```

```bash
node tests/whisper.test.js
```

- `transcript-format.test.js`: the transcript format with made-up Speechmatics
  results in the exact json-v2 format (`tests/fixtures/`): two speakers, three
  speakers, many short overlapping responses, long silences, a 2-hour result.
- `functions.test.mjs`: the Edge Functions and `setup_1.sql`, in a throwaway
  PostgreSQL, with Speechmatics and Storage played by the test.
- `compact-audio.test.js`: every format becomes Ogg Opus with the sound in the
  same place in time. Add `--long` for a 3-hour recording.
- `file.test.js`: the File tab in Chromium with a pretend Supabase and
  Speechmatics: the whole trip, resuming after a closed app, a phone restart
  and an internet cut, never paying twice, every message, renaming, timestamps,
  playing, Copy and Download.
- `live.test.js`: the Live tab, with a pretend microphone.
- `audio-reader.test.js`: every supported format, read in sections. Add
  `--long` for 2.5-hour files.
- `whisper.test.js`: the hidden Whisper option with the real model. Add
  `--long` for 2.5-hour files.

Speechmatics itself cannot be reached from the build machine, so the real
service still needs checking by hand after the functions are deployed.
