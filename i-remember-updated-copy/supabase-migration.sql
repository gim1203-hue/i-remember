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

drop trigger if exists daily_folders_limit on public.daily_folders;
drop trigger if exists daily_files_limit on public.daily_files;
drop function if exists public.enforce_iremember_limits();

-- Separate functions are intentional: NEW has different fields in the two tables.
create or replace function public.enforce_daily_folder_limit() returns trigger
language plpgsql security invoker set search_path = public as $$
begin
  if (select count(*) from public.daily_folders where entry_id = new.entry_id) >= 10 then
    raise exception 'Maximum 10 folders per day';
  end if;
  return new;
end;
$$;

create or replace function public.enforce_daily_file_limit() returns trigger
language plpgsql security invoker set search_path = public as $$
begin
  if (select count(*) from public.daily_files where folder_id = new.folder_id) >= 50 then
    raise exception 'Maximum 50 files per folder';
  end if;
  return new;
end;
$$;

create trigger daily_folders_limit before insert on public.daily_folders
for each row execute function public.enforce_daily_folder_limit();
create trigger daily_files_limit before insert on public.daily_files
for each row execute function public.enforce_daily_file_limit();
