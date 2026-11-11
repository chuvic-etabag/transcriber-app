# Transcriber App: Build Plan

*Updated 11 November 2026*

## 1. Goal

An English transcription app with the best possible accuracy. It turns speech into text in two ways:

1. **Live microphone:** record a conversation, see a live preview while talking, and get a high-accuracy transcript after pressing Stop.
2. **Audio or video file upload:** pick a recording (MP3, M4A, WAV, OGG, WEBM, FLAC, AAC, MP4, MOV, MKV and more) and get a high-accuracy transcript.

Accuracy is the top priority. Every final transcript, for free and premium users alike, comes from the best speech service. The app never offers a low-accuracy final transcript.

It starts as a web app (Chrome, hosted on GitHub Pages) and later becomes an Android app with Capacitor, reusing the same code.

## 2. Decisions made

1. **Language:** English only. Filipino and the language picker are removed.
2. **Speech service:** Speechmatics, English, Enhanced model (its most accurate single-language model), batch transcription.
3. **Live mode (Option A):** Chrome's built-in speech recognition shows a free live preview while talking. The full audio is recorded at the same time. After Stop, the recording goes to Speechmatics and its transcript replaces the preview. Live streaming to Speechmatics is not used, because batch is more accurate and cheaper.
4. **Free vs premium:** the only difference is length. Free users transcribe files up to 3 minutes. Premium users have no limit. Both get the same best accuracy.
5. **Ads or subscription:** users always get two choices for a locked feature: watch a rewarded ad, or subscribe. Ads and subscriptions launch with the Android app (AdMob rewarded ads, Google Play Billing). The web app stays free for testing.
6. **App name:** Transcriber (placeholder).
7. **My Transcripts folder, saved in the cloud:** transcripts go in the Supabase database and the compact audio goes in Supabase Storage (about 11 MB per hour of audio, so the free 1 GB holds about 90 hours). Users sign in with an email link (no password). For now only emails on an allowed list may sign in; the list starts with Chu's login email, chuvicame@gmail.com, and she can add tester emails later. Each item can be opened or deleted (deleting removes both transcript and audio), with Delete All and a storage meter ("Using 120 MB of 1 GB"). Google sign-in can be added later. Note: a free Supabase project pauses after about a week with no activity and is restored from the Supabase website.
8. **Session code for Claude Code runs:** TR.
9. **Show Fillers switch:** hides hesitations only. Always shown, because they carry meaning: mhm, m-hm, mm-hmm, uh-huh, mm, uh-uh, huh-uh, aha, uh-oh, huh, aw. Hidden when the switch is off: um, umm, uhm, uh, uhh, er, erm, ah, hmm, hm, and back-to-back repeated words ("I I I think"). The app checks each word against these lists instead of trusting Speechmatics' disfluency label. Broken-off sounds ("th-th-the") are usually not written by Speechmatics, so they cannot be shown.
10. **Colors (Sunset palette):** page background dark navy #2B3A51; panels and cards #355C7D; main buttons coral #FF7582 with dark navy text and a shadow so they pop; secondary buttons plum #725A7A with white text; highlights, outlines and the selected tab rose #C56C86. Text on the dark background is white. Every box people type in (transcript editor, email box, rename box, search) is always white with near-black text. Pink is never used for text, only for buttons, outlines and highlights. No yellow or orange anywhere.

## 3. Transcript format

- Speaker labels: Speaker 1, Speaker 2, and so on (Speechmatics speaker diarization). Users can rename a speaker (for example "Speaker 1" to "Teacher") and every label for that speaker changes.
- Every turn is numbered in order of when it starts.
- Every turn shows a start-to-end time range.
- Short overlapping responses ("mhm", "okay", "uh-huh", "no") are kept as their own numbered turns with their own time range, placed at the moment they were said, and tagged "(overlap)" when they start while the other speaker is still talking. Disfluency removal must be off so these words are kept.
- A **Show Timestamps** switch turns the time ranges on or off without transcribing again.
- Copy and Download keep whichever view is showing.
- Tapping a timestamp plays the recording from that moment, so the user can check the words.

Example:

```
1. [00:00:05 – 00:00:11] Speaker 1: Good morning, everyone. Let's start with the reading.
2. [00:00:08 – 00:00:08] Speaker 2 (overlap): Mhm.
3. [00:00:12 – 00:00:13] Speaker 2: Which page are we on?
4. [00:00:14 – 00:00:15] Speaker 1: Page forty-two.
5. [00:00:15 – 00:00:15] Speaker 2 (overlap): Okay.
```

Known limit: very quick overlapping sounds are the hardest thing for any service; most will be caught, not all.

## 4. Technical choices

| Part | Choice | Why |
|---|---|---|
| Code | Plain HTML, CSS, JavaScript | Simple, and easy to wrap with Capacitor later |
| Final transcription | Speechmatics batch API, English, Enhanced model, speaker diarization, word timings | Best accuracy |
| Service key | Kept on a small server piece (for example a Supabase Edge Function), never in the web page | The key must stay secret |
| Uploads | Resumable: the file is sent in small pieces, each piece remembered; after an internet cut it continues from the last piece | Large files and weak internet |
| Live preview | Chrome's Web Speech API (`SpeechRecognition`) | Free, instant preview only |
| Recording | MediaRecorder alongside the live preview, with noise suppression, echo cancellation and automatic volume levelling | The recording is what gets transcribed |
| Keep screen on | Screen Wake Lock API (already built) | Recording and uploads don't stop when the phone would sleep |
| Large files | Read in sections (already built in TR Session B) | 2 to 3 hour files work on a phone |
| Saved progress | Browser storage (IndexedDB) | Resume after the app closes |
| Hosting | GitHub Pages | Free HTTPS link |

The on-device Whisper engine built in TR Session B is no longer the main engine. Whether to keep it as an offline backup or remove it is decided later.

## 5. Build status and phases

**Done**
- TR Session A 11/9: project setup, live microphone preview, Keep Screen On.
- TR Session B 11/9: file tab (audio and video, large files in sections, resume, Cancel), on-device Whisper, Copy / Download Text File / Clear / word count on both tabs.

**Done: TR Session C 11/11 (Speechmatics)**
- Server piece holding the Speechmatics key; resumable uploads.
- File tab sends files to Speechmatics (English, Enhanced, speaker diarization, disfluencies kept).
- Transcript format from section 3.
- Remove the language picker and Filipino.

**Next: TR Session D 11/11**
- Sign-in by email link with an allowed list, and the cloud My Transcripts folder (decision 7).
- Show Fillers switch (decision 9).
- Sunset colors (decision 10).

**Then: live mode improvements**
- Gentler repeat filter, so real words are never deleted.
- Faster restart after pauses.
- Record the full audio alongside the live preview; after Stop, send it to Speechmatics and replace the preview ("Improving Transcript… 40%").
- Running timer; tested with a 30-minute session.

**Later phases**
- Make it installable (PWA).
- Polish: layout, dark mode, "How to Use" note.
- Android app version (section 6), with ads and subscriptions.

## 6. Android app version (later, with Capacitor)

- Background work: if the app is minimized or another app is opened, recording, uploading and transcribing keep running, with a progress notification (for example "Uploading… 60%") that can open the app or stop the job.
- Screen-off work: the same jobs continue with the screen off.
- Automatic re-upload: if the internet cuts off during an upload, the app waits and continues from the last piece once the connection returns, even while minimized. The notification shows "Waiting for internet…" while it waits.
- Rewarded ads (AdMob) and subscriptions (Google Play Billing).

## 7. Pending decisions

- Whether watching an ad can unlock one file over 3 minutes for free users, and how many ads a very long file needs.
- Whether free users get a daily limit on 3-minute files, to control service costs.
- Keep or remove the on-device Whisper engine.

## 8. Later (not in the first version)

- Export as .docx or .srt subtitles.
- Summaries.
- Custom word list (names and terms) sent to Speechmatics.

## 9. Known limits of the web app

- Recording and uploads pause if the screen is turned off or another app is opened. Keep the app open on screen. (Fixed in the Android app version.)
- The live preview while talking is rough; the final transcript after Stop is the accurate one.
- Accuracy drops with heavy background noise and people talking over each other.
