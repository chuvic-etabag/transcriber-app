# TR Session A (11/9): Things That Need Chu

Phase 1 and Phase 2 are built and pushed to `main`. These items need you.

## 1. Check That GitHub Pages Is On

I could not open github.io from the build machine, so I could not confirm the live link loads.

- Open https://chuvic-etabag.github.io/transcriber-app/ on your phone.
- If it shows a 404, go to the repository on GitHub: **Settings → Pages → Build and deployment**,
  choose **Deploy from a branch**, branch **main**, folder **/ (root)**, then **Save**.
  The link usually works within 1 to 2 minutes.

## 2. Test Live Transcription on Your Android Phone

Automated tests use a pretend microphone, so only a real phone can confirm these:

- Words appear while you speak, in all three languages (English (US), English (Philippines), Filipino).
- Words are **not repeated** in the transcript. Some Android versions of Chrome send the same
  words twice; the app tries to catch this. If you see doubled words, note the language and
  roughly what you said.
- Listening keeps going after a pause of 10 to 20 seconds without you tapping anything.
- If Filipino says "This language is not available", tell me your phone model and Android version.

## 3. Decisions for Later (No Action Needed Now)

- **Punctuation and capital letters:** Chrome's speech service on Android usually returns plain
  lowercase words with no periods. The app shows exactly what Chrome gives. We can add simple
  capitalization later if you want it.
- **App name:** still the placeholder "Transcriber". Changing it is a quick edit in
  `index.html` and `manifest.json`.
- **Copy, Download and Clear buttons** come in Phase 4. For now, press and hold in the
  transcript box to select and copy text.
