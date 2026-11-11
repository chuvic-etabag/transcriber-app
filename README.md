# Transcriber

A web app for Chrome on Android (and Chrome on a computer) that turns English
speech into text, live from the microphone or from an audio or video file, and
keeps every transcript (with its recording) in a cloud folder, My Transcripts.

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
| D | Sign-in by email link, My Transcripts in the cloud, Show Fillers, Sunset colors | Done (TR Session D) |
| 5 to 7 | Installable app, phone testing, polish | Not started |

## Signing In

Nothing works until someone signs in: the sign-in screen is all there is.

- **Email link, no password** (Supabase Auth). Type your email, tap **Sign In**,
  open the link in the email on the same device. You stay signed in on that
  device until you tap **Sign Out** (which signs out that device only).
- **Only allowed emails** can sign in. Anyone else sees "This app isn't open to
  new users yet." and no email is sent. The list is the table `allowed_emails`
  in Supabase (made by [`supabase/setup_2.sql`](supabase/setup_2.sql)); it
  starts with one email.
- **It is checked on the server too**, not only on the page: the database
  refuses to make an account for an email that is not on the list, the Edge
  Functions refuse anyone who is not signed in or not on the list, and the
  database and storage rules give each person only their own transcripts and
  recordings.

### Adding a Tester (One Line)

Open the SQL Editor
(https://supabase.com/dashboard/project/mgiwopbaglgzxeaowzzt/sql/new), paste
this line with the tester's email **in small letters**, and press **Run**:

```sql
insert into public.allowed_emails (email) values ('tester@example.com');
```

To stop someone:

```sql
delete from public.allowed_emails where email = 'tester@example.com';
```

Nothing needs deploying. One more thing for testers: Supabase's built-in email
service only sends to the people in your own Supabase organization, and only 2
emails an hour. Before a tester outside your organization can get a sign-in
email, set up your own email sender ("custom SMTP") here:
https://supabase.com/dashboard/project/mgiwopbaglgzxeaowzzt/auth/smtp

## My Transcripts

The third tab lists every transcript you made, newest first, with its name,
date, length and first line. It is the same on every device you sign in on.

- **Saved automatically.** When a file finishes, its turns, speaker names,
  times, file name, length and date go into the `transcripts` table, and its
  small Ogg Opus audio stays in Supabase Storage (in your own folder of the
  private `recordings` bucket). The audio is **kept until you delete the
  item**. Only uploads that never finished becoming a transcript are cleaned
  up (after a day).
- **Open** an item: it is shown by the same code as a fresh transcript
  (`transcript-view.js`): tap a time to play the kept recording from that
  moment, rename speakers, Show Timestamps, Show Fillers, Copy, Download.
  Speaker renames and corrected words are saved to the cloud.
- **Rename** an item. **Delete** an item ("Yes, Delete It / Keep It"): its
  transcript and its audio are both removed from Supabase. **Delete All** needs
  the word DELETE typed.
- **Storage meter** at the top ("Using 120 MB of 1 GB"): all the audio in the
  bucket, against the free plan's 1 GB (`storageLimitBytes` in
  `cloud-config.js`). An hour of audio is about 11 MB.
- **Transcripts saved in this browser by the earlier version** are offered
  once, after the first sign-in on that device, to be moved into the folder
  (only the words: their audio was already deleted by the earlier version).
- A file already transcribed on another device is recognised by its contents
  and shown from My Transcripts instead of being sent (and paid for) again.
- With no internet when a transcript finishes, it stays on the device and is
  saved to the folder by itself the next time the app opens.

## Show Fillers

A switch next to Show Timestamps. It changes the view at once, without
transcribing again, and nothing is deleted: the saved transcript keeps every
word.

- **Always shown**, because they carry meaning: mhm, m-hm, mm-hmm, uh-huh, mm,
  uh-uh, huh-uh, aha, uh-oh, huh, aw. A turn made only of these keeps its own
  number. (Written as two words, like "uh huh", they are also kept whole.)
- **Hidden when the switch is off**: um, umm, uhm, uh, uhh, er, erm, ah, hmm,
  hm, and back-to-back repeated words ("I I I think" becomes "I think").
- The app checks each word against these two lists itself
  (`ALWAYS_SHOWN` and `HESITATIONS` in `transcript-format.js`). Speechmatics'
  own "disfluency" label is not used, because it also marks some yes and no
  sounds.
- When hiding leaves a turn with no words, the turn disappears and the numbers
  close up; switch on again and it is back. The commas around a hidden
  hesitation go with it, and a sentence that began with one gets its capital
  letter.
- Copy and Download follow whichever view is showing. The word count too.
- Correcting words while fillers are hidden saves that turn as you see it.

## Colors (Sunset)

All in `styles.css`, as variables at the top: page dark navy `#2B3A51`; panels
and cards `#355C7D`; main buttons (Sign In, Start Listening, Start
Transcribing) coral `#FF7582` with dark navy text and a soft shadow; other
buttons plum `#725A7A` with white text; selected tab, (overlap) tags, outlines
and highlights rose `#C56C86`. Text on the dark background is white. Every box
people type in is white with near-black text. Pink is never used for text, and
there is no yellow or orange (warnings are white text with a rose bar, problems
white text in a rose outline). `tests/folder.test.js` checks every screen
against these rules.

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
2. **Upload** (`tus-upload.js`): to your own folder (`<your user id>/`) of the
   private Supabase Storage bucket `recordings`, in 6 MB pieces (resumable "tus" uploads). After each piece the
   place is saved, so an internet cut, a closed app or a phone restart carries
   on from the last piece. With no internet it waits and carries on by itself.
3. **Speechmatics**: the Edge Function `start-job` gives Speechmatics a
   short-lived signed link (1 hour) to fetch the audio. The app saves the
   Speechmatics job number and checks on it (`job-status`) until it is done.
   The app can be closed meanwhile: reopening it collects the transcript.
4. **Save**: the transcript (`job-result`) is saved on the device and in
   My Transcripts, and the uploaded audio is kept with it (see My Transcripts).

Everything is remembered in the browser (`cloud-store.js`, IndexedDB): the
prepared audio, the upload place, the job number and the finished transcript.
Choosing the same file again (recognised by its contents, not its name)
carries on, or shows the saved transcript, without paying twice.

The page only contains the public Supabase **publishable** key
(`cloud-config.js`), which by itself can do nothing but ask for a sign-in link.
The Speechmatics key and Supabase's secret keys exist only as Edge Function
secrets.

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
the end. Jobs Speechmatics refuses are not counted. Minutes are counted from the
length the server reads from the uploaded file and the length Speechmatics
reports, not from what the page says.

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
| Storage bucket, daily counter | [`supabase/setup_1.sql`](supabase/setup_1.sql), run once in the SQL Editor |
| Allowed emails, `transcripts` table, per-person database and storage rules | [`supabase/setup_2.sql`](supabase/setup_2.sql), run once in the SQL Editor (after `setup_1.sql`) |
| Sign-in | Supabase Auth, email link. Site URL and Redirect URL: `https://chuvic-etabag.github.io/transcriber-app/` |
| Edge Functions | [`supabase/functions/`](supabase/functions/): `check-limit`, `start-job`, `job-status`, `job-result`, `delete-audio` (plain JavaScript, shared code in `_shared/`). Each one checks the signed-in person first. `delete-audio` now only removes the upload of a job that did not become a saved transcript. |
| Function settings | [`supabase/config.toml`](supabase/config.toml) (Supabase's own JWT check is off; the functions check the sign-in themselves) |
| Deploy | GitHub Actions workflow **Deploy Edge Functions**, started by hand only |
| Secrets | Edge Function secret `SPEECHMATICS_API_KEY`; GitHub secrets `SUPABASE_ACCESS_TOKEN` and `SUPABASE_PROJECT_REF` |

## Files

| File | Purpose |
|---|---|
| `index.html` | The page |
| `styles.css` | Layout and colours |
| `app.js` | Signing in and out, tabs, Live tab controls, output tools (Copy, Download, Clear, word count), saved Live transcript |
| `auth.js` | Sign-in by email link, allowed emails, staying signed in, Sign Out |
| `folder.js` | The My Transcripts tab: list, storage meter, open, rename, delete, Delete All, moving old transcripts in |
| `cloud-db.js` | Reads and writes My Transcripts (the `transcripts` table and the kept recordings) |
| `transcript-view.js` | Shows a transcript as numbered turns (used by the File tab and My Transcripts): Show Timestamps, Show Fillers, renaming speakers, tap-to-play, corrections |
| `live.js` | Live microphone transcription (Chrome's Web Speech API, English) |
| `file.js` | File tab: prepare, upload, Speechmatics, saved progress, saving to My Transcripts |
| `transcript-format.js` | Speechmatics result to numbered speaker turns, the filler rules, and turns to text |
| `compact-audio.js` | Any recording to small mono Ogg Opus audio |
| `tus-upload.js` | Resumable upload to Supabase Storage |
| `cloud-store.js` | Saves each file's progress and transcript in IndexedDB |
| `cloud-config.js` | Supabase address and publishable key (public values only) |
| `cloud-api.js` | Calls the Edge Functions, as the signed-in person |
| `vendor/supabase/` | Supabase's JavaScript library (copied in, no CDN) |
| `audio-reader.js` | Reads audio and video files in sections, by format |
| `keep-awake.js` | Keeps the screen on (Live, and File while preparing and uploading) |
| `whisper-file.js`, `whisper-worker.js`, `job-store.js`, `vendor/transformers/` | Hidden on-device Whisper option (not loaded) |
| `supabase/` | Edge Functions, `config.toml`, `setup_1.sql`, `setup_2.sql` |
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
node tests/folder.test.js
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
  And the filler rules: every word on both lists, look-alike words, repeated
  words, and made-up transcripts that are mixed, only hesitations, and only
  yes and no sounds.
- `functions.test.mjs`: the Edge Functions, `setup_1.sql` and `setup_2.sql`,
  in a throwaway PostgreSQL, with Speechmatics, Storage and Auth played by the
  test: who may sign in, each person reaching only their own rows and
  recordings, functions refusing anyone not signed in, recordings kept.
- `folder.test.js`: in Chromium with a pretend Supabase
  (`tests/fake-supabase.js`, spoken to through the real Supabase library):
  sign-in and Sign Out, My Transcripts (list, open, play, rename, delete,
  Delete All, another device, moving old transcripts in), the Show Fillers
  switch, and the Sunset colors and title case on every screen.
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

Speechmatics and Supabase themselves cannot be reached from the build machine,
so the real services still need checking by hand after the SQL is run and the
functions are deployed (see `docs/notes/TR_Session_D_needs_Chu.md`).
