// Settings for the Transcriber Edge Functions.
// After changing anything here, run the "Deploy Edge Functions" workflow on GitHub.

// Who may sign in is NOT set here: it is the table "allowed_emails" (supabase/setup_2.sql).

// The most audio (all users together) that Speechmatics may be sent in one day.
// New jobs are refused once this many minutes have been transcribed today.
export const DAILY_LIMIT_MINUTES = 60;

// When "today" starts and ends for the daily limit.
export const TIME_ZONE = 'Asia/Manila';

// Web pages allowed to use these functions from a browser.
export const ALLOWED_ORIGINS = [
  'https://chuvic-etabag.github.io',
  'http://localhost',
  'http://127.0.0.1',
  'https://localhost',
  'capacitor://localhost'
];

// The private storage bucket the app uploads into (made by supabase/setup_1.sql).
export const BUCKET = 'recordings';

// How long the link that lets Speechmatics fetch the audio stays valid.
export const SIGNED_URL_SECONDS = 60 * 60;

// Uploads that never finished becoming a transcript are deleted after this long.
// Recordings of saved transcripts are kept until their owner deletes them.
export const DELETE_UNUSED_UPLOADS_AFTER_HOURS = 24;

// Speechmatics batch API and the transcription settings:
// English, the most accurate model ("enhanced"), and who-said-what (speaker diarization).
// Every word comes back with its start and end time (Speechmatics always includes them).
// Disfluencies ("um", "uh", "mhm") are kept: Speechmatics keeps them unless asked to
// remove them (remove_disfluencies), and this app never asks.
export const SPEECHMATICS_URL = 'https://asr.api.speechmatics.com/v2';
export const TRANSCRIPTION_CONFIG = {
  language: 'en',
  operating_point: 'enhanced',
  diarization: 'speaker'
};
