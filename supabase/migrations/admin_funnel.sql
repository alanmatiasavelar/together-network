-- Applied to production on 2026-11-01.
-- ---------------------------------------------------------------------------
-- ADMIN GROWTH FUNNEL
--
-- One admin-only function that answers "where do people drop off between signing up and
-- building together?" There is no event log, so every step is derived from what people actually
-- did (project/collaborator/task/chat/... rows and their timestamps).
--
-- Steps are NESTED: a person only counts at a step if they also passed every earlier step, so the
-- numbers can only go down and each percentage is "of the previous step".
--
--   People:   signed up -> confirmed email -> created or joined a project -> got into a team
--             -> did real work in a project -> came back (any activity >= 7 days after signup)
--   Projects: created -> got a join request -> got a teammate -> started building
--             -> active in the last 14 days        (side facts: set up / funded / finished)
--
-- Not measurable yet: visitors who never sign up (no page-view tracking).
--
-- p_days = 0 means all time. p_exclude_internal hides the admin's own account and @example.com test
-- accounts so the founder's own activity doesn't make the product look better than it is.
-- Returns only aggregates plus a few short lists for follow-up (names/emails are visible to the admin
-- anyway). Security definer so it can read across projects and auth.users; the first line enforces admin.
-- ---------------------------------------------------------------------------
create or replace function public.admin_funnel(p_days integer default 0, p_exclude_internal boolean default true)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  since timestamptz := case when coalesce(p_days, 0) > 0 then now() - make_interval(days => p_days) else '-infinity'::timestamptz end;
  result jsonb;
begin
  if not public.is_site_admin() then raise exception 'not authorized'; end if;

  with
  excluded as (
    select id from profiles
    where p_exclude_internal and (id = auth.uid() or email ilike '%@example.com')
  ),
  real_projects as (
    select * from projects where owner_id not in (select id from excluded)
  ),
  -- Things people do inside a project. 'build' = day-to-day work; 'setup' = goals/requirements (owner-only).
  work as (
    select uid, project_id, at, kind from (
      select user_id as uid, project_id, created_at as at, 'build' as kind from project_chat_messages
      union all select user_id, project_id, created_at, 'build' from project_feed_posts
      union all select created_by, project_id, created_at, 'build' from project_tasks
      union all select created_by, project_id, created_at, 'build' from project_activities
      union all select added_by, project_id, created_at, 'build' from project_costs
      union all select created_by, project_id, created_at, 'build' from project_events
      union all select created_by, project_id, created_at, 'build' from project_polls
      union all select p.owner_id, r.project_id, r.created_at, 'setup' from project_requirements r join projects p on p.id = r.project_id
      union all select p.owner_id, g.project_id, g.created_at, 'setup' from project_goals g join projects p on p.id = g.project_id
    ) w
    where uid is not null and uid not in (select id from excluded)
  ),
  first_action as (
    select uid, min(at) as at from (
      select owner_id as uid, created_at as at from projects
      union all select user_id, joined_at from project_collaborators
      union all select user_id, created_at from project_supporters
    ) x
    where uid not in (select id from excluded)
    group by uid
  ),
  team_users as (
    select c.user_id as uid
      from project_collaborators c join projects p on p.id = c.project_id
     where c.status = 'approved' and c.user_id <> p.owner_id
    union
    select p.owner_id
      from projects p
     where exists (select 1 from project_collaborators c where c.project_id = p.id and c.status = 'approved' and c.user_id <> p.owner_id)
  ),
  acts as (
    select uid, at from work
    union all select user_id, created_at from project_ai_messages where role = 'user'
    union all select user_id, joined_at from project_collaborators
    union all select user_id, created_at from project_supporters
    union all select user_id, created_at from project_favorites
    union all select user_id, created_at from project_post_likes
  ),

  -- ---------- people ----------
  cohort as (
    select pr.id, pr.created_at,
           (u.email_confirmed_at is not null and coalesce(b.status, 'verified') = 'verified') as confirmed
      from profiles pr
      left join auth.users u on u.id = pr.id
      left join email_confirmation_backlog b on b.user_id = pr.id
     where pr.created_at >= since and pr.id not in (select id from excluded)
  ),
  user_flags as (
    select c.id, c.confirmed,
           (c.id in (select uid from first_action)) as acted,
           (c.id in (select uid from team_users)) as teamed,
           (c.id in (select uid from work)) as worked,
           exists (select 1 from acts a where a.uid = c.id and a.at >= c.created_at + interval '7 days') as returned
      from cohort c
  ),
  u_steps as (
    select count(*) as signed_up,
           count(*) filter (where confirmed) as confirmed,
           count(*) filter (where confirmed and acted) as acted,
           count(*) filter (where confirmed and acted and teamed) as teamed,
           count(*) filter (where confirmed and acted and teamed and worked) as worked,
           count(*) filter (where confirmed and acted and teamed and worked and returned) as returned
      from user_flags
  ),
  med as (
    select percentile_cont(0.5) within group (order by greatest(0, extract(epoch from (fa.at - c.created_at)) / 86400)) as days
      from cohort c join first_action fa on fa.uid = c.id
  ),

  -- ---------- projects ----------
  pc as (select * from real_projects where created_at >= since),
  p_flags as (
    select pc.id,
           exists (select 1 from project_collaborators c where c.project_id = pc.id and c.user_id <> pc.owner_id) as requested,
           exists (select 1 from project_collaborators c where c.project_id = pc.id and c.user_id <> pc.owner_id and c.status = 'approved') as teamed,
           exists (select 1 from work w where w.project_id = pc.id and w.kind = 'build') as building,
           exists (select 1 from work w where w.project_id = pc.id and w.kind = 'build' and w.at >= now() - interval '14 days') as active,
           (exists (select 1 from project_goals g where g.project_id = pc.id) or exists (select 1 from project_requirements r where r.project_id = pc.id)) as set_up,
           exists (select 1 from project_supporters s where s.project_id = pc.id and s.confirmed) as funded,
           (pc.stage = 'finish') as finished
      from pc
  ),
  p_steps as (
    select count(*) as created,
           count(*) filter (where requested) as requested,
           count(*) filter (where requested and teamed) as teamed,
           count(*) filter (where requested and teamed and building) as building,
           count(*) filter (where requested and teamed and building and active) as active,
           count(*) filter (where set_up) as set_up,
           count(*) filter (where funded) as funded,
           count(*) filter (where finished) as finished
      from p_flags
  ),

  -- ---------- last 8 weeks ----------
  weeks as (select date_trunc('week', now()) - (n * interval '7 days') as w from generate_series(7, 0, -1) n),
  weekly as (
    select to_char(w.w, 'YYYY-MM-DD') as week,
           (select count(*) from profiles pr where pr.created_at >= w.w and pr.created_at < w.w + interval '7 days' and pr.id not in (select id from excluded)) as signups,
           (select count(*) from real_projects p where p.created_at >= w.w and p.created_at < w.w + interval '7 days') as projects,
           (select count(*) from project_collaborators c join projects p on p.id = c.project_id
             where c.user_id <> p.owner_id and c.user_id not in (select id from excluded)
               and c.joined_at >= w.w and c.joined_at < w.w + interval '7 days') as join_requests,
           (select count(distinct x.uid) from work x where x.at >= w.w and x.at < w.w + interval '7 days') as active_users,
           (select count(distinct x.project_id) from work x where x.kind = 'build' and x.at >= w.w and x.at < w.w + interval '7 days') as active_projects
      from weeks w
  ),

  -- ---------- people and projects to follow up with ----------
  stuck as (
    select pr.display_name as name, pr.email,
           floor(extract(epoch from (now() - pr.created_at)) / 86400)::int as days,
           (u.email_confirmed_at is not null and coalesce(b.status, 'verified') = 'verified') as confirmed
      from profiles pr
      left join auth.users u on u.id = pr.id
      left join email_confirmation_backlog b on b.user_id = pr.id
     where pr.created_at <= now() - interval '3 days'
       and pr.id not in (select id from excluded)
       and pr.id not in (select uid from first_action)
     order by pr.created_at
     limit 15
  ),
  waiting as (
    select p.id as project_id, p.title, pr.display_name as name,
           floor(extract(epoch from (now() - c.joined_at)) / 86400)::int as days
      from project_collaborators c
      join projects p on p.id = c.project_id
      join profiles pr on pr.id = c.user_id
     where c.status = 'pending' and c.joined_at <= now() - interval '2 days'
       and c.user_id <> p.owner_id and c.user_id not in (select id from excluded)
     order by c.joined_at
     limit 15
  ),
  idle as (
    select p.id as project_id, p.title, p.owner_name as owner,
           floor(extract(epoch from (now() - coalesce((select max(w.at) from work w where w.project_id = p.id and w.kind = 'build'), p.created_at))) / 86400)::int as days
      from real_projects p
     where p.created_at <= now() - interval '14 days'
       and not exists (select 1 from work w where w.project_id = p.id and w.kind = 'build' and w.at >= now() - interval '14 days')
     order by days desc
     limit 15
  )
  select jsonb_build_object(
    'window_days', coalesce(p_days, 0),
    'excluding_internal', p_exclude_internal,
    'users', (select jsonb_build_object(
        'steps', jsonb_build_array(
          jsonb_build_object('key', 'signed_up', 'count', signed_up),
          jsonb_build_object('key', 'confirmed', 'count', confirmed),
          jsonb_build_object('key', 'acted', 'count', acted),
          jsonb_build_object('key', 'teamed', 'count', teamed),
          jsonb_build_object('key', 'worked', 'count', worked),
          jsonb_build_object('key', 'returned', 'count', returned)),
        'median_days_to_first_action', (select round(days::numeric, 1) from med)) from u_steps),
    'projects', (select jsonb_build_object(
        'steps', jsonb_build_array(
          jsonb_build_object('key', 'created', 'count', created),
          jsonb_build_object('key', 'requested', 'count', requested),
          jsonb_build_object('key', 'teamed', 'count', teamed),
          jsonb_build_object('key', 'building', 'count', building),
          jsonb_build_object('key', 'active', 'count', active)),
        'set_up', set_up, 'funded', funded, 'finished', finished) from p_steps),
    'weekly', (select coalesce(jsonb_agg(to_jsonb(weekly) order by week), '[]'::jsonb) from weekly),
    'stuck_users', (select coalesce(jsonb_agg(to_jsonb(stuck) order by days desc), '[]'::jsonb) from stuck),
    'waiting_requests', (select coalesce(jsonb_agg(to_jsonb(waiting) order by days desc), '[]'::jsonb) from waiting),
    'idle_projects', (select coalesce(jsonb_agg(to_jsonb(idle) order by days desc), '[]'::jsonb) from idle)
  ) into result;

  return result;
end;
$$;

revoke execute on function public.admin_funnel(integer, boolean) from public, anon;
grant execute on function public.admin_funnel(integer, boolean) to authenticated;
