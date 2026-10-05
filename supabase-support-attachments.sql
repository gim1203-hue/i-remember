-- Add private file/photo attachments to support conversations.
-- Safe to run after supabase-migration.sql.

alter table public.support_messages
  add column if not exists attachment_path text,
  add column if not exists attachment_name text,
  add column if not exists attachment_type text;

insert into storage.buckets (id, name, public, file_size_limit)
values ('support-attachments', 'support-attachments', false, 10485760)
on conflict (id) do update
set public = false, file_size_limit = 10485760;

drop policy if exists "support attachments read" on storage.objects;
create policy "support attachments read"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'support-attachments'
    and (
      (storage.foldername(name))[1] = (select auth.uid())::text
      or (select public.is_support_admin())
    )
  );

drop policy if exists "support admins upload attachments" on storage.objects;
create policy "support admins upload attachments"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'support-attachments'
    and (select public.is_support_admin())
  );

drop policy if exists "support admins delete attachments" on storage.objects;
create policy "support admins delete attachments"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'support-attachments'
    and (select public.is_support_admin())
  );
drop policy if exists "members upload own attachments" on storage.objects;
create policy "members upload own attachments"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'support-attachments'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );
