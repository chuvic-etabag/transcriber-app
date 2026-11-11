-- Transcriber: second setup for Supabase (project "transcriber"), from TR Session D.
-- Paste all of this into the Supabase SQL Editor and press Run.
-- Run supabase/setup_1.sql first if you never did. Running this again is safe.
--
-- It makes:
--   1. The list of emails allowed to sign in ("allowed_emails"), starting with one email.
--      Only these can get an account, use the Edge Functions, or read anything.
--   2. The "transcripts" table for the My Transcripts folder. Each person sees and
--      changes only their own rows (row level security).
--   3. Storage rules: a signed-in person can add, play and delete only the recordings
--      in their own folder of the private "recordings" bucket. The old rule that let
--      anyone upload (TR Session C) is removed.
--   4. Who started each Speechmatics job, and the small database functions the
--      Edge Functions use. The 60-minutes-a-day limit stays as it was.
--
-- TO LET A TESTER SIGN IN LATER, run this one line (with their email, in small letters):
--   insert into public.allowed_emails (email) values ('tester@example.com');
-- To stop someone:
--   delete from public.allowed_emails where email = 'tester@example.com';

do $$
begin
  if to_regclass('public.transcription_jobs') is null then
    raise exception 'Run supabase/setup_1.sql first, then run this file again.';
  end if;
end
$$;

-- ---------- 1. Who may sign in ----------

create table if not exists public.allowed_emails (
  email text primary key,
  added_at timestamptz not null default now(),
  constraint allowed_emails_small_letters check (email = lower(btrim(email)))
);

alter table public.allowed_emails enable row level security;
-- No policies: the web page can't read or change the list.
revoke all on public.allowed_emails from anon, authenticated;
grant select, insert, update, delete on public.allowed_emails to service_role;

insert into public.allowed_emails (email) values ('chuvicame@gmail.com')
on conflict (email) do nothing;

-- Is this email on the list? (The sign-in screen asks before it sends a link.)
create or replace function public.transcriber_email_allowed(p_email text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.allowed_emails
    where email = lower(btrim(coalesce(p_email, '')))
  );
$$;

-- Is this account's email on the list (and confirmed by its sign-in link)?
create or replace function public.transcriber_user_allowed(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select p_user_id is not null and exists (
    select 1
    from auth.users u
    join public.allowed_emails a on a.email = lower(btrim(u.email))
    where u.id = p_user_id and u.email_confirmed_at is not null
  );
$$;

-- Is the person making this request signed in and on the list? (Used by the rules below.)
create or replace function public.transcriber_is_allowed()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.transcriber_user_allowed(auth.uid());
$$;

-- Nobody gets an account unless their email is on the list.
create or replace function public.transcriber_check_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.transcriber_email_allowed(new.email) then
    raise exception 'This app isn''t open to new users yet.';
  end if;
  return new;
end;
$$;

drop trigger if exists transcriber_only_allowed_emails on auth.users;
create trigger transcriber_only_allowed_emails
  before insert on auth.users
  for each row execute function public.transcriber_check_new_user();

-- ---------- 2. My Transcripts ----------

create table if not exists public.transcripts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  title text not null,                          -- the name shown in the list (can be renamed)
  file_name text not null default '',           -- the name of the recording that was chosen
  duration_seconds numeric not null default 0,  -- length of the recording
  turns jsonb not null default '[]'::jsonb,     -- [{ n, start, end, speaker, overlap, text }]
  speakers jsonb not null default '[]'::jsonb,  -- ["S1", "S2", ...] in the order they first talk
  speaker_names jsonb not null default '{}'::jsonb,  -- renamed speakers: { "S1": "Teacher" }
  first_line text not null default '',          -- the first line, for the list
  audio_path text,                              -- <user id>/<id>.ogg in the recordings bucket (null: no recording kept)
  audio_bytes bigint not null default 0,
  speechmatics_id text,
  file_key text,                                -- a fingerprint of the chosen file, so it is never paid for twice
  constraint transcripts_one_per_file unique (user_id, file_key)
);

create index if not exists transcripts_user_newest on public.transcripts (user_id, created_at desc);
create index if not exists transcripts_audio_path on public.transcripts (audio_path);

create or replace function public.transcriber_touch_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists transcripts_touch_updated_at on public.transcripts;
create trigger transcripts_touch_updated_at
  before update on public.transcripts
  for each row execute function public.transcriber_touch_updated_at();

alter table public.transcripts enable row level security;
revoke all on public.transcripts from anon, authenticated;
grant select, insert, update, delete on public.transcripts to authenticated;
grant select, insert, update, delete on public.transcripts to service_role;

drop policy if exists "Transcriber: see your own transcripts" on public.transcripts;
create policy "Transcriber: see your own transcripts"
  on public.transcripts for select to authenticated
  using (user_id = (select auth.uid()) and (select public.transcriber_is_allowed()));

drop policy if exists "Transcriber: save your own transcripts" on public.transcripts;
create policy "Transcriber: save your own transcripts"
  on public.transcripts for insert to authenticated
  with check (user_id = (select auth.uid()) and (select public.transcriber_is_allowed()));

drop policy if exists "Transcriber: change your own transcripts" on public.transcripts;
create policy "Transcriber: change your own transcripts"
  on public.transcripts for update to authenticated
  using (user_id = (select auth.uid()) and (select public.transcriber_is_allowed()))
  with check (user_id = (select auth.uid()) and (select public.transcriber_is_allowed()));

drop policy if exists "Transcriber: delete your own transcripts" on public.transcripts;
create policy "Transcriber: delete your own transcripts"
  on public.transcripts for delete to authenticated
  using (user_id = (select auth.uid()) and (select public.transcriber_is_allowed()));

-- ---------- 3. Storage rules: each person's own folder only ----------

-- TR Session C let anyone with the page upload. Now uploading needs a sign-in.
drop policy if exists "Transcriber: the app can upload recordings" on storage.objects;

drop policy if exists "Transcriber: add your own recordings" on storage.objects;
create policy "Transcriber: add your own recordings"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'recordings'
    and name ~ ('^' || (select auth.uid())::text || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.ogg$')
    and (select public.transcriber_is_allowed())
  );

drop policy if exists "Transcriber: play your own recordings" on storage.objects;
create policy "Transcriber: play your own recordings"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'recordings'
    and name like ((select auth.uid())::text || '/%')
    and (select public.transcriber_is_allowed())
  );

drop policy if exists "Transcriber: delete your own recordings" on storage.objects;
create policy "Transcriber: delete your own recordings"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'recordings'
    and name like ((select auth.uid())::text || '/%')
    and (select public.transcriber_is_allowed())
  );

-- How much of the storage is used (all recordings in the bucket), for the meter.
create or replace function public.transcriber_storage_used()
returns bigint
language sql
stable
security definer
set search_path = public
as $$
  select case when public.transcriber_is_allowed() then (
    select coalesce(sum(coalesce((o.metadata ->> 'size')::bigint, 0)), 0)::bigint
    from storage.objects o
    where o.bucket_id = 'recordings'
  ) else 0 end;
$$;

-- ---------- 4. Jobs: who started each one ----------

alter table public.transcription_jobs add column if not exists user_id uuid;

-- Like transcriber_begin_job (setup_1.sql), and remembers who started the job.
-- Returns {"status": "ok" | "existing" | "busy" | "limit", ...}.
create or replace function public.transcriber_begin_user_job(
  p_user_id uuid,
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

  insert into public.transcription_jobs (day, object_path, claimed_seconds, user_id)
  values (v_today, p_object_path, greatest(0, least(coalesce(p_seconds, 0), 86400)), p_user_id)
  returning * into v_row;

  return jsonb_build_object('status', 'ok', 'id', v_row.id, 'used_seconds', v_used);
end;
$$;

-- Is this recording kept by a saved transcript?
create or replace function public.transcriber_audio_kept(p_object_path text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.transcripts where audio_path = p_object_path);
$$;

-- Uploads that never finished becoming a transcript: older than p_hours, not kept by a
-- saved transcript, and with no Speechmatics job that could still be collected
-- (Speechmatics keeps a finished job for about a week).
create or replace function public.transcriber_abandoned_uploads(p_hours integer)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(name), '[]'::jsonb)
  from (
    select o.name
    from storage.objects o
    where o.bucket_id = 'recordings'
      and o.created_at < now() - make_interval(hours => greatest(coalesce(p_hours, 24), 1))
      and not exists (select 1 from public.transcripts t where t.audio_path = o.name)
      and not exists (
        select 1 from public.transcription_jobs j
        where j.object_path = o.name
          and j.status not in ('failed', 'rejected')
          and j.created_at > now() - interval '8 days'
      )
    order by o.created_at
    limit 100
  ) old;
$$;

-- Who may call what.
revoke execute on function public.transcriber_email_allowed(text) from public;
revoke execute on function public.transcriber_user_allowed(uuid) from public, anon, authenticated;
revoke execute on function public.transcriber_is_allowed() from public, anon;
revoke execute on function public.transcriber_check_new_user() from public, anon, authenticated;
revoke execute on function public.transcriber_storage_used() from public, anon;
revoke execute on function public.transcriber_begin_user_job(uuid, text, integer, integer, text) from public, anon, authenticated;
revoke execute on function public.transcriber_audio_kept(text) from public, anon, authenticated;
revoke execute on function public.transcriber_abandoned_uploads(integer) from public, anon, authenticated;

grant execute on function public.transcriber_email_allowed(text) to anon, authenticated, service_role;
grant execute on function public.transcriber_user_allowed(uuid) to service_role;
grant execute on function public.transcriber_is_allowed() to authenticated, service_role;
grant execute on function public.transcriber_storage_used() to authenticated, service_role;
grant execute on function public.transcriber_begin_user_job(uuid, text, integer, integer, text) to service_role;
grant execute on function public.transcriber_audio_kept(text) to service_role;
grant execute on function public.transcriber_abandoned_uploads(integer) to service_role;

-- Let the Data API see the new tables and functions straight away.
notify pgrst, 'reload schema';
