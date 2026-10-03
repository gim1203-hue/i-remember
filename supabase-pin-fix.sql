-- Run in the Supabase SQL editor to fix PIN saving and verification only.
-- Resolves pgcrypto in either extensions (Supabase default) or public.
begin;

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


commit;
