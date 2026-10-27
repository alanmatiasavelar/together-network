-- ---------------------------------------------------------------------------
-- SYSTEMS ENGINEERING, batch 3:
--   1. more diagram types (context, sequence, state machine, activity)
--   2. verification records per requirement (who verified it, how, result, evidence)
--   3. a usage log for the "AI assist" Edge Function (rate limiting only)
-- Applied to production on 2026-10-27; supabase/functions/se-assist deployed (verify_jwt = true).
-- ---------------------------------------------------------------------------

-- 1. Diagram types. Each project keeps at most one saved diagram per type (existing unique constraint).
alter table public.project_diagrams drop constraint if exists project_diagrams_type_check;
alter table public.project_diagrams add constraint project_diagrams_type_check
  check (type in ('usecases','architecture','context','sequence','states','activity'));

-- 2. Verification records. A requirement can have many (e.g. a failed test, then a passing re-test).
create table if not exists public.project_requirement_verifications (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  requirement_id uuid not null references public.project_requirements(id) on delete cascade,
  method text not null check (method in ('test','inspection','analysis','demonstration')),
  result text not null default 'pass' check (result in ('pending','pass','fail')),
  notes text check (notes is null or char_length(notes) <= 1000),
  evidence_url text check (evidence_url is null or (char_length(evidence_url) <= 500 and evidence_url ~* '^https?://')),
  performed_on date not null default current_date,
  created_by uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  created_by_name text not null default public.current_display_name(),
  created_at timestamptz not null default now()
);

create index if not exists project_requirement_verifications_req_idx
  on public.project_requirement_verifications (requirement_id, performed_on desc);
create index if not exists project_requirement_verifications_project_idx
  on public.project_requirement_verifications (project_id);

alter table public.project_requirement_verifications enable row level security;

drop policy if exists "Team can read verifications" on public.project_requirement_verifications;
create policy "Team can read verifications" on public.project_requirement_verifications
  for select using (public.is_project_team_member(project_id));

-- The requirement must belong to the same project the row claims (stops cross-project inserts).
drop policy if exists "Team can add verifications" on public.project_requirement_verifications;
create policy "Team can add verifications" on public.project_requirement_verifications
  for insert with check (
    public.is_project_team_member(project_id)
    and created_by = auth.uid()
    and exists (select 1 from public.project_requirements r where r.id = requirement_id and r.project_id = project_requirement_verifications.project_id)
  );

drop policy if exists "Author or owner can edit verifications" on public.project_requirement_verifications;
create policy "Author or owner can edit verifications" on public.project_requirement_verifications
  for update using (created_by = auth.uid() or public.is_project_owner(project_id))
  with check (public.is_project_team_member(project_id));

drop policy if exists "Author or owner can delete verifications" on public.project_requirement_verifications;
create policy "Author or owner can delete verifications" on public.project_requirement_verifications
  for delete using (created_by = auth.uid() or public.is_project_owner(project_id));

revoke all on table public.project_requirement_verifications from anon, authenticated;
grant select, insert, update, delete on public.project_requirement_verifications to authenticated, service_role;

-- 3. AI assist usage log: written and read only by the Edge Function (service role). No client policies on purpose.
create table if not exists public.ai_assist_log (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  task text not null,
  created_at timestamptz not null default now()
);
create index if not exists ai_assist_log_user_idx on public.ai_assist_log (user_id, created_at desc);
alter table public.ai_assist_log enable row level security;
revoke all on table public.ai_assist_log from anon, authenticated;
grant select, insert, delete on public.ai_assist_log to service_role;
