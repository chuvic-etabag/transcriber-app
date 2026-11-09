# Transcriber Web App: Build Plan

## 1. Goal

A web app that runs in Chrome on Android and turns speech into text in two ways:

1. **Live microphone:** tap Start, speak, and the words appear on screen as you talk.
2. **Audio file upload:** pick a recording (MP3, M4A, WAV, OGG, WEBM) and get a full transcript.

It must be installable from Chrome ("Install app" / "Add to Home screen") and built so it can later be wrapped into an Android APK with Capacitor, reusing the same code.

## 2. Technical choices

| Part | Choice | Why |
|---|---|---|
| Code | Plain HTML, CSS, JavaScript (no framework) | Simple to read, edit, and wrap with Capacitor later |
| Live mic | Chrome's Web Speech API (`webkitSpeechRecognition`) | Built into Chrome on Android, fast, supports English and Filipino. Needs internet. |
| File transcription | Whisper speech model running in the browser through Transformers.js | Chrome's speech API cannot read files. Whisper runs on the phone, so the audio is not uploaded anywhere. |
| Model | `whisper-base` (multilingual), with `whisper-tiny` as a "fast" option | Base is more accurate; tiny loads and runs faster on a phone |
| Heavy work | A Web Worker | Keeps the screen from freezing while Whisper runs |
| Installable app | Web app manifest + service worker (PWA) | Lets Chrome install it with its own icon; caches the app files |
| Hosting | GitHub Pages | Free, gives an HTTPS link (the microphone only works over HTTPS) |

## 3. Screens and features

**One main screen with two tabs: "Live" and "File".**

Live tab:
- Language picker: English (US), English (Philippines), Filipino
- Big Start / Stop button with a "listening" indicator
- Text appears live; unconfirmed words shown in grey until confirmed
- Auto-restart when Chrome stops listening after a pause, so long sessions keep going until you press Stop

File tab:
- "Choose audio file" button
- Language picker (Auto-detect, English, Filipino) and speed picker (Fast / Accurate)
- Progress messages: downloading model (first time only), reading audio, transcribing with a percentage
- Optional timestamps beside each section of the transcript

Shared output area (both tabs):
- Editable transcript box
- Buttons: Copy, Download as .txt, Clear
- Word count

## 4. Build phases

**Phase 1: Project setup**
- Create the GitHub repository and folder structure:
  ```
  index.html
  styles.css
  app.js            (screen logic, tabs, buttons)
  live.js           (microphone transcription)
  file.js           (file upload, talks to the worker)
  whisper-worker.js (runs the Whisper model)
  manifest.json
  service-worker.js
  icons/            (192px and 512px app icons)
  docs/PLAN.md      (this file)
  ```
- Turn on GitHub Pages so every update gets a live link.

**Phase 2: Live microphone**
- Ask for microphone permission with a clear message.
- Start/stop recognition, show interim and final text.
- Handle errors in plain words: permission denied, no internet, no speech heard.
- Auto-restart after pauses until Stop is pressed.

**Phase 3: File transcription**
- Read the chosen file and convert it to 16 kHz mono audio (what Whisper needs).
- Load Whisper in the Web Worker, show download progress, keep the model cached so it downloads only once.
- Transcribe in 30-second chunks so long recordings work and progress can be shown.
- Show a warning for very long files (for example, over 30 minutes) that it will take a while on a phone.

**Phase 4: Output tools**
- Copy, Download .txt (file name includes the date and time), Clear with a confirm step, word count.
- Save the current transcript in the browser so it survives an accidental refresh.

**Phase 5: Make it installable (PWA)**
- Add manifest, icons, theme color, and service worker.
- Confirm Chrome on Android shows "Install app".

**Phase 6: Testing on the Android phone**
- Live: 1 minute of English, 1 minute of Filipino, a session with long pauses.
- File: a short voice memo (M4A), a 10-minute MP3, a 30-minute lecture recording.
- Check: no freezing, progress shows, Copy and Download work, app installs and opens full screen.

**Phase 7: Polish**
- Clean, readable layout for a phone screen, large buttons, dark mode support.
- Short "How to use" note on first open.

## 5. Later (not in the first version)

- Wrap into an APK with Capacitor for direct install or the Play Store.
- Record with the mic and transcribe offline with Whisper.
- Transcript history list.
- Export as .docx or .srt subtitles.
- Better handling of Hiligaynon and mixed-language speech.

## 6. Known limits

- Live mode needs internet (Chrome sends the audio to Google's speech service).
- The first file transcription downloads the Whisper model (roughly 40 to 150 MB depending on the speed setting). Use Wi-Fi.
- Long files transcribe slowly on a phone. A 30-minute file may take several minutes or more.
- Accuracy drops with background noise, overlapping speakers, and Hiligaynon.

## 7. Decisions to confirm before building

1. Languages for the first version (proposed: English and Filipino).
2. App name.
3. Whether transcripts should be saved in a history list now or later (proposed: later).
