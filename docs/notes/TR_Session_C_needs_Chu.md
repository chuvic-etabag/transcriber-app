# TR Session C (11/11): Things That Need Chu

Every file in the File tab now goes to Speechmatics, and the transcript uses numbered speaker
turns. It is built, tested on the build machine and merged into `main`. It **will not work until
you do steps 1 to 5 below**: until then the File tab says "The transcription service is not set
up yet."

## Do These, In Order

1. **Make a Supabase access token** (for GitHub to deploy the functions):
   https://supabase.com/dashboard/account/tokens
   Click "Generate new token", name it `GitHub deploy`, and copy it (it is shown only once).

2. **Add the two GitHub secrets.** Open this link once for each secret:
   https://github.com/chuvic-etabag/transcriber-app/settings/secrets/actions/new
   - Name `SUPABASE_ACCESS_TOKEN`, Secret: the token from step 1.
   - Name `SUPABASE_PROJECT_REF`, Secret: `mgiwopbaglgzxeaowzzt`

3. **Run the SQL** (makes the private storage bucket, the upload rule and the daily counter):
   https://supabase.com/dashboard/project/mgiwopbaglgzxeaowzzt/sql/new
   Paste everything from `supabase/setup_1.sql`
   (https://github.com/chuvic-etabag/transcriber-app/blob/main/supabase/setup_1.sql, use the
   "Copy raw file" button) and press Run. It should say "Success. No rows returned". Running it
   again later is safe.

4. **Check the Speechmatics key is saved** as an Edge Function secret named exactly
   `SPEECHMATICS_API_KEY`:
   https://supabase.com/dashboard/project/mgiwopbaglgzxeaowzzt/functions/secrets

5. **Deploy the Edge Functions:**
   https://github.com/chuvic-etabag/transcriber-app/actions/workflows/deploy-edge-functions.yml
   Click "Run workflow", keep branch `main`, click the green "Run workflow". After 1 to 2 minutes
   it should show a green tick, and the last step lists five functions: `check-limit`,
   `start-job`, `job-status`, `job-result`, `delete-audio`. You can also see them here:
   https://supabase.com/dashboard/project/mgiwopbaglgzxeaowzzt/functions

Run the workflow again whenever the functions change (for example after changing the daily
limit). It never runs by itself.

## Then Test on Your Computer in Chrome

Open https://chuvic-etabag.github.io/transcriber-app/ (press Ctrl+Shift+R once so Chrome loads the
new version). Use short recordings first: every test uses some of the 60 free minutes a day.

1. **Live tab:** no language picker. Start Listening, say a sentence in English, Stop.
2. **File tab, short recording with two people** (1 to 3 minutes, MP3 or M4A):
   Choose Audio or Video File, then Start Transcribing. You should see "Checking with the
   transcription service", "Preparing the audio… %", "Uploading… %", "Speechmatics is
   transcribing…", then "Done. Transcribed … of audio." Check:
   - Turns look like `1. [00:00:05 – 00:00:11] Speaker 1: ...`, numbered in order.
   - Short words like "mhm", "okay", "uh-huh", "no" are there. Short responses said while the
     other person talks appear as their own turn marked `(overlap)`.
   - Tap a time: the recording plays from that moment.
   - Tap "Speaker 1" (or Rename Speaker 1), type a name, Save Name: every Speaker 1 label changes.
   - Turn Show Timestamps off and on: the times disappear and come back at once.
   - Copy, paste into Notepad: it matches the view (with or without times). Same for Download
     Text File.
   - Reload the page: the transcript, the names and your Show Timestamps choice are still there.
3. **Choose the same file again:** it says "Already transcribed" and does not send it again.
4. **Video:** an MP4 from your phone. Only the sound is used.
5. **Interruptions** (a 20 to 40-minute recording, so the upload takes a moment):
   - While "Uploading… %" shows, turn off Wi-Fi: it says "No internet connection. Waiting…".
     Turn Wi-Fi back on: it carries on from where it stopped.
   - Start another long file, and close the tab while it uploads. Reopen the app, choose the
     same file: "Continuing where you left off", and it does not prepare the audio again.
   - Close the tab while it says "Speechmatics is transcribing". Reopen the app and open the
     File tab: it collects the transcript by itself (no need to choose the file).
6. **File not supported:** choose a .txt or .pdf file: "This file type is not supported."
7. **No internet:** turn off Wi-Fi, choose a file, Start Transcribing: "No internet connection…".
8. **Check the clean-up in Supabase:** after a transcript is done, the `recordings` bucket should
   have no file left for it:
   https://supabase.com/dashboard/project/mgiwopbaglgzxeaowzzt/storage/buckets/recordings
9. **Daily limit (optional):** to see the message without using up minutes, set
   `DAILY_LIMIT_MINUTES` to `0` in `supabase/functions/_shared/settings.js` (edit it on GitHub),
   run the deploy workflow, try a file: "Today's transcription time is used up…". Then set it
   back to `60` and run the workflow again.

If something fails, the Edge Function logs say why:
https://supabase.com/dashboard/project/mgiwopbaglgzxeaowzzt/functions (click a function, then Logs).
Tell me the message on the screen and what the log says.

## Things I Decided (Tell Me If You Want Them Different)

- **docs/PLAN.md is still the old version.** As in Session B, the PLAN.md on GitHub (in `main`
  and every branch) has no transcript format in section 3, and still lists Filipino and Whisper.
  I followed the format in your message. Where the message did not say, I chose:
  - `(overlap)` goes right after the speaker's name: `3. [00:00:17 – 00:00:17] Speaker 2 (overlap): Mhm.`
  - One turn per line, no blank line between turns, in Copy and Download.
  - Times are always hours:minutes:seconds, rounded down to the second.
  - A "short response" is up to 4 words and up to 3 seconds. A pause of 5 seconds or more starts a
    new turn. A turn by one person that runs over a minute is split at the next end of a sentence
    (so a lecture is not one huge paragraph). These numbers are in `RULES` at the top of
    `transcript-format.js`.
  - Speechmatics' "unknown speaker" is shown as "Unknown Speaker".
  If you have the newer PLAN.md on your computer, please upload it to `docs/PLAN.md` and tell me
  what differs.
- **Daily limit:** the 60 minutes is checked before each new job. A job that starts while there is
  still time left is allowed to finish, so one day can go over 60 by up to the length of that last
  file. (Otherwise a 3-hour recording could never be transcribed with a 60-minute limit.) If you
  want a hard cap instead ("refuse a file that would go past 60"), tell me. "One day" is Philippine
  time (midnight to midnight). Jobs Speechmatics refuses are not counted. The minutes are counted
  from the length Speechmatics measures, not just what the page says.
- **Disfluencies:** Speechmatics keeps "um", "uh", "mhm" unless it is asked to remove them, so the
  app simply never asks. Word timings are always included by Speechmatics; there is no setting.
- **Speechmatics address:** the functions use `https://asr.api.speechmatics.com/v2` (the standard
  address). If your Speechmatics account is set up for the US region and jobs fail with an
  authorisation error, change `SPEECHMATICS_URL` in `supabase/functions/_shared/settings.js`.
- **Live tab language:** English (US), Chrome's most widely available English. English
  (Philippines) is a one-word change (`LIVE_LANGUAGE` in `app.js`) if it understands you better.
- **Old Whisper transcript:** if your phone still has a File transcript from Session B, it is
  still shown (and can be copied or cleared) until you transcribe a new file.
- **Files left on the server:** uploads that never became a transcript (for example a file you
  gave up on) are deleted after 24 hours, the next time anyone starts a job.
- **Speechmatics keeps its own copy of each finished job for a while** (its normal retention). The
  app does not delete jobs at Speechmatics. Tell me if you want that.

## Could Not Check From Here

- The build machine cannot reach Speechmatics or your Supabase project, so the real services were
  played by the tests (with Speechmatics' exact response format, and the SQL in a real
  PostgreSQL). The real trip needs your test above.
- **Upload rule:** the SQL allows the page to upload but not to read, list or delete. Supabase's
  documentation says uploads need only that. If uploads fail with "The upload was refused by the
  server", tell me (and the Storage log line); the fix is a small extra SQL file.
- **Phone speed:** on the build machine a 3-hour MP3 took 98 seconds to prepare (33 MB). A phone
  will be slower, perhaps 3 to 8 minutes for 3 hours. Please tell me how long a long file takes on
  your phone.
