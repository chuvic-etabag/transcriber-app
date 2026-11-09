# TR Session B (11/9): Things That Need Chu

Phase 3 (file transcription) and Phase 4 (output tools) are built, tested and pushed to `main`.
These items need you.

## 1. docs/PLAN.md Was Not the Updated Version

You said PLAN.md was updated after Session A, but the copy on GitHub (in `main` and on every
branch) is still the version Session A committed. It has no "Phase 2B" in it. I followed your
message for Phase 3 and Phase 4, which asks for more than the plan does (resume after a restart,
Wake Lock, video files, large-file handling), and did not build Phase 2B, Phase 5 or later, ads,
subscriptions or "Best Accuracy".

If you have a newer PLAN.md on your computer, please upload it so the next session uses it.

## 2. Test on Your Phone

Automated tests ran in Chromium on the build machine with real Whisper, but only a real phone can
confirm speed, memory and Android's file picker. See the checklist in the session report
(computer first, then phone).

Things I could not check here:

- **How fast it is on your phone.** On the build machine (one processor core) Fast took about
  2 seconds per 30 seconds of audio and Accurate about 5 seconds. A phone is usually 2 to 4 times
  slower, so a 2-hour recording may take 30 to 60 minutes on Fast and 1.5 to 3 hours on Accurate.
  Please tell me roughly how long a 10-minute recording takes on each.
- **Memory on your phone** with a long video. If you see "Your phone ran out of memory", tell me
  the phone model, the file length and Fast or Accurate.
- **Android's file picker:** that choosing the same file again (after closing Chrome or
  restarting the phone) shows "Continuing where you left off".

## 3. Decisions for Later (No Action Needed Now)

- **Filipino accuracy.** Whisper's small models are much weaker at Filipino than English.
  Accurate is clearly better than Fast for Filipino (both are in the app). Better Filipino needs a
  bigger model, which is the "Best Accuracy" mode you said not to build yet.
- **Auto-Detect** only chooses between English and Filipino (the app's two languages), for each
  30-second piece. Other languages would come out wrong. Tell me if you want more languages.
- **First download size.** The first time, Chrome downloads the speech engine (about 27 MB, once)
  plus the model: Fast about 40 MB, Accurate about 80 MB. The app shows the right total and asks
  for Wi-Fi.
- **Speed boost for later.** Whisper runs on one processor core because GitHub Pages cannot send
  the special headers that allow more. A later phase (with the service worker in Phase 5, or the
  Capacitor app) could make it 2 to 3 times faster.
- **Old voice notes** in AMR format (some older Android recorders) and WMA files are not supported
  by Chrome, so the app says "This file type is not supported".
- **Fragmented MP4** files (made by some screen recorders) are read in one go, so they are limited
  to 80 MB. Normal phone recordings and videos have no limit.
