-- Traceability: each requirement can link to use-case nodes and architecture-block nodes
-- (ids come from the project_diagrams JSON). Shape: [{"t":"usecases"|"architecture","id":"n1a2b3c"}]
-- Applied to production on 2026-10-27.
alter table public.project_requirements add column if not exists links jsonb not null default '[]'::jsonb;
alter table public.project_requirements drop constraint if exists project_requirements_links_is_array;
alter table public.project_requirements add constraint project_requirements_links_is_array check (jsonb_typeof(links) = 'array');
