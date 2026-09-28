-- Spark — online edition schema.
--
-- Run this once in the SQL editor of your Supabase project (or any Postgres with PostgREST
-- in front of it). Everything the app needs is created here: profiles, contacts, groups,
-- shared ideas, discussion messages and shared to-dos, plus the row-level security rules
-- that keep one user's data away from everyone else's.
--
-- The app talks to this over plain REST with the anon key, so RLS is the only thing
-- standing between users. Do not disable it.
--
-- Two conventions worth knowing before editing:
--   * Every user-owned column references public.profiles(id), never auth.users(id)
--     directly. PostgREST can only follow foreign keys it can see, and the client asks
--     for embedded rows like `contact:contact_id(email,display_name)`. Pointing at
--     auth.users would make those embeds fail. profiles.id cascades from auth.users, so
--     deleting an account still cleans everything up.
--   * A "share" is its own row, not the idea itself. That is what lets the same idea go
--     to two different groups and have two independent discussions.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------- profiles

-- Mirrors auth.users so the app can show a name and look people up by email.
create table if not exists public.profiles (
  id           uuid primary key references auth.users on delete cascade,
  email        text unique,
  display_name text,
  created_at   timestamptz not null default now()
);

-- Keep profiles in step with signups.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email, display_name)
  values (new.id, new.email, split_part(coalesce(new.email, 'spark'), '@', 1))
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------- contacts

-- A one-way address book entry. Adding someone does not need their consent, but it also
-- grants no access to anything until you share something with them.
create table if not exists public.contacts (
  id         uuid primary key default gen_random_uuid(),
  owner_id   uuid not null references public.profiles(id) on delete cascade,
  contact_id uuid not null references public.profiles(id) on delete cascade,
  alias      text,
  created_at timestamptz not null default now(),
  unique (owner_id, contact_id),
  check (owner_id <> contact_id)
);

-- Look someone up by email when adding them. Security definer so the caller can resolve an
-- email to an id without being able to read the whole profiles table.
create or replace function public.find_profile_by_email(candidate text)
returns table (id uuid, email text, display_name text)
language sql
security definer set search_path = public
stable
as $$
  select p.id, p.email, p.display_name
  from public.profiles p
  where lower(p.email) = lower(trim(candidate))
  limit 1;
$$;

-- ---------------------------------------------------------------- groups

create table if not exists public.groups (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (length(trim(name)) > 0),
  owner_id   uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.group_members (
  group_id  uuid not null references public.groups on delete cascade,
  member_id uuid not null references public.profiles(id) on delete cascade,
  role      text not null default 'member' check (role in ('owner', 'member')),
  joined_at timestamptz not null default now(),
  primary key (group_id, member_id)
);

-- Membership checks run inside RLS policies on nearly every table, so they must not
-- themselves be subject to RLS or the policies would recurse. Hence security definer.
create or replace function public.is_member(gid uuid)
returns boolean
language sql
security definer set search_path = public
stable
as $$
  select exists (
    select 1 from public.group_members m
    where m.group_id = gid and m.member_id = auth.uid()
  );
$$;

-- Creating a group also makes you its owner member, atomically.
create or replace function public.create_group(group_name text)
returns public.groups
language plpgsql
security definer set search_path = public
as $$
declare
  g public.groups;
begin
  if auth.uid() is null then
    raise exception 'not signed in';
  end if;
  insert into public.groups (name, owner_id)
  values (trim(group_name), auth.uid())
  returning * into g;

  insert into public.group_members (group_id, member_id, role)
  values (g.id, auth.uid(), 'owner');

  return g;
end;
$$;

-- Adding a member is restricted to the group owner.
create or replace function public.add_group_member(gid uuid, who uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  if not exists (
    select 1 from public.groups g where g.id = gid and g.owner_id = auth.uid()
  ) then
    raise exception 'only the group owner can add members';
  end if;
  insert into public.group_members (group_id, member_id, role)
  values (gid, who, 'member')
  on conflict do nothing;
end;
$$;

-- ---------------------------------------------------------------- shared ideas

-- One row per (idea, group). The row id — not the local idea id — is what the discussion
-- hangs off, so the same idea can live in two groups with two separate threads.
-- Nothing here carries the audio; only text leaves the device.
create table if not exists public.shared_ideas (
  id          uuid primary key default gen_random_uuid(),
  source_id   uuid not null,
  group_id    uuid not null references public.groups on delete cascade,
  author_id   uuid not null references public.profiles(id) on delete cascade,
  title       text,
  note        text,
  keywords    text[] default '{}',
  duration_ms integer,
  recorded_at timestamptz,
  lat         double precision,
  lon         double precision,
  shared_at   timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (source_id, group_id)
);

create index if not exists shared_ideas_group_idx on public.shared_ideas (group_id, shared_at desc);

-- ---------------------------------------------------------------- discussion

create table if not exists public.messages (
  id         uuid primary key default gen_random_uuid(),
  share_id   uuid not null references public.shared_ideas on delete cascade,
  group_id   uuid not null references public.groups on delete cascade,
  author_id  uuid not null references public.profiles(id) on delete cascade,
  body       text not null,
  -- 'text' is free discussion, 'command' is a slash command that already took effect.
  kind       text not null default 'text' check (kind in ('text', 'command')),
  command    text,
  payload    jsonb,
  created_at timestamptz not null default now()
);

create index if not exists messages_share_idx on public.messages (share_id, created_at);

create table if not exists public.shared_todos (
  id          uuid primary key default gen_random_uuid(),
  share_id    uuid references public.shared_ideas on delete cascade,
  group_id    uuid not null references public.groups on delete cascade,
  text        text not null,
  due         text,
  done        boolean not null default false,
  done_at     timestamptz,
  assignee_id uuid references public.profiles(id) on delete set null,
  created_by  uuid not null references public.profiles(id) on delete cascade,
  created_at  timestamptz not null default now()
);

create index if not exists shared_todos_group_idx on public.shared_todos (group_id, done, created_at desc);

-- ---------------------------------------------------------------- row level security

alter table public.profiles      enable row level security;
alter table public.contacts      enable row level security;
alter table public.groups        enable row level security;
alter table public.group_members enable row level security;
alter table public.shared_ideas  enable row level security;
alter table public.messages      enable row level security;
alter table public.shared_todos  enable row level security;

-- profiles: you can read your own row, the rows of people you have added, and the rows of
-- people who share a group with you. Everyone else stays invisible.
drop policy if exists profiles_read on public.profiles;
create policy profiles_read on public.profiles for select
  using (
    id = auth.uid()
    or exists (select 1 from public.contacts c where c.owner_id = auth.uid() and c.contact_id = profiles.id)
    or exists (
      select 1 from public.group_members mine
      join public.group_members theirs on theirs.group_id = mine.group_id
      where mine.member_id = auth.uid() and theirs.member_id = profiles.id
    )
  );

drop policy if exists profiles_write_self on public.profiles;
create policy profiles_write_self on public.profiles for update
  using (id = auth.uid()) with check (id = auth.uid());

-- contacts: strictly private to the owner.
drop policy if exists contacts_own on public.contacts;
create policy contacts_own on public.contacts for all
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());

-- groups: visible to members, editable by the owner.
drop policy if exists groups_read on public.groups;
create policy groups_read on public.groups for select
  using (public.is_member(id));

drop policy if exists groups_write on public.groups;
create policy groups_write on public.groups for all
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());

-- group_members: members can see the roster; only the owner may change it.
drop policy if exists group_members_read on public.group_members;
create policy group_members_read on public.group_members for select
  using (public.is_member(group_id));

drop policy if exists group_members_write on public.group_members;
create policy group_members_write on public.group_members for all
  using (exists (select 1 from public.groups g where g.id = group_id and g.owner_id = auth.uid()))
  with check (exists (select 1 from public.groups g where g.id = group_id and g.owner_id = auth.uid()));

-- shared ideas: any member reads, the author writes.
drop policy if exists shared_ideas_read on public.shared_ideas;
create policy shared_ideas_read on public.shared_ideas for select
  using (public.is_member(group_id));

drop policy if exists shared_ideas_insert on public.shared_ideas;
create policy shared_ideas_insert on public.shared_ideas for insert
  with check (author_id = auth.uid() and public.is_member(group_id));

drop policy if exists shared_ideas_modify on public.shared_ideas;
create policy shared_ideas_modify on public.shared_ideas for update
  using (author_id = auth.uid()) with check (author_id = auth.uid());

drop policy if exists shared_ideas_remove on public.shared_ideas;
create policy shared_ideas_remove on public.shared_ideas for delete
  using (author_id = auth.uid());

-- messages: members read and post; you may only retract your own.
drop policy if exists messages_read on public.messages;
create policy messages_read on public.messages for select
  using (public.is_member(group_id));

drop policy if exists messages_insert on public.messages;
create policy messages_insert on public.messages for insert
  with check (author_id = auth.uid() and public.is_member(group_id));

drop policy if exists messages_remove on public.messages;
create policy messages_remove on public.messages for delete
  using (author_id = auth.uid());

-- shared todos: members read and create; any member may tick one off.
drop policy if exists shared_todos_read on public.shared_todos;
create policy shared_todos_read on public.shared_todos for select
  using (public.is_member(group_id));

drop policy if exists shared_todos_insert on public.shared_todos;
create policy shared_todos_insert on public.shared_todos for insert
  with check (created_by = auth.uid() and public.is_member(group_id));

drop policy if exists shared_todos_modify on public.shared_todos;
create policy shared_todos_modify on public.shared_todos for update
  using (public.is_member(group_id)) with check (public.is_member(group_id));

drop policy if exists shared_todos_remove on public.shared_todos;
create policy shared_todos_remove on public.shared_todos for delete
  using (created_by = auth.uid() or public.is_member(group_id));

-- ---------------------------------------------------------------- realtime

-- Lets other members' messages appear without polling. Harmless if realtime is not enabled.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      alter publication supabase_realtime add table public.messages;
    exception when duplicate_object then null;
    end;
    begin
      alter publication supabase_realtime add table public.shared_todos;
    exception when duplicate_object then null;
    end;
  end if;
end;
$$;
