-- Together — database setup (v2)
-- Safe to run whether you're starting fresh or already ran the first version.
-- Run this in Supabase: SQL Editor -> New query -> paste -> Run

-- ---------------------------------------------------------------------------
-- USERS: a real, queryable public.profiles table, kept in sync with Supabase's
-- built-in auth.users automatically. This is what makes "users" an actual part
-- of your database rather than something hidden inside the auth system.
-- ---------------------------------------------------------------------------
create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null,
  email text not null,
  is_premium boolean not null default false,
  created_at timestamptz not null default now()
);

alter table profiles add column if not exists is_premium boolean not null default false;

-- backfill a profile row for anyone who already signed up before this table existed
insert into profiles (id, display_name, email)
select
  u.id,
  coalesce(u.raw_user_meta_data->>'display_name', split_part(u.email, '@', 1)),
  u.email
from auth.users u
on conflict (id) do nothing;

-- automatically create a profile row every time someone signs up from now on
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, display_name, email)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1)),
    new.email
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- PROJECTS
-- ---------------------------------------------------------------------------
create table if not exists projects (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid(),
  owner_name text not null,
  title text not null,
  pitch text not null,
  description text,
  category text not null default 'other',
  goal_type text not null default 'nonprofit' check (goal_type in ('profit','nonprofit')),
  funding_target numeric,
  created_at timestamptz not null default now()
);

-- give owner_id a real foreign key into profiles, so every project is
-- guaranteed to point at an actual user row in your database
alter table projects drop constraint if exists projects_owner_id_fkey;
alter table projects add constraint projects_owner_id_fkey
  foreign key (owner_id) references profiles(id) on delete cascade;

-- optional WhatsApp group invite link for a project, validated at the
-- database level so garbage links can never be saved, no matter what
-- sends the request
alter table projects add column if not exists whatsapp_link text;
alter table projects drop constraint if exists projects_whatsapp_link_format;
alter table projects add constraint projects_whatsapp_link_format
  check (whatsapp_link is null or whatsapp_link ~ '^https://chat\.whatsapp\.com/[A-Za-z0-9]+$');

-- Manager-provided Google Drive folder link — same "paste a link" pattern as
-- WhatsApp, for the team's shared working files.
alter table projects add column if not exists drive_link text;
alter table projects drop constraint if exists projects_drive_link_format;
alter table projects add constraint projects_drive_link_format
  check (drive_link is null or drive_link ~ '^https://(www\.)?drive\.google\.com/drive/(u/\d+/)?folders/[A-Za-z0-9_-]+(\?.*)?$');

-- Payment now works by the manager uploading a QR code photo for each method
-- they accept, rather than pasting a payment link — this is how PIX actually
-- works in Brazil (there is no "PIX link", the QR code IS the payment
-- instrument), and it's a legitimate, standard option for PayPal and Zelle
-- too. All three are optional and independent. Values are Supabase Storage
-- URLs, same as project_posts images — no separate bucket needed, since the
-- existing project-post-images bucket's policies already scope correctly by
-- project id regardless of what the file inside that folder is for.
alter table projects drop constraint if exists projects_paypal_link_format;
alter table projects drop column if exists paypal_link;

alter table projects add column if not exists paypal_qr_url text;
alter table projects drop constraint if exists projects_paypal_qr_url_format;
alter table projects add constraint projects_paypal_qr_url_format
  check (paypal_qr_url is null or paypal_qr_url ~ '^https://');

alter table projects add column if not exists zelle_qr_url text;
alter table projects drop constraint if exists projects_zelle_qr_url_format;
alter table projects add constraint projects_zelle_qr_url_format
  check (zelle_qr_url is null or zelle_qr_url ~ '^https://');

alter table projects add column if not exists pix_qr_url text;
alter table projects drop constraint if exists projects_pix_qr_url_format;
alter table projects add constraint projects_pix_qr_url_format
  check (pix_qr_url is null or pix_qr_url ~ '^https://');

-- Cover image for the project. This stores a URL to an already-hosted image
-- (paste a link), not a file upload — real upload would need Supabase Storage
-- set up as a separate step. Ask if you want that built next.
alter table projects add column if not exists image_url text;
alter table projects drop constraint if exists projects_image_url_format;
alter table projects add constraint projects_image_url_format
  check (image_url is null or image_url ~ '^https://');

-- YouTube video link for the project. Loosely validated here (right domain);
-- the actual video ID is extracted and embedded client-side, which handles
-- every common YouTube URL shape (watch, youtu.be, shorts, embed).
alter table projects add column if not exists youtube_link text;
alter table projects drop constraint if exists projects_youtube_link_format;
alter table projects add constraint projects_youtube_link_format
  check (youtube_link is null or youtube_link ~ '^https://(www\.)?(youtube\.com|youtu\.be)/');

-- ---------------------------------------------------------------------------
-- COLLABORATORS: people who join a project to work on it — distinct from the
-- creator/manager and distinct from financial supporters.
-- ---------------------------------------------------------------------------
create table if not exists project_collaborators (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  user_id uuid not null default auth.uid(),
  joined_at timestamptz not null default now(),
  unique (project_id, user_id)
);

alter table project_collaborators drop constraint if exists project_collaborators_user_id_fkey;
alter table project_collaborators add constraint project_collaborators_user_id_fkey
  foreign key (user_id) references profiles(id) on delete cascade;

-- Joining now requires the project owner's approval. This block only runs the
-- very first time (checked via information_schema), so anyone who joined under
-- the old free-join model is grandfathered in as already-approved, and this
-- migration stays safe to re-run without re-approving people or losing status.
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_name = 'project_collaborators' and column_name = 'status'
  ) then
    alter table project_collaborators add column status text not null default 'pending'
      check (status in ('pending','approved','denied'));
    update project_collaborators set status = 'approved';
  end if;
end $$;

alter table project_collaborators enable row level security;

-- Approved collaborators are public info (shown as the project's team).
-- A pending or denied request is visible only to the requester and the owner.
drop policy if exists "Public can read collaborators" on project_collaborators;
drop policy if exists "View collaborators" on project_collaborators;
create policy "View collaborators" on project_collaborators
  for select using (
    status = 'approved'
    or user_id = auth.uid()
    or exists (select 1 from projects where projects.id = project_collaborators.project_id and projects.owner_id = auth.uid())
  );

-- Anyone can REQUEST to join, but the request always starts as 'pending' —
-- this check makes it impossible for a client to insert itself as 'approved'.
drop policy if exists "Users can join as collaborators" on project_collaborators;
drop policy if exists "Users can request to join" on project_collaborators;
create policy "Users can request to join" on project_collaborators
  for insert with check (auth.uid() = user_id and status = 'pending');

-- Only the project's owner can approve or deny a pending request.
drop policy if exists "Owners can respond to join requests" on project_collaborators;
create policy "Owners can respond to join requests" on project_collaborators
  for update using (
    exists (select 1 from projects where projects.id = project_collaborators.project_id and projects.owner_id = auth.uid())
  );

-- A requester can withdraw their own request/membership; an owner can remove
-- a collaborator from their own project.
drop policy if exists "Users can leave as collaborators" on project_collaborators;
drop policy if exists "Leave or remove a collaborator" on project_collaborators;
create policy "Leave or remove a collaborator" on project_collaborators
  for delete using (
    auth.uid() = user_id
    or exists (select 1 from projects where projects.id = project_collaborators.project_id and projects.owner_id = auth.uid())
  );

-- enforce "Basic = 1 project" at the database level — this cannot be bypassed
-- by calling the API directly, unlike a check done only in the browser
create or replace function public.enforce_project_limit()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  is_prem boolean;
  existing_count int;
begin
  select coalesce(is_premium, false) into is_prem from public.profiles where id = new.owner_id;
  select count(*) into existing_count from public.projects where owner_id = new.owner_id;
  if not coalesce(is_prem, false) and existing_count >= 1 then
    raise exception 'Free plan is limited to 1 project. Upgrade to Premium to add more.';
  end if;
  return new;
end;
$$;

drop trigger if exists enforce_project_limit_trigger on projects;
create trigger enforce_project_limit_trigger
  before insert on projects
  for each row execute function public.enforce_project_limit();

-- ---------------------------------------------------------------------------
-- STORAGE: lets the manager upload real photo files for Learn More posts,
-- instead of pasting an image URL. Anyone can view a file (the Learn More
-- page is public); only a project's own owner can upload into or delete from
-- that project's folder, enforced by matching the file's path prefix against
-- projects the requester actually owns.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('project-post-images', 'project-post-images', true)
on conflict (id) do nothing;

drop policy if exists "Public can view post images" on storage.objects;
create policy "Public can view post images" on storage.objects
  for select using (bucket_id = 'project-post-images');

drop policy if exists "Owners can upload post images" on storage.objects;
create policy "Owners can upload post images" on storage.objects
  for insert with check (
    bucket_id = 'project-post-images'
    and exists (
      select 1 from projects
      where projects.id::text = (storage.foldername(name))[1]
        and projects.owner_id = auth.uid()
    )
  );

drop policy if exists "Owners can update post images" on storage.objects;
create policy "Owners can update post images" on storage.objects
  for update using (
    bucket_id = 'project-post-images'
    and exists (
      select 1 from projects
      where projects.id::text = (storage.foldername(name))[1]
        and projects.owner_id = auth.uid()
    )
  );

drop policy if exists "Owners can delete post images" on storage.objects;
create policy "Owners can delete post images" on storage.objects
  for delete using (
    bucket_id = 'project-post-images'
    and exists (
      select 1 from projects
      where projects.id::text = (storage.foldername(name))[1]
        and projects.owner_id = auth.uid()
    )
  );

-- ---------------------------------------------------------------------------
-- POSTS: the public "Learn more" profile page, like an Instagram feed for the
-- project. Fully public to view; only the manager can add/edit/delete.
-- ---------------------------------------------------------------------------
create table if not exists project_posts (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  text text,
  image_url text,
  youtube_link text,
  created_at timestamptz not null default now(),
  constraint project_posts_has_content check (text is not null or image_url is not null or youtube_link is not null)
);

alter table project_posts drop constraint if exists project_posts_image_url_format;
alter table project_posts add constraint project_posts_image_url_format
  check (image_url is null or image_url ~ '^https://');

alter table project_posts drop constraint if exists project_posts_youtube_link_format;
alter table project_posts add constraint project_posts_youtube_link_format
  check (youtube_link is null or youtube_link ~ '^https://(www\.)?(youtube\.com|youtu\.be)/');

alter table project_posts enable row level security;

drop policy if exists "Public can read posts" on project_posts;
create policy "Public can read posts" on project_posts
  for select using (true);

drop policy if exists "Owners can add posts" on project_posts;
create policy "Owners can add posts" on project_posts
  for insert with check (exists (select 1 from projects where projects.id = project_posts.project_id and projects.owner_id = auth.uid()));

drop policy if exists "Owners can update posts" on project_posts;
create policy "Owners can update posts" on project_posts
  for update using (exists (select 1 from projects where projects.id = project_posts.project_id and projects.owner_id = auth.uid()));

drop policy if exists "Owners can delete posts" on project_posts;
create policy "Owners can delete posts" on project_posts
  for delete using (exists (select 1 from projects where projects.id = project_posts.project_id and projects.owner_id = auth.uid()));

-- ---------------------------------------------------------------------------
-- GOALS: owner-managed, with a 0-100 progress value
-- ---------------------------------------------------------------------------
create table if not exists project_goals (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  title text not null,
  description text,
  progress int not null default 0 check (progress between 0 and 100),
  created_at timestamptz not null default now()
);

alter table project_goals enable row level security;

-- The project workspace (goals, requirements, tasks) is now private to the team —
-- only the manager and approved collaborators can see it. The public-facing
-- page for everyone else is the "Learn more" posts feed (project_posts, above).
drop policy if exists "Public can read goals" on project_goals;
drop policy if exists "Team can read goals" on project_goals;
create policy "Team can read goals" on project_goals
  for select using (
    exists (select 1 from projects where projects.id = project_goals.project_id and projects.owner_id = auth.uid())
    or exists (
      select 1 from project_collaborators
      where project_collaborators.project_id = project_goals.project_id
        and project_collaborators.user_id = auth.uid()
        and project_collaborators.status = 'approved'
    )
  );

drop policy if exists "Owners can add goals" on project_goals;
create policy "Owners can add goals" on project_goals
  for insert with check (exists (select 1 from projects where projects.id = project_goals.project_id and projects.owner_id = auth.uid()));

drop policy if exists "Owners can update goals" on project_goals;
create policy "Owners can update goals" on project_goals
  for update using (exists (select 1 from projects where projects.id = project_goals.project_id and projects.owner_id = auth.uid()));

drop policy if exists "Owners can delete goals" on project_goals;
create policy "Owners can delete goals" on project_goals
  for delete using (exists (select 1 from projects where projects.id = project_goals.project_id and projects.owner_id = auth.uid()));

-- ---------------------------------------------------------------------------
-- REQUIREMENTS: owner-managed, status moves through created -> implemented -> verified -> validated
-- ---------------------------------------------------------------------------
create table if not exists project_requirements (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  title text not null,
  description text,
  status text not null default 'created' check (status in ('created','implemented','verified','validated')),
  created_at timestamptz not null default now()
);

-- widen the status set for anyone who already has this table from before "created" existed
alter table project_requirements drop constraint if exists project_requirements_status_check;
alter table project_requirements add constraint project_requirements_status_check
  check (status in ('created','implemented','verified','validated'));
alter table project_requirements alter column status set default 'created';

alter table project_requirements enable row level security;

drop policy if exists "Public can read requirements" on project_requirements;
drop policy if exists "Team can read requirements" on project_requirements;
create policy "Team can read requirements" on project_requirements
  for select using (
    exists (select 1 from projects where projects.id = project_requirements.project_id and projects.owner_id = auth.uid())
    or exists (
      select 1 from project_collaborators
      where project_collaborators.project_id = project_requirements.project_id
        and project_collaborators.user_id = auth.uid()
        and project_collaborators.status = 'approved'
    )
  );

drop policy if exists "Owners can add requirements" on project_requirements;
create policy "Owners can add requirements" on project_requirements
  for insert with check (exists (select 1 from projects where projects.id = project_requirements.project_id and projects.owner_id = auth.uid()));

drop policy if exists "Owners can update requirements" on project_requirements;
create policy "Owners can update requirements" on project_requirements
  for update using (exists (select 1 from projects where projects.id = project_requirements.project_id and projects.owner_id = auth.uid()));

drop policy if exists "Owners can delete requirements" on project_requirements;
create policy "Owners can delete requirements" on project_requirements
  for delete using (exists (select 1 from projects where projects.id = project_requirements.project_id and projects.owner_id = auth.uid()));

-- ---------------------------------------------------------------------------
-- HELPERS: reusable checks for "is this person on the project's team" and
-- "is this person the project's manager" — used by every table below this
-- point instead of repeating the same join logic in each policy.
-- ---------------------------------------------------------------------------
create or replace function public.is_project_owner(p_project_id uuid)
returns boolean
language sql
security definer
stable
as $$
  select exists (
    select 1 from projects where projects.id = p_project_id and projects.owner_id = auth.uid()
  );
$$;

create or replace function public.is_project_team_member(p_project_id uuid)
returns boolean
language sql
security definer
stable
as $$
  select public.is_project_owner(p_project_id) or exists (
    select 1 from project_collaborators
    where project_collaborators.project_id = p_project_id
      and project_collaborators.user_id = auth.uid()
      and project_collaborators.status = 'approved'
  );
$$;

-- Lets the AI assistant's Edge Function call this as an RPC to re-verify
-- team membership server-side, independent of anything the browser claims.
grant execute on function public.is_project_team_member(uuid) to authenticated;

-- A database-level fallback for created_by_name columns below. Several
-- tables record who created something as both an id (created_by) and a
-- display name (created_by_name) so the UI never needs a join just to show
-- "by Alice" — but a name has no natural default the way auth.uid() is a
-- natural default for the id. If a client ever forgets to send the name
-- (as one of ours briefly did for tasks), this default looks it up from
-- profiles server-side instead of the insert failing outright.
create or replace function public.current_display_name()
returns text
language sql
security definer
stable
as $$
  select coalesce(display_name, 'Someone') from profiles where id = auth.uid();
$$;

-- ---------------------------------------------------------------------------
-- TASKS: a Kanban board, manager-only to create/edit/move/assign.
-- Visible to everyone (same transparency-first pattern as goals/requirements).
-- ---------------------------------------------------------------------------
create table if not exists project_tasks (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  title text not null,
  description text,
  due_date date,
  status text not null default 'created' check (status in ('created','working','finished','approved')),
  created_at timestamptz not null default now()
);

alter table project_tasks enable row level security;

drop policy if exists "Public can read tasks" on project_tasks;
drop policy if exists "Team can read tasks" on project_tasks;
create policy "Team can read tasks" on project_tasks
  for select using (
    exists (select 1 from projects where projects.id = project_tasks.project_id and projects.owner_id = auth.uid())
    or exists (
      select 1 from project_collaborators
      where project_collaborators.project_id = project_tasks.project_id
        and project_collaborators.user_id = auth.uid()
        and project_collaborators.status = 'approved'
    )
  );

drop policy if exists "Owners can add tasks" on project_tasks;
create policy "Owners can add tasks" on project_tasks
  for insert with check (exists (select 1 from projects where projects.id = project_tasks.project_id and projects.owner_id = auth.uid()));

drop policy if exists "Owners can update tasks" on project_tasks;
create policy "Owners can update tasks" on project_tasks
  for update using (exists (select 1 from projects where projects.id = project_tasks.project_id and projects.owner_id = auth.uid()));

drop policy if exists "Owners can delete tasks" on project_tasks;
create policy "Owners can delete tasks" on project_tasks
  for delete using (exists (select 1 from projects where projects.id = project_tasks.project_id and projects.owner_id = auth.uid()));

-- a task can be assigned to one or more people (the manager decides who)
create table if not exists task_assignees (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references project_tasks(id) on delete cascade,
  user_id uuid not null references profiles(id) on delete cascade,
  assigned_at timestamptz not null default now(),
  unique (task_id, user_id)
);

alter table task_assignees enable row level security;

drop policy if exists "Public can read task assignees" on task_assignees;
drop policy if exists "Team can read task assignees" on task_assignees;
create policy "Team can read task assignees" on task_assignees
  for select using (
    exists (
      select 1 from project_tasks
      join projects on projects.id = project_tasks.project_id
      where project_tasks.id = task_assignees.task_id and projects.owner_id = auth.uid()
    )
    or exists (
      select 1 from project_tasks
      join project_collaborators on project_collaborators.project_id = project_tasks.project_id
      where project_tasks.id = task_assignees.task_id
        and project_collaborators.user_id = auth.uid()
        and project_collaborators.status = 'approved'
    )
  );

drop policy if exists "Owners can assign tasks" on task_assignees;
create policy "Owners can assign tasks" on task_assignees
  for insert with check (
    exists (
      select 1 from project_tasks
      join projects on projects.id = project_tasks.project_id
      where project_tasks.id = task_assignees.task_id and projects.owner_id = auth.uid()
    )
  );

drop policy if exists "Owners can unassign tasks" on task_assignees;
create policy "Owners can unassign tasks" on task_assignees
  for delete using (
    exists (
      select 1 from project_tasks
      join projects on projects.id = project_tasks.project_id
      where project_tasks.id = task_assignees.task_id and projects.owner_id = auth.uid()
    )
  );

-- ---------------------------------------------------------------------------
-- PROJECT SUPPORTERS
-- ---------------------------------------------------------------------------
create table if not exists project_supporters (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  user_id uuid not null default auth.uid(),
  created_at timestamptz not null default now(),
  unique (project_id, user_id)
);

alter table project_supporters drop constraint if exists project_supporters_user_id_fkey;
alter table project_supporters add constraint project_supporters_user_id_fkey
  foreign key (user_id) references profiles(id) on delete cascade;

-- Supporters may record a self-reported credit amount after paying via the
-- project's PayPal link. This is NOT server-verified — we never see the actual
-- transaction, since we don't process the payment ourselves.
alter table project_supporters add column if not exists amount numeric;

drop policy if exists "Users can update their own support record" on project_supporters;
create policy "Users can update their own support record" on project_supporters
  for update using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- ROW LEVEL SECURITY
-- ---------------------------------------------------------------------------
alter table profiles enable row level security;
alter table projects enable row level security;
alter table project_supporters enable row level security;

drop policy if exists "Public can read profiles" on profiles;
create policy "Public can read profiles" on profiles
  for select using (true);

drop policy if exists "Users can update their own profile" on profiles;
create policy "Users can update their own profile" on profiles
  for update using (auth.uid() = id);
-- NOTE: this intentionally allows a logged-in user to set their own is_premium.
-- There's no server here to verify the PayPal transaction independently, so this
-- trusts the client's confirmation that payment succeeded. See the app's premium.html
-- comments for the honest limitation this implies.

drop policy if exists "Public can read projects" on projects;
create policy "Public can read projects" on projects
  for select using (true);

drop policy if exists "Users can create their own projects" on projects;
create policy "Users can create their own projects" on projects
  for insert with check (auth.uid() = owner_id);

drop policy if exists "Owners can update their projects" on projects;
create policy "Owners can update their projects" on projects
  for update using (auth.uid() = owner_id);

drop policy if exists "Owners can delete their projects" on projects;
create policy "Owners can delete their projects" on projects
  for delete using (auth.uid() = owner_id);

drop policy if exists "Public can read supporters" on project_supporters;
create policy "Public can read supporters" on project_supporters
  for select using (true);

drop policy if exists "Users can support projects" on project_supporters;
create policy "Users can support projects" on project_supporters
  for insert with check (auth.uid() = user_id);

drop policy if exists "Users can unsupport projects" on project_supporters;
create policy "Users can unsupport projects" on project_supporters
  for delete using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- TEAM FEED: unlike the public "Learn more" posts (owner-only), anyone on the
-- project's team can post here — this is the internal, private feed for
-- everyone enrolled in the project. Visible only to the team.
-- ---------------------------------------------------------------------------
create table if not exists project_feed_posts (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  user_id uuid not null default auth.uid(),
  user_name text not null,
  text text,
  image_url text,
  youtube_link text,
  created_at timestamptz not null default now(),
  constraint project_feed_posts_has_content check (text is not null or image_url is not null or youtube_link is not null)
);

alter table project_feed_posts drop constraint if exists project_feed_posts_image_url_format;
alter table project_feed_posts add constraint project_feed_posts_image_url_format
  check (image_url is null or image_url ~ '^https://');

alter table project_feed_posts drop constraint if exists project_feed_posts_youtube_link_format;
alter table project_feed_posts add constraint project_feed_posts_youtube_link_format
  check (youtube_link is null or youtube_link ~ '^https://(www\.)?(youtube\.com|youtu\.be)/');

alter table project_feed_posts enable row level security;

drop policy if exists "Team can read feed posts" on project_feed_posts;
create policy "Team can read feed posts" on project_feed_posts
  for select using (public.is_project_team_member(project_id));

drop policy if exists "Team can post to the feed" on project_feed_posts;
create policy "Team can post to the feed" on project_feed_posts
  for insert with check (auth.uid() = user_id and public.is_project_team_member(project_id));

drop policy if exists "Authors can edit their own feed posts" on project_feed_posts;
create policy "Authors can edit their own feed posts" on project_feed_posts
  for update using (auth.uid() = user_id);

drop policy if exists "Authors or the manager can delete feed posts" on project_feed_posts;
create policy "Authors or the manager can delete feed posts" on project_feed_posts
  for delete using (auth.uid() = user_id or public.is_project_owner(project_id));

-- ---------------------------------------------------------------------------
-- POLLS: any team member (not just the manager) can create one; the team
-- votes. One vote per person per poll, changeable.
-- ---------------------------------------------------------------------------
create table if not exists project_polls (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  question text not null,
  options jsonb not null,
  created_at timestamptz not null default now(),
  constraint project_polls_options_shape check (jsonb_typeof(options) = 'array' and jsonb_array_length(options) >= 2)
);

-- track who created each poll, so any team member (not just the manager) can
-- author one and edit/delete their own — this block runs only the first time,
-- backfilling existing polls (all owner-created under the old rule) safely.
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_name = 'project_polls' and column_name = 'created_by'
  ) then
    alter table project_polls add column created_by uuid;
    alter table project_polls add column created_by_name text;
    update project_polls set
      created_by = projects.owner_id,
      created_by_name = projects.owner_name
    from projects where projects.id = project_polls.project_id;
    alter table project_polls alter column created_by set not null;
    alter table project_polls alter column created_by set default auth.uid();
    alter table project_polls alter column created_by_name set not null;
  end if;
end $$;

alter table project_polls alter column created_by_name set default public.current_display_name();

alter table project_polls enable row level security;

drop policy if exists "Team can read polls" on project_polls;
create policy "Team can read polls" on project_polls
  for select using (public.is_project_team_member(project_id));

drop policy if exists "Managers can create polls" on project_polls;
drop policy if exists "Team can create polls" on project_polls;
create policy "Team can create polls" on project_polls
  for insert with check (auth.uid() = created_by and public.is_project_team_member(project_id));

drop policy if exists "Managers can update polls" on project_polls;
drop policy if exists "Creators can update their own polls" on project_polls;
create policy "Creators can update their own polls" on project_polls
  for update using (auth.uid() = created_by);

drop policy if exists "Managers can delete polls" on project_polls;
drop policy if exists "Creators or the manager can delete polls" on project_polls;
create policy "Creators or the manager can delete polls" on project_polls
  for delete using (auth.uid() = created_by or public.is_project_owner(project_id));

create table if not exists poll_votes (
  id uuid primary key default gen_random_uuid(),
  poll_id uuid not null references project_polls(id) on delete cascade,
  user_id uuid not null default auth.uid(),
  option_index int not null,
  created_at timestamptz not null default now(),
  unique (poll_id, user_id)
);

alter table poll_votes enable row level security;

drop policy if exists "Team can read votes" on poll_votes;
create policy "Team can read votes" on poll_votes
  for select using (
    exists (select 1 from project_polls where project_polls.id = poll_votes.poll_id and public.is_project_team_member(project_polls.project_id))
  );

drop policy if exists "Team can vote" on poll_votes;
create policy "Team can vote" on poll_votes
  for insert with check (
    auth.uid() = user_id
    and exists (select 1 from project_polls where project_polls.id = poll_votes.poll_id and public.is_project_team_member(project_polls.project_id))
  );

drop policy if exists "Users can change their own vote" on poll_votes;
create policy "Users can change their own vote" on poll_votes
  for update using (auth.uid() = user_id);

drop policy if exists "Users can retract their own vote" on poll_votes;
create policy "Users can retract their own vote" on poll_votes
  for delete using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- EVENTS: any team member (not just the manager) can create one; the team
-- RSVPs going / not going.
-- ---------------------------------------------------------------------------
create table if not exists project_events (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  title text not null,
  description text,
  event_at timestamptz not null,
  created_at timestamptz not null default now()
);

-- same one-time, safe backfill pattern as polls above
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_name = 'project_events' and column_name = 'created_by'
  ) then
    alter table project_events add column created_by uuid;
    alter table project_events add column created_by_name text;
    update project_events set
      created_by = projects.owner_id,
      created_by_name = projects.owner_name
    from projects where projects.id = project_events.project_id;
    alter table project_events alter column created_by set not null;
    alter table project_events alter column created_by set default auth.uid();
    alter table project_events alter column created_by_name set not null;
  end if;
end $$;

alter table project_events alter column created_by_name set default public.current_display_name();

alter table project_events enable row level security;

drop policy if exists "Team can read events" on project_events;
create policy "Team can read events" on project_events
  for select using (public.is_project_team_member(project_id));

drop policy if exists "Managers can create events" on project_events;
drop policy if exists "Team can create events" on project_events;
create policy "Team can create events" on project_events
  for insert with check (auth.uid() = created_by and public.is_project_team_member(project_id));

drop policy if exists "Managers can update events" on project_events;
drop policy if exists "Creators can update their own events" on project_events;
create policy "Creators can update their own events" on project_events
  for update using (auth.uid() = created_by);

drop policy if exists "Managers can delete events" on project_events;
drop policy if exists "Creators or the manager can delete events" on project_events;
create policy "Creators or the manager can delete events" on project_events
  for delete using (auth.uid() = created_by or public.is_project_owner(project_id));

create table if not exists event_rsvps (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references project_events(id) on delete cascade,
  user_id uuid not null default auth.uid(),
  status text not null check (status in ('going','not_going')),
  created_at timestamptz not null default now(),
  unique (event_id, user_id)
);

alter table event_rsvps enable row level security;

drop policy if exists "Team can read RSVPs" on event_rsvps;
create policy "Team can read RSVPs" on event_rsvps
  for select using (
    exists (select 1 from project_events where project_events.id = event_rsvps.event_id and public.is_project_team_member(project_events.project_id))
  );

drop policy if exists "Team can RSVP" on event_rsvps;
create policy "Team can RSVP" on event_rsvps
  for insert with check (
    auth.uid() = user_id
    and exists (select 1 from project_events where project_events.id = event_rsvps.event_id and public.is_project_team_member(project_events.project_id))
  );

drop policy if exists "Users can change their own RSVP" on event_rsvps;
create policy "Users can change their own RSVP" on event_rsvps
  for update using (auth.uid() = user_id);

drop policy if exists "Users can retract their own RSVP" on event_rsvps;
create policy "Users can retract their own RSVP" on event_rsvps
  for delete using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- COSTS: any team member can log and edit project costs.
-- ---------------------------------------------------------------------------
create table if not exists project_costs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  description text not null,
  amount numeric not null check (amount >= 0),
  currency text not null default 'USD',
  cost_date date,
  category text,
  receipt_url text,
  added_by uuid not null default auth.uid(),
  added_by_name text not null,
  created_at timestamptz not null default now()
);

alter table project_costs drop constraint if exists project_costs_receipt_url_format;
alter table project_costs add constraint project_costs_receipt_url_format
  check (receipt_url is null or receipt_url ~ '^https://');

alter table project_costs enable row level security;

drop policy if exists "Team can read costs" on project_costs;
create policy "Team can read costs" on project_costs
  for select using (public.is_project_team_member(project_id));

drop policy if exists "Team can add costs" on project_costs;
create policy "Team can add costs" on project_costs
  for insert with check (auth.uid() = added_by and public.is_project_team_member(project_id));

drop policy if exists "Team can edit costs" on project_costs;
create policy "Team can edit costs" on project_costs
  for update using (public.is_project_team_member(project_id));

drop policy if exists "Adders or the manager can delete costs" on project_costs;
create policy "Adders or the manager can delete costs" on project_costs
  for delete using (auth.uid() = added_by or public.is_project_owner(project_id));

-- ---------------------------------------------------------------------------
-- KANBAN OPENED UP: "managed by all collaborators" — tasks and assignments
-- are now a fully shared surface for the whole team, not manager-only.
-- created_by is kept for attribution, but does not gate editing.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_name = 'project_tasks' and column_name = 'created_by'
  ) then
    alter table project_tasks add column created_by uuid;
    alter table project_tasks add column created_by_name text;
    update project_tasks set
      created_by = projects.owner_id,
      created_by_name = projects.owner_name
    from projects where projects.id = project_tasks.project_id;
    alter table project_tasks alter column created_by set not null;
    alter table project_tasks alter column created_by set default auth.uid();
    alter table project_tasks alter column created_by_name set not null;
  end if;
end $$;

alter table project_tasks alter column created_by_name set default public.current_display_name();

drop policy if exists "Owners can add tasks" on project_tasks;
drop policy if exists "Team can add tasks" on project_tasks;
create policy "Team can add tasks" on project_tasks
  for insert with check (auth.uid() = created_by and public.is_project_team_member(project_id));

drop policy if exists "Owners can update tasks" on project_tasks;
drop policy if exists "Team can update tasks" on project_tasks;
create policy "Team can update tasks" on project_tasks
  for update using (public.is_project_team_member(project_id));

drop policy if exists "Owners can delete tasks" on project_tasks;
drop policy if exists "Team can delete tasks" on project_tasks;
create policy "Team can delete tasks" on project_tasks
  for delete using (public.is_project_team_member(project_id));

drop policy if exists "Owners can assign tasks" on task_assignees;
drop policy if exists "Team can assign tasks" on task_assignees;
create policy "Team can assign tasks" on task_assignees
  for insert with check (
    exists (
      select 1 from project_tasks
      where project_tasks.id = task_assignees.task_id
        and public.is_project_team_member(project_tasks.project_id)
    )
  );

drop policy if exists "Owners can unassign tasks" on task_assignees;
drop policy if exists "Team can unassign tasks" on task_assignees;
create policy "Team can unassign tasks" on task_assignees
  for delete using (
    exists (
      select 1 from project_tasks
      where project_tasks.id = task_assignees.task_id
        and public.is_project_team_member(project_tasks.project_id)
    )
  );

-- ---------------------------------------------------------------------------
-- TASK STATUS HISTORY: an automatic, tamper-proof audit trail. A database
-- trigger logs every status a task passes through — including its creation —
-- so "created on X, approved on Y" always reflects what actually happened,
-- not just what a client claims. Clients can only ever read this table;
-- only the trigger itself (running with elevated rights) writes to it.
-- ---------------------------------------------------------------------------
create table if not exists task_status_history (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references project_tasks(id) on delete cascade,
  status text not null check (status in ('created','working','finished','approved')),
  changed_by uuid,
  changed_by_name text not null default 'Someone',
  changed_at timestamptz not null default now()
);

alter table task_status_history enable row level security;

drop policy if exists "Team can read task history" on task_status_history;
create policy "Team can read task history" on task_status_history
  for select using (
    exists (
      select 1 from project_tasks
      where project_tasks.id = task_status_history.task_id
        and public.is_project_team_member(project_tasks.project_id)
    )
  );
-- deliberately no insert/update/delete policy for authenticated users —
-- only the trigger function below (as the table owner) can write here.

create or replace function public.log_task_status_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_name text;
begin
  select display_name into actor_name from profiles where id = auth.uid();
  if (tg_op = 'INSERT') then
    insert into task_status_history (task_id, status, changed_by, changed_by_name)
    values (new.id, new.status, auth.uid(), coalesce(actor_name, 'Someone'));
  elsif (tg_op = 'UPDATE' and new.status is distinct from old.status) then
    insert into task_status_history (task_id, status, changed_by, changed_by_name)
    values (new.id, new.status, auth.uid(), coalesce(actor_name, 'Someone'));
  end if;
  return new;
end;
$$;

drop trigger if exists task_status_change_trigger on project_tasks;
create trigger task_status_change_trigger
  after insert or update on project_tasks
  for each row execute function public.log_task_status_change();

-- ---------------------------------------------------------------------------
-- TASK DOCUMENTS: files up to 10MB, private to the project team (not public
-- like post images/QR codes — these can be sensitive working documents).
-- ---------------------------------------------------------------------------
create table if not exists task_documents (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references project_tasks(id) on delete cascade,
  file_name text not null,
  file_path text not null,
  file_size bigint,
  uploaded_by uuid not null default auth.uid(),
  uploaded_by_name text not null,
  created_at timestamptz not null default now()
);

alter table task_documents enable row level security;

drop policy if exists "Team can read task documents" on task_documents;
create policy "Team can read task documents" on task_documents
  for select using (
    exists (
      select 1 from project_tasks
      where project_tasks.id = task_documents.task_id
        and public.is_project_team_member(project_tasks.project_id)
    )
  );

drop policy if exists "Team can upload task documents" on task_documents;
create policy "Team can upload task documents" on task_documents
  for insert with check (
    auth.uid() = uploaded_by
    and exists (
      select 1 from project_tasks
      where project_tasks.id = task_documents.task_id
        and public.is_project_team_member(project_tasks.project_id)
    )
  );

drop policy if exists "Uploaders can edit their own task documents" on task_documents;
create policy "Uploaders can edit their own task documents" on task_documents
  for update using (auth.uid() = uploaded_by);

drop policy if exists "Uploaders or the manager can delete task documents" on task_documents;
create policy "Uploaders or the manager can delete task documents" on task_documents
  for delete using (
    auth.uid() = uploaded_by
    or exists (
      select 1 from project_tasks
      where project_tasks.id = task_documents.task_id
        and public.is_project_owner(project_tasks.project_id)
    )
  );

-- private storage bucket for task documents — 10MB limit enforced by
-- Supabase Storage itself, not just client-side JS
insert into storage.buckets (id, name, public, file_size_limit)
values ('task-documents', 'task-documents', false, 10485760)
on conflict (id) do update set file_size_limit = 10485760, public = false;

drop policy if exists "Team can view task document files" on storage.objects;
create policy "Team can view task document files" on storage.objects
  for select using (
    bucket_id = 'task-documents'
    and public.is_project_team_member(((storage.foldername(name))[1])::uuid)
  );

drop policy if exists "Team can upload task document files" on storage.objects;
create policy "Team can upload task document files" on storage.objects
  for insert with check (
    bucket_id = 'task-documents'
    and public.is_project_team_member(((storage.foldername(name))[1])::uuid)
  );

drop policy if exists "Uploaders can replace their task document files" on storage.objects;
create policy "Uploaders can replace their task document files" on storage.objects
  for update using (bucket_id = 'task-documents' and owner = auth.uid());

drop policy if exists "Uploaders or managers can delete task document files" on storage.objects;
create policy "Uploaders or managers can delete task document files" on storage.objects
  for delete using (
    bucket_id = 'task-documents'
    and (owner = auth.uid() or public.is_project_owner(((storage.foldername(name))[1])::uuid))
  );
