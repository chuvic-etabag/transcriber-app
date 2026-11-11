# TR Session D (11/11): Things That Need Chu

Sign-in by email link, the My Transcripts folder, the Show Fillers switch and the Sunset colors are
built, tested on the build machine and merged into `main`. **Sign-in will not work until you do
steps 1 to 3 below.** Until then the app shows the sign-in screen and says "Sign-in is not set up
yet."

Doing these steps also closes two doors left open by TR Session C: until step 1 anyone with the
page could still upload, and until step 3 the old Edge Functions still answer without a sign-in.

## Do These, In Order

(If you never did the five steps in `TR_Session_C_needs_Chu.md`, do those first.)

1. **Run the new SQL** (allowed emails, the My Transcripts table, the rules that give each person
   only their own transcripts and recordings):
   - Open https://github.com/chuvic-etabag/transcriber-app/blob/main/supabase/setup_2.sql and click
     the "Copy raw file" button (two overlapping squares, top right of the file).
   - Open https://supabase.com/dashboard/project/mgiwopbaglgzxeaowzzt/sql/new , paste, and press
     **Run**. If Supabase warns about "destructive operations", choose **Run this query** (it only
     replaces this app's own rules). It should say "Success. No rows returned". Running it again
     later is safe.
   - If it says "Run supabase/setup_1.sql first", run `setup_1.sql` the same way, then this again.

2. **Tell Supabase where the sign-in link returns to:**
   https://supabase.com/dashboard/project/mgiwopbaglgzxeaowzzt/auth/url-configuration
   - Field **Site URL**: `https://chuvic-etabag.github.io/transcriber-app/` then the button
     **Save changes**.
   - Under **Redirect URLs**: button **Add URL**, type
     `https://chuvic-etabag.github.io/transcriber-app/` , then **Save URLs**.

   Then check (usually nothing to change) on
   https://supabase.com/dashboard/project/mgiwopbaglgzxeaowzzt/auth/providers
   - **Allow new users to sign up**: on. (The allowed list still decides who gets in. If this is
     off, even your own first sign-in is refused.)
   - **Email** provider: **Enabled**, with **Confirm email** on.

3. **Deploy the Edge Functions** (they changed: every one now checks who is signed in):
   https://github.com/chuvic-etabag/transcriber-app/actions/workflows/deploy-edge-functions.yml
   Click **Run workflow**, keep branch `main`, click the green **Run workflow**. After 1 to 2
   minutes it should show a green tick.

I could not open the Supabase dashboard from here, so a button may be worded slightly differently
from what I wrote. The links and the values are exact.

## About the Sign-In Email (Please Read)

Supabase's built-in email service sends **only to people in your own Supabase organization, and
only 2 emails an hour** (for the whole project).

- If `chuvicame@gmail.com` is the email you log in to Supabase with, your sign-in email will
  arrive. From "Supabase Auth", subject like "Confirm Your Signup" the first time and "Your Magic
  Link" after that. Look in Spam too.
- If you log in to Supabase with a different email, the app will say the email could not be sent.
  Then either add `chuvicame@gmail.com` to your organization's team
  (https://supabase.com/dashboard/org/_/team) or set up your own sender (next point).
- **Before any tester outside your organization can sign in**, set up your own email sender
  ("custom SMTP", for example with a free Resend or Brevo account):
  https://supabase.com/dashboard/project/mgiwopbaglgzxeaowzzt/auth/smtp . Tell me when you want
  this and I will write the exact steps.
- 2 an hour means: if you ask for a link three times in an hour, the third says "Too many sign-in
  emails". One link is enough: you stay signed in on that device until you tap Sign Out.
- A link works once and for one hour. Open it on the device you want to sign in on, in Chrome.

## Adding a Tester Later (One Line)

In https://supabase.com/dashboard/project/mgiwopbaglgzxeaowzzt/sql/new paste this, with their email
in small letters, and press **Run**:

```sql
insert into public.allowed_emails (email) values ('tester@example.com');
```

Nothing to deploy. (And see the email note above.) To remove someone:
`delete from public.allowed_emails where email = 'tester@example.com';`

## Then Test on Your Computer in Chrome

Open https://chuvic-etabag.github.io/transcriber-app/ and press Ctrl+Shift+R once so Chrome loads
the new version. Use short recordings: each one uses some of the 60 minutes a day.

**Sign-in**
1. You see only a dark navy page with a "Sign In" card: no tabs, no transcript.
2. Type `test@example.com`, click Sign In: "This app isn't open to new users yet."
3. Type `chuvicame@gmail.com`, click Sign In: "Check your email…". Open the email, click the link.
   The app opens with three tabs, and your email and a Sign Out button at the top.
4. Close the tab, open the app again: still signed in. Reload: still signed in.
5. Click Sign Out: back to the sign-in screen. (Sign in again to carry on. Mind the 2 emails an
   hour.)

**Colors** (on every screen you pass)
6. Page dark navy, panels blue, Sign In / Start Listening / Start Transcribing coral with dark
   text and a shadow, Copy / Download / Rename / Delete plum with white text, the selected tab
   rose, every typing box white with dark text. No yellow, no orange, no pink words.

**File tab and My Transcripts**
7. File tab: choose a 1 to 3 minute recording with two people, Start Transcribing. It ends with
   "Done. Transcribed … It is saved in My Transcripts."
8. My Transcripts tab: the meter ("Using 0.3 MB of 1 GB" or similar), then your recording with its
   name, today's date, its length and its first line.
9. Click Open: the same transcript. Click a time: the recording plays from there (this is the copy
   kept in the cloud). Click a speaker, rename them. Change a word. Try Show Timestamps, Copy
   (paste into Notepad) and Download Text File.
10. Click Back to My Transcripts, then Open again: your speaker name and changed word are still
    there.
11. Rename the item (Rename, type a name, Save Name).
12. Check Supabase really has both parts:
    - the row: https://supabase.com/dashboard/project/mgiwopbaglgzxeaowzzt/editor (table
      `transcripts`)
    - the audio: https://supabase.com/dashboard/project/mgiwopbaglgzxeaowzzt/storage/buckets/recordings
      (a folder named with a long id, with one `.ogg` file in it)
13. Transcribe a second short recording. It appears above the first one (newest first).
14. Delete the first: Delete, then Keep It (nothing happens), Delete again, Yes, Delete It. It is
    gone from the list, and in Supabase both its row and its `.ogg` file are gone.
15. Delete All: the Yes, Delete Everything button stays grey until you type `DELETE` (capital
    letters). Do it only if you are happy to lose the test items.
16. If this browser had transcripts from TR Session C, a box offered once to "Move Them" into My
    Transcripts right after your first sign-in. If you saw it, tell me whether they arrived.

**Show Fillers** (use a recording where someone says "um" or "uh" and "mhm")
17. In the transcript, switch Show Fillers off: "um", "uh" and doubled words vanish at once;
    "mhm" and "uh-huh" stay. A turn that was only "Um." disappears and the numbers close up.
    Switch it on: everything is back.
18. With it off, Copy and paste into Notepad: it matches what you see. Same for Download.
19. Please look at what Speechmatics really writes for yes and no sounds in your recordings
    (for example "Mhm", "Mm-hmm", "Uh huh"). If you see a spelling that is not on your list being
    hidden or shown wrongly, tell me the exact spelling.

**Another device**
20. On your phone, open the app, sign in the same way (open the email on the phone). My
    Transcripts shows the same items. Open one and tap a time.

**Everything from before**
21. Live tab: Start Listening, say a sentence, Stop. Copy, Download, Clear still work.
22. File tab: choose the same file again: "Already transcribed" and it is not sent again.

If something fails, tell me the message on the screen. For transcription problems the Edge
Function logs say why: https://supabase.com/dashboard/project/mgiwopbaglgzxeaowzzt/functions
For sign-in problems: https://supabase.com/dashboard/project/mgiwopbaglgzxeaowzzt/logs/auth-logs

## Things I Decided (Tell Me If You Want Them Different)

- **docs/PLAN.md:** your new plan arrived as `docs/PLAN (1).md`, next to the old `docs/PLAN.md`.
  I read the new one, put it in place as `docs/PLAN.md`, removed the old copy, and marked
  TR Session D as done in section 5.
- **The whole app is behind sign-in, the Live tab too.** You said transcribing only works when
  signed in, and Live will send its recording to Speechmatics in the next session.
- **Sign Out signs out this device only.** Your other devices stay signed in.
- **The allowed list is a table in Supabase** (`allowed_emails`), not a file in the app, so adding
  a tester is one line of SQL with nothing to deploy. Emails are kept in small letters.
- **The 60 minutes a day is still for everyone together**, as in TR Session C.
- **Repeated words:** any word said twice or more in a row becomes one when fillers are hidden,
  as you asked ("I I I think"). This also turns "no, no, no" into "no" and "very, very good" into
  "very good". It never joins across the end of a sentence ("It was good. Good food."), never
  touches numbers ("5 5 5"), and never touches the always-shown sounds ("Mhm, mhm." stays).
  Repeated groups of words ("I think I think") are left alone.
- **Commas around a hidden hesitation go with it:** "that, uh, we should" becomes "that we
  should". The small cost: "Yes, um, I agree" becomes "Yes I agree".
- **Sounds not on either list are always shown** (for example "hmmm", "mmm", "ahh"), because
  showing is the safe side. Tell me if you want any added to the hidden list.
- **Two-word yes and no sounds** ("uh huh", "mm hmm", "uh oh", "uh uh" with nothing between them)
  are kept whole, so "uh huh" can never lose its "uh" and turn into "huh".
- **Correcting words while fillers are hidden** saves that turn as you see it (so the "um" you
  could not see is dropped from that one turn). Other turns are untouched.
- **Show Fillers starts switched on** (everything shown, as before). Your choice is remembered on
  each device.
- **Colors where your list did not say:**
  - Stop Listening is still coral (it is the same main button), with a rose ring while listening.
  - Cancel, and buttons that delete, are plum; "Yes, Delete It" and "Yes, Delete Everything" have
    a rose outline.
  - Messages are all white: a warning has a rose bar on its left, a problem has a rose outline.
    (The old amber and red would have broken "no yellow or orange".)
  - The (overlap) tag is a small rose-outlined pill with dark words, because the transcript box is
    white and pink is never used for text.
  - Times in the transcript are dark with a rose underline.
  - The words you are correcting stay white with a rose outline around them.
  - The app icon is redrawn in the same colors.
- **The storage meter** counts all audio in the bucket (every user together), because the 1 GB
  belongs to the whole project. Transcript text is tiny and not counted.
- **Old transcripts moved from this browser have no audio** (TR Session C deleted audio after
  transcribing). Tapping a time in one of them says so.
- **Deleting an item** also forgets it on the device you delete from, so choosing that file again
  transcribes it afresh (and uses minutes). On your other devices the File tab may still show its
  old copy until you clear it.
- **Clean-up of unfinished uploads:** an upload is deleted after a day only if it never became a
  transcript and has no Speechmatics job that could still be collected (Speechmatics keeps a job
  about a week). Audio of saved transcripts is never touched.
- **The `delete-audio` function is kept** but changed: it now only removes the upload of a job
  that did not become a saved transcript, and only for the person who started it.
- **A file transcribed on one device is recognised on another** (by its contents) and shown from
  My Transcripts instead of being paid for again.
- **Supabase's JavaScript library is copied into the app** (`vendor/supabase/`, 220 KB), so
  sign-in does not depend on another website. It is still plain HTML, CSS and JavaScript.

## Could Not Check From Here

- The build machine cannot reach Supabase or Speechmatics. The tests played both (the SQL ran in a
  real PostgreSQL with stand-ins for Supabase's own tables; the page talked to a pretend Supabase
  through the real Supabase library). The real trip needs your test above. The parts I am least
  able to prove from here:
  - **the sign-in email arriving** (see the email note);
  - **the upload rule**: the SQL lets a signed-in person add, read and delete only inside their
    own folder. If an upload says "The upload was refused by the server", tell me, with the line
    from https://supabase.com/dashboard/project/mgiwopbaglgzxeaowzzt/logs/storage-logs ;
  - **playing the kept audio** from a time, on your phone.
- **A free Supabase project pauses after about a week with no use.** If the app suddenly cannot
  sign in or load My Transcripts, open https://supabase.com/dashboard/project/mgiwopbaglgzxeaowzzt
  and click the button to restore it. Nothing is lost.
