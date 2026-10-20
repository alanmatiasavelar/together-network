-- ---------------------------------------------------------------------------
-- EMAIL CONFIRMATION BACKLOG (grace period)
--
-- Problem: Supabase's built-in mailer allows only ~2 emails/hour. When that
-- limit is hit, sign-ups can't receive their confirmation email and are stuck.
--
-- Design: when (and only when) the email limit is exhausted, the `signup` edge
-- function creates the account anyway, marks it usable, and records it here
-- with a 7-day deadline. The user gets temporary access and a banner asking
-- them to confirm their email (a magic link). Proving ownership of the email
-- (an email-link sign-in, recorded in the JWT as method "otp") marks the row
-- 'verified'. An hourly job locks accounts whose deadline passed ('expired');
-- the site admin can extend a deadline (which unlocks the account again).
--
-- Security note: until verified, these accounts have an email nobody has proven
-- they own. Mitigations: the grace path only runs while the email limit is
-- exhausted, is capped per hour, expires in 7 days, and confirming the email
-- forces a password change (so someone who pre-registered another person's
-- email can't keep the account).
--
-- NOTE: applying this was blocked by the auto-mode safety classifier because it
-- changes sign-up/verification rules. Run it yourself in the Supabase SQL
-- editor (or allow the apply_migration tool), then deploy the `signup` function.
-- ---------------------------------------------------------------------------
create table if not exists public.email_confirmation_backlog (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  status text not null default 'pending' check (status in ('pending','verified','expired')),
  created_at timestamptz not null default now(),
  deadline timestamptz not null default (now() + interval '7 days'),
  last_email_attempt_at timestamptz,
  email_attempts integer not null default 0,
  verified_at timestamptz,
  extended_count integer not null default 0
);

create index if not exists email_confirmation_backlog_status_idx on public.email_confirmation_backlog (status, deadline);

alter table public.email_confirmation_backlog enable row level security;

drop policy if exists "Users read own backlog row, admin reads all" on public.email_confirmation_backlog;
create policy "Users read own backlog row, admin reads all" on public.email_confirmation_backlog
  for select using (auth.uid() = user_id or public.is_site_admin());

-- Data API grants (required for tables created after 2026-10-30). No anon access.
grant select on public.email_confirmation_backlog to authenticated;
grant select, insert, update, delete on public.email_confirmation_backlog to service_role;

-- A user records that they just tried to send themselves the confirmation email.
create or replace function public.record_confirmation_email_attempt()
returns void
language sql
security definer set search_path = public
as $$
  update public.email_confirmation_backlog
     set last_email_attempt_at = now(), email_attempts = email_attempts + 1
   where user_id = auth.uid() and status = 'pending';
$$;

-- Marks the caller's email confirmed, but only if their current session was
-- created by clicking an emailed link in the last 30 minutes (JWT amr "otp").
-- A password login alone can never confirm an email.
create or replace function public.confirm_my_email()
returns boolean
language plpgsql
security definer set search_path = public
as $$
declare proven boolean;
begin
  if auth.uid() is null then return false; end if;
  select exists (
    select 1 from jsonb_array_elements(coalesce(auth.jwt() -> 'amr', '[]'::jsonb)) a
    where a ->> 'method' in ('otp','magiclink','recovery')
      and (a ->> 'timestamp')::bigint >= extract(epoch from (now() - interval '30 minutes'))
  ) into proven;
  if not proven then return false; end if;
  update public.email_confirmation_backlog
     set status = 'verified', verified_at = now()
   where user_id = auth.uid() and status = 'pending';
  return found;
end;
$$;

-- Admin only: give a pending/expired account another 7 days and unlock it.
create or replace function public.admin_extend_email_backlog(p_user_id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  if not public.is_site_admin() then raise exception 'not authorized'; end if;
  update public.email_confirmation_backlog
     set status = 'pending', deadline = greatest(deadline, now()) + interval '7 days', extended_count = extended_count + 1
   where user_id = p_user_id and status in ('pending','expired');
  update auth.users set banned_until = null where id = p_user_id;
end;
$$;

-- Hourly: lock accounts whose 7 days ran out without confirming their email.
create or replace function public.expire_email_backlog()
returns integer
language plpgsql
security definer set search_path = public
as $$
declare n integer;
begin
  with expired as (
    update public.email_confirmation_backlog set status = 'expired'
     where status = 'pending' and deadline < now()
    returning user_id
  )
  update auth.users u set banned_until = now() + interval '100 years'
    from expired e where u.id = e.user_id;
  get diagnostics n = row_count;
  return n;
end;
$$;

revoke execute on function public.record_confirmation_email_attempt() from public, anon;
revoke execute on function public.confirm_my_email() from public, anon;
revoke execute on function public.admin_extend_email_backlog(uuid) from public, anon;
revoke execute on function public.expire_email_backlog() from public, anon, authenticated;
grant execute on function public.record_confirmation_email_attempt() to authenticated;
grant execute on function public.confirm_my_email() to authenticated;
grant execute on function public.admin_extend_email_backlog(uuid) to authenticated;

create extension if not exists pg_cron;
select cron.unschedule('expire-email-backlog') where exists (select 1 from cron.job where jobname = 'expire-email-backlog');
select cron.schedule('expire-email-backlog', '15 * * * *', $cron$select public.expire_email_backlog()$cron$);
