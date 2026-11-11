-- Transcriber: one-time setup for Supabase (project "transcriber").
-- Paste all of this into the Supabase SQL Editor and press Run.
-- Running it again is safe: it only adds what is missing and updates the rest.
--
-- It makes:
--   1. A private storage bucket "recordings" for the small audio files the app uploads
--      (50 MB each at most, Ogg audio only).
--   2. A rule that lets the app upload into recordings/uploads/ but NOT read, list,
--      change or delete anything there. Only the Edge Functions (with the secret
--      service key) can read or delete the files.
--   3. A table "transcription_jobs" that counts the minutes sent to Speechmatics each
--      day, so the daily limit can be enforced. Only the Edge Functions can see it.
--   4. The small database functions the Edge Functions use.
--
-- The daily limit itself (60 minutes) is NOT here: it is DAILY_LIMIT_MINUTES in
-- supabase/functions/_shared/settings.js.

-- ---------- 1. Private bucket ----------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('recordings', 'recordings', false, 52428800, array['audio/ogg'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- ---------- 2. Upload rule ----------

drop policy if exists "Transcriber: the app can upload recordings" on storage.objects;
create policy "Transcriber: the app can upload recordings"
  on storage.objects
  for insert
  to anon, authenticated
  with check (
    bucket_id = 'recordings'
    and name ~ '^uploads/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.ogg$'
  );

-- ---------- 3. Jobs table ----------

create table if not exists public.transcription_jobs (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  day date not null,                          -- the day it counts towards (Philippine time by default)
  object_path text not null,                  -- uploads/<id>.ogg in the recordings bucket
  claimed_seconds integer not null default 0, -- length the app reported, used until Speechmatics says
  duration_seconds integer,                   -- length Speechmatics measured
  speechmatics_id text unique,
  status text not null default 'starting',    -- starting | running | done | saved | rejected | failed
  error text,
  audio_deleted boolean not null default false
);

-- One live job per uploaded file, so the same upload is never paid for twice.
create unique index if not exists transcription_jobs_one_live_job_per_file
  on public.transcription_jobs (object_path)
  where status not in ('failed', 'rejected');

create index if not exists transcription_jobs_day on public.transcription_jobs (day);

alter table public.transcription_jobs enable row level security;
-- No policies: the public key can't see or change this table at all.
revoke all on public.transcription_jobs from anon, authenticated;
grant select, insert, update on public.transcription_jobs to service_role;

-- ---------- 4. Functions used by the Edge Functions ----------

-- Seconds of audio counted towards today's limit.
create or replace function public.transcriber_used_seconds(p_time_zone text)
returns bigint
language sql
stable
set search_path = public
as $$
  select coalesce(sum(coalesce(duration_seconds, claimed_seconds)), 0)::bigint
  from public.transcription_jobs
  where day = (now() at time zone p_time_zone)::date
    and status not in ('failed', 'rejected');  -- jobs that never ran are not charged
$$;

-- Starts a job for an uploaded file, unless today's limit is used up.
-- Returns {"status": "ok" | "existing" | "busy" | "limit", ...}.
create or replace function public.transcriber_begin_job(
  p_object_path text,
  p_seconds integer,
  p_limit_seconds integer,
  p_time_zone text
)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_today date := (now() at time zone p_time_zone)::date;
  v_used bigint;
  v_row public.transcription_jobs;
begin
  -- One at a time, so two people starting at once can't both slip past the limit.
  perform pg_advisory_xact_lock(hashtext('transcriber_daily_limit'));

  select * into v_row
  from public.transcription_jobs
  where object_path = p_object_path and status not in ('failed', 'rejected')
  order by id desc
  limit 1;

  if found then
    if v_row.speechmatics_id is not null then
      -- Already sent to Speechmatics: hand back the same job instead of paying again.
      return jsonb_build_object('status', 'existing', 'id', v_row.id, 'speechmatics_id', v_row.speechmatics_id);
    elsif v_row.created_at > now() - interval '10 minutes' then
      -- Still being sent (or it is unclear whether Speechmatics got it): don't risk a second job.
      return jsonb_build_object('status', 'busy', 'id', v_row.id);
    else
      update public.transcription_jobs
        set status = 'failed', error = 'Never reached Speechmatics', updated_at = now()
        where id = v_row.id;
    end if;
  end if;

  v_used := public.transcriber_used_seconds(p_time_zone);
  if v_used >= p_limit_seconds then
    return jsonb_build_object('status', 'limit', 'used_seconds', v_used);
  end if;

  insert into public.transcription_jobs (day, object_path, claimed_seconds)
  values (v_today, p_object_path, greatest(0, least(coalesce(p_seconds, 0), 86400)))
  returning * into v_row;

  return jsonb_build_object('status', 'ok', 'id', v_row.id, 'used_seconds', v_used);
end;
$$;

-- Speechmatics accepted the job.
create or replace function public.transcriber_job_started(p_id bigint, p_speechmatics_id text)
returns void
language sql
set search_path = public
as $$
  update public.transcription_jobs
    set speechmatics_id = p_speechmatics_id, status = 'running', updated_at = now()
    where id = p_id;
$$;

-- Speechmatics refused the job before it started (it does not count towards the limit).
create or replace function public.transcriber_job_failed(p_id bigint, p_error text)
returns void
language sql
set search_path = public
as $$
  update public.transcription_jobs
    set status = 'failed', error = left(p_error, 500), updated_at = now()
    where id = p_id;
$$;

-- The live job (not failed or rejected) for an uploaded file, if there is one.
create or replace function public.transcriber_find_live_job(p_object_path text)
returns jsonb
language sql
stable
set search_path = public
as $$
  select to_jsonb(j) from public.transcription_jobs j
  where object_path = p_object_path and status not in ('failed', 'rejected')
  order by id desc
  limit 1;
$$;

-- Today's jobs whose real length Speechmatics has not told us yet.
create or replace function public.transcriber_jobs_without_length(p_time_zone text)
returns jsonb
language sql
stable
set search_path = public
as $$
  select coalesce(jsonb_agg(speechmatics_id), '[]'::jsonb)
  from (
    select speechmatics_id from public.transcription_jobs
    where day = (now() at time zone p_time_zone)::date
      and speechmatics_id is not null
      and duration_seconds is null
      and status not in ('failed', 'rejected')
    order by id desc
    limit 25
  ) j;
$$;

-- A job the app started, found by its Speechmatics job number (null if not ours).
create or replace function public.transcriber_find_job(p_speechmatics_id text)
returns jsonb
language sql
stable
set search_path = public
as $$
  select to_jsonb(j) from public.transcription_jobs j where speechmatics_id = p_speechmatics_id;
$$;

-- Record what Speechmatics says about a job, and when its audio is deleted.
create or replace function public.transcriber_job_update(
  p_speechmatics_id text,
  p_status text,
  p_duration_seconds integer,
  p_audio_deleted boolean
)
returns void
language sql
set search_path = public
as $$
  update public.transcription_jobs
    set status = coalesce(p_status, status),
        duration_seconds = coalesce(p_duration_seconds, duration_seconds),
        audio_deleted = audio_deleted or coalesce(p_audio_deleted, false),
        updated_at = now()
    where speechmatics_id = p_speechmatics_id;
$$;

-- Only the Edge Functions (service role) may call these.
revoke execute on function public.transcriber_used_seconds(text) from public, anon, authenticated;
revoke execute on function public.transcriber_begin_job(text, integer, integer, text) from public, anon, authenticated;
revoke execute on function public.transcriber_job_started(bigint, text) from public, anon, authenticated;
revoke execute on function public.transcriber_job_failed(bigint, text) from public, anon, authenticated;
revoke execute on function public.transcriber_find_job(text) from public, anon, authenticated;
revoke execute on function public.transcriber_find_live_job(text) from public, anon, authenticated;
revoke execute on function public.transcriber_jobs_without_length(text) from public, anon, authenticated;
revoke execute on function public.transcriber_job_update(text, text, integer, boolean) from public, anon, authenticated;
grant execute on function public.transcriber_used_seconds(text) to service_role;
grant execute on function public.transcriber_begin_job(text, integer, integer, text) to service_role;
grant execute on function public.transcriber_job_started(bigint, text) to service_role;
grant execute on function public.transcriber_job_failed(bigint, text) to service_role;
grant execute on function public.transcriber_find_job(text) to service_role;
grant execute on function public.transcriber_find_live_job(text) to service_role;
grant execute on function public.transcriber_jobs_without_length(text) to service_role;
grant execute on function public.transcriber_job_update(text, text, integer, boolean) to service_role;

-- Let the Data API see the new table and functions straight away.
notify pgrst, 'reload schema';
