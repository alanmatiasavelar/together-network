-- ---------------------------------------------------------------------------
-- CONTENT MODERATION: enforces the Terms of Use ban on violent/sexual
-- content (see terms.html) using OpenAI's free Moderation API, called
-- synchronously from a BEFORE INSERT/UPDATE trigger so flagged content is
-- hidden the instant it's created — not after the fact.
--
-- Run this whole file once in the Supabase Dashboard → SQL Editor.
--
-- Then, to actually turn moderation on, run this ONE line separately with
-- your real OpenAI API key (from https://platform.openai.com/api-keys):
--
--   select vault.create_secret('sk-...', 'openai_api_key');
--
-- Until that secret exists, the trigger below no-ops (fails open) so posting
-- and chat keep working normally — moderation silently activates the moment
-- the key is added, no further migration needed. The moderation endpoint
-- itself is free to call; you only need any OpenAI account with an API key.
-- ---------------------------------------------------------------------------

create extension if not exists http with schema extensions;

create or replace function public.is_site_admin()
returns boolean
language sql
security definer
stable
as $$
  select exists (
    select 1 from public.profiles where id = auth.uid() and email = 'aolbr_mail@yahoo.com.br'
  );
$$;

alter table project_posts add column if not exists flagged boolean not null default false;
alter table project_posts add column if not exists flag_categories text;
alter table project_feed_posts add column if not exists flagged boolean not null default false;
alter table project_feed_posts add column if not exists flag_categories text;
alter table project_chat_messages add column if not exists flagged boolean not null default false;
alter table project_chat_messages add column if not exists flag_categories text;

create or replace function public.enforce_content_moderation()
returns trigger
language plpgsql
security definer
set search_path = public, extensions, vault
as $$
declare
  content text;
  api_key text;
  resp extensions.http_response;
  result jsonb;
begin
  -- Use to_jsonb(NEW)->>'field' instead of NEW.body / NEW.text directly:
  -- this function is shared by 3 tables (only one of which has a "body"
  -- column), and PL/pgSQL requires every field referenced in an expression
  -- to exist on the row even in a CASE branch that isn't taken. jsonb key
  -- lookup just returns null for a missing key instead of erroring.
  content := coalesce(to_jsonb(NEW) ->> 'body', to_jsonb(NEW) ->> 'text');

  if content is null or length(trim(content)) = 0 then
    NEW.flagged := false;
    NEW.flag_categories := null;
    return NEW;
  end if;

  select decrypted_secret into api_key from vault.decrypted_secrets where name = 'openai_api_key';
  if api_key is null then
    return NEW; -- moderation not configured yet; fail open
  end if;

  begin
    select * into resp from extensions.http((
      'POST',
      'https://api.openai.com/v1/moderations',
      ARRAY[extensions.http_header('Authorization', 'Bearer ' || api_key)],
      'application/json',
      jsonb_build_object('model', 'omni-moderation-latest', 'input', content)::text
    )::extensions.http_request);
  exception when others then
    return NEW; -- OpenAI unreachable/erroring; fail open rather than blocking posting
  end;

  if resp.status = 200 then
    result := (resp.content::jsonb -> 'results' -> 0);
    if coalesce((result ->> 'flagged')::boolean, false) then
      NEW.flagged := true;
      select string_agg(key, ', ') into NEW.flag_categories
        from jsonb_each(result -> 'categories') where value::text = 'true';
    end if;
  end if;

  return NEW;
end;
$$;

drop trigger if exists trg_moderate_project_posts_ins on project_posts;
create trigger trg_moderate_project_posts_ins
  before insert on project_posts
  for each row execute function public.enforce_content_moderation();

drop trigger if exists trg_moderate_project_posts_upd on project_posts;
create trigger trg_moderate_project_posts_upd
  before update of text on project_posts
  for each row execute function public.enforce_content_moderation();

drop trigger if exists trg_moderate_project_feed_posts_ins on project_feed_posts;
create trigger trg_moderate_project_feed_posts_ins
  before insert on project_feed_posts
  for each row execute function public.enforce_content_moderation();

drop trigger if exists trg_moderate_project_feed_posts_upd on project_feed_posts;
create trigger trg_moderate_project_feed_posts_upd
  before update of text on project_feed_posts
  for each row execute function public.enforce_content_moderation();

drop trigger if exists trg_moderate_project_chat_messages_ins on project_chat_messages;
create trigger trg_moderate_project_chat_messages_ins
  before insert on project_chat_messages
  for each row execute function public.enforce_content_moderation();

-- Hide flagged content from everyone except its author and the site admin;
-- the project owner also keeps visibility so they can moderate their own team.
drop policy if exists "Public can read posts" on project_posts;
create policy "Public can read posts" on project_posts
  for select using (
    not flagged
    or exists (select 1 from projects where projects.id = project_posts.project_id and projects.owner_id = auth.uid())
    or public.is_site_admin()
  );

drop policy if exists "Team can read feed posts" on project_feed_posts;
create policy "Team can read feed posts" on project_feed_posts
  for select using (
    public.is_project_team_member(project_id)
    and (not flagged or auth.uid() = user_id or public.is_project_owner(project_id) or public.is_site_admin())
  );

drop policy if exists "Team can read chat messages" on project_chat_messages;
create policy "Team can read chat messages" on project_chat_messages
  for select using (
    public.is_project_team_member(project_id)
    and (not flagged or auth.uid() = user_id or public.is_project_owner(project_id) or public.is_site_admin())
  );

-- Lets the site admin review and clear/delete flagged content from admin.html.
-- These are separate, standalone policies (not folded into the ones above)
-- because Postgres OR's multiple permissive policies together — folding the
-- admin check inside the team-membership policy above would still require
-- team membership even for the admin, since that policy ANDs its conditions.
drop policy if exists "Admin can read all posts" on project_posts;
create policy "Admin can read all posts" on project_posts
  for select using (public.is_site_admin());

drop policy if exists "Admin can read all feed posts" on project_feed_posts;
create policy "Admin can read all feed posts" on project_feed_posts
  for select using (public.is_site_admin());

drop policy if exists "Admin can read all chat messages" on project_chat_messages;
create policy "Admin can read all chat messages" on project_chat_messages
  for select using (public.is_site_admin());

drop policy if exists "Admin can update flagged posts" on project_posts;
create policy "Admin can update flagged posts" on project_posts
  for update using (public.is_site_admin());

drop policy if exists "Admin can delete any post" on project_posts;
create policy "Admin can delete any post" on project_posts
  for delete using (public.is_site_admin());

drop policy if exists "Admin can update flagged feed posts" on project_feed_posts;
create policy "Admin can update flagged feed posts" on project_feed_posts
  for update using (public.is_site_admin());

drop policy if exists "Admin can delete any feed post" on project_feed_posts;
create policy "Admin can delete any feed post" on project_feed_posts
  for delete using (public.is_site_admin());

drop policy if exists "Admin can update any chat message" on project_chat_messages;
create policy "Admin can update any chat message" on project_chat_messages
  for update using (public.is_site_admin());

drop policy if exists "Admin can delete any chat message" on project_chat_messages;
create policy "Admin can delete any chat message" on project_chat_messages
  for delete using (public.is_site_admin());
