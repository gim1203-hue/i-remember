-- I Remember 2.0 additive migration
-- Safe to run after the original schema. It does not alter or delete original tables.

create extension if not exists pgcrypto;

create table if not exists public.daily_notes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  entry_id uuid not null references public.entries(id) on delete cascade,
  body text not null check (char_length(body) between 1 and 4000),
  created_at timestamptz not null default now()
);

create table if not exists public.daily_folders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  entry_id uuid not null references public.entries(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  created_at timestamptz not null default now(),
  unique (entry_id, name)
);

create table if not exists public.daily_files (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  entry_id uuid not null references public.entries(id) on delete cascade,
  folder_id uuid not null references public.daily_folders(id) on delete cascade,
  file_name text not null,
  mime_type text,
  byte_size bigint not null check (byte_size between 0 and 26214400),
  page_count integer check (page_count is null or page_count > 0),
  storage_path text not null unique,
  created_at timestamptz not null default now()
);

create table if not exists public.alarms (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  entry_id uuid not null references public.entries(id) on delete cascade,
  event_time time not null,
  label text not null check (char_length(label) between 1 and 120),
  enabled boolean not null default true,
  last_fired_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists daily_notes_entry_idx on public.daily_notes(entry_id, created_at desc);
create index if not exists daily_folders_entry_idx on public.daily_folders(entry_id);
create index if not exists daily_files_folder_idx on public.daily_files(folder_id, created_at);
create index if not exists alarms_entry_idx on public.alarms(entry_id, event_time) where enabled;

alter table public.daily_notes enable row level security;
alter table public.daily_folders enable row level security;
alter table public.daily_files enable row level security;
alter table public.alarms enable row level security;

drop policy if exists "own daily notes" on public.daily_notes;
create policy "own daily notes" on public.daily_notes for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "own daily folders" on public.daily_folders;
create policy "own daily folders" on public.daily_folders for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "own daily files" on public.daily_files;
create policy "own daily files" on public.daily_files for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "own alarms" on public.alarms;
create policy "own alarms" on public.alarms for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Private document bucket. The original media bucket remains untouched.
insert into storage.buckets (id, name, public, file_size_limit)
values ('documents', 'documents', false, 26214400)
on conflict (id) do update set public = false, file_size_limit = 26214400;

-- Keep the media bucket above the app's 45 MB per-file safety limit.
-- This documents the server-side maximum instead of relying on a dashboard
-- default that can differ between projects.
update storage.buckets
set file_size_limit = 52428800
where id = 'media';

drop policy if exists "own documents select" on storage.objects;
create policy "own documents select" on storage.objects for select
using (bucket_id = 'documents' and auth.uid()::text = (storage.foldername(name))[1]);
drop policy if exists "own documents insert" on storage.objects;
create policy "own documents insert" on storage.objects for insert
with check (bucket_id = 'documents' and auth.uid()::text = (storage.foldername(name))[1]);
drop policy if exists "own documents update" on storage.objects;
create policy "own documents update" on storage.objects for update
using (bucket_id = 'documents' and auth.uid()::text = (storage.foldername(name))[1]);
drop policy if exists "own documents delete" on storage.objects;
create policy "own documents delete" on storage.objects for delete
using (bucket_id = 'documents' and auth.uid()::text = (storage.foldername(name))[1]);

-- Enforce 10 folders per day and 50 files per folder at the database boundary.
create or replace function public.enforce_iremember_limits() returns trigger
language plpgsql security invoker set search_path = public as $$
begin
  if tg_table_name = 'daily_folders' and (select count(*) from public.daily_folders where entry_id = new.entry_id) >= 10 then
    raise exception 'Maximum 10 folders per day';
  end if;
  if tg_table_name = 'daily_files' and (select count(*) from public.daily_files where folder_id = new.folder_id) >= 50 then
    raise exception 'Maximum 50 files per folder';
  end if;
  return new;
end;
$$;

drop trigger if exists daily_folders_limit on public.daily_folders;
create trigger daily_folders_limit before insert on public.daily_folders for each row execute function public.enforce_iremember_limits();
drop trigger if exists daily_files_limit on public.daily_files;
create trigger daily_files_limit before insert on public.daily_files for each row execute function public.enforce_iremember_limits();

-- Private support inbox and admin access.
create table if not exists public.support_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.support_messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  sender_id uuid not null references auth.users(id) on delete cascade,
  body text not null check (char_length(body) between 1 and 4000),
  created_at timestamptz not null default now()
);

create table if not exists public.app_pins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  pin_hash text not null,
  failed_attempts integer not null default 0 check (failed_attempts >= 0),
  locked_until timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists support_messages_thread_idx
  on public.support_messages(user_id, created_at);

alter table public.support_admins enable row level security;
alter table public.support_messages enable row level security;
alter table public.app_pins enable row level security;
revoke all on public.app_pins from anon, authenticated;

create or replace function public.is_support_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.support_admins
    where user_id = (select auth.uid())
  );
$$;

revoke all on function public.is_support_admin() from public;
grant execute on function public.is_support_admin() to authenticated;

drop policy if exists "support thread participants can read" on public.support_messages;
create policy "support thread participants can read"
  on public.support_messages for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_support_admin()));

drop policy if exists "users and admins can send support messages" on public.support_messages;
create policy "users and admins can send support messages"
  on public.support_messages for insert to authenticated
  with check (
    sender_id = (select auth.uid())
    and (
      user_id = (select auth.uid())
      or (select public.is_support_admin())
    )
  );

grant select, insert on public.support_messages to authenticated;

create or replace function public.admin_list_users()
returns table (
  id uuid,
  email text,
  full_name text,
  created_at timestamptz,
  last_sign_in_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_support_admin() then
    raise exception 'Not authorized';
  end if;

  return query
    select
      u.id,
      u.email::text,
      coalesce(
        nullif(p.full_name, ''),
        nullif(u.raw_user_meta_data ->> 'full_name', ''),
        nullif(u.raw_user_meta_data ->> 'name', ''),
        ''
      ),
      u.created_at,
      u.last_sign_in_at
    from auth.users as u
    left join public.profiles as p on p.id = u.id
    order by u.created_at desc;
end;
$$;

revoke all on function public.admin_list_users() from public;
grant execute on function public.admin_list_users() to authenticated;

create or replace function public.has_app_pin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.app_pins
    where user_id = (select auth.uid())
  );
$$;

create or replace function public.set_app_pin(pin_value text)
returns void
language plpgsql
security definer
set search_path = pg_catalog, extensions, public, pg_temp
as $$
declare
  actor_id uuid := auth.uid();
begin
  if actor_id is null then raise exception 'Authentication required'; end if;
  if pin_value !~ '^[0-9]{4}$' then raise exception 'PIN must be four digits'; end if;

  insert into public.app_pins (user_id, pin_hash)
  values (actor_id, crypt(pin_value, gen_salt('bf', 12)))
  on conflict (user_id) do nothing;

  if not found then raise exception 'PIN is already set'; end if;
end;
$$;

create or replace function public.verify_app_pin(pin_value text)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, extensions, public, pg_temp
as $$
declare
  actor_id uuid := auth.uid();
  pin_record public.app_pins%rowtype;
  next_failures integer;
begin
  if actor_id is null or pin_value !~ '^[0-9]{4}$' then return false; end if;

  select * into pin_record
  from public.app_pins
  where user_id = actor_id
  for update;

  if not found then return false; end if;
  if pin_record.locked_until is not null and pin_record.locked_until > now() then return false; end if;

  if pin_record.pin_hash = crypt(pin_value, pin_record.pin_hash) then
    update public.app_pins
    set failed_attempts = 0, locked_until = null
    where user_id = actor_id;
    return true;
  end if;

  next_failures := case
    when pin_record.locked_until is not null and pin_record.locked_until <= now() then 1
    else pin_record.failed_attempts + 1
  end;

  update public.app_pins
  set failed_attempts = case when next_failures >= 5 then 0 else next_failures end,
      locked_until = case when next_failures >= 5 then now() + interval '15 minutes' else null end
  where user_id = actor_id;
  return false;
end;
$$;

create or replace function public.admin_reset_user_pin(target_user_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_support_admin() then raise exception 'Not authorized'; end if;
  delete from public.app_pins where user_id = target_user_id;
  return found;
end;
$$;

revoke all on function public.has_app_pin() from public;
revoke all on function public.set_app_pin(text) from public;
revoke all on function public.verify_app_pin(text) from public;
revoke all on function public.admin_reset_user_pin(uuid) from public;
grant execute on function public.has_app_pin() to authenticated;
grant execute on function public.set_app_pin(text) to authenticated;
grant execute on function public.verify_app_pin(text) to authenticated;
grant execute on function public.admin_reset_user_pin(uuid) to authenticated;

-- Run once in the Supabase SQL editor after replacing the email below.
-- The account must already have signed in at least once.
-- insert into public.support_admins (user_id)
-- select id from auth.users where lower(email) = lower('YOUR_ADMIN_EMAIL')
-- on conflict (user_id) do nothing;
