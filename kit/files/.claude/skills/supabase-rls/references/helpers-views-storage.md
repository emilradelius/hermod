# Helpers, views and storage

## Security definer helpers

A policy that reads another table runs that table's policies too. Two tables whose policies read each other fail
with `42P17 infinite recursion detected in policy`. A `security definer` function runs as its owner, so it can read
the membership table without running its policies again.

```sql
create schema if not exists private;          -- not in the API's exposed schemas
revoke all on schema private from public;

create table public.lists (id uuid primary key default gen_random_uuid(), owner_id uuid not null, title text not null);
create table public.list_members (list_id uuid not null references public.lists (id) on delete cascade,
                                  user_id uuid not null, primary key (list_id, user_id));
create index list_members_user_id_idx on public.list_members (user_id);  -- the primary key only covers list_id

create function private.my_list_ids() returns setof uuid
  language sql stable security definer set search_path = ''
as $$
  select l.id from public.lists l where l.owner_id = (select auth.uid())
  union
  select m.list_id from public.list_members m where m.user_id = (select auth.uid())
$$;
revoke execute on function private.my_list_ids() from public;
grant usage on schema private to authenticated;
grant execute on function private.my_list_ids() to authenticated;

alter table public.lists enable row level security;
alter table public.list_members enable row level security;
revoke all on table public.lists, public.list_members from anon, authenticated;
grant select, insert, update, delete on table public.lists to authenticated;
grant select on table public.list_members to authenticated;

create policy lists_select on public.lists for select to authenticated
  using (id in (select private.my_list_ids()));
create policy lists_insert on public.lists for insert to authenticated
  with check (owner_id = (select auth.uid()));
create policy lists_update on public.lists for update to authenticated
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create policy lists_delete on public.lists for delete to authenticated
  using (owner_id = (select auth.uid()));
create policy list_members_select on public.list_members for select to authenticated
  using (list_id in (select private.my_list_ids()));
```

Rules for every `security definer` function:
- `set search_path = ''` and schema-qualified names inside (`public.lists`, `auth.uid()`). Without a pinned search
  path, a caller can put an object with the same name earlier in the path and run it with the owner's rights.
- Not in an exposed schema: there it can be called over the API with its owner's rights.
- `revoke execute ... from public` (functions are executable by everyone by default), then grant to the roles that
  need it.
- `stable` when it only reads, so it can be used in a policy and evaluated once per statement as
  `(select private.f())`.
- It skips RLS only if its owner may: on Supabase the owner is `postgres`, which can. A table owner also bypasses its
  own table's RLS unless the table is set to `force row level security` (then the helper sees only what its policies
  allow, and can recurse).
- Keep it small and read-only. A definer function that writes is a privileged API: validate every argument and
  check the caller inside it.

RLS does not apply to function bodies run by their definer, and functions are not covered by table grants: decide
`execute` grants for each one.

## Views

A view is run with its owner's rights unless it says otherwise, so a view over a protected table returns every row.

```sql
create view public.my_note_counts with (security_invoker = true) as
  select user_id, count(*) as notes from public.notes group by user_id;
revoke all on public.my_note_counts from anon, authenticated;
grant select on public.my_note_counts to authenticated;
```

`security_invoker` needs Postgres 15 or later (Supabase projects are). On older versions, keep views out of exposed
schemas or revoke them from `anon` and `authenticated`. A materialized view has no RLS at all: keep it server-only.
The check in `checks.md` lists views without `security_invoker`.

## Storage

Files live in `storage.objects` (one row per object, with `bucket_id`, `name` and `owner_id`); access is RLS
policies on that table. These shapes follow the Supabase storage docs; they were not run locally (plain Postgres has
no storage schema), so test them on a local Supabase stack.

```sql
-- a private bucket: each user reads and writes only under a folder named after their id
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('user-files', 'user-files', false, 5242880, array['image/jpeg', 'image/png', 'application/pdf']);

create policy user_files_select on storage.objects for select to authenticated
  using (bucket_id = 'user-files' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy user_files_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'user-files' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy user_files_delete on storage.objects for delete to authenticated
  using (bucket_id = 'user-files' and (storage.foldername(name))[1] = (select auth.uid())::text);
```

- Without policies, nobody can upload. An upload needs an `insert` policy; overwriting (`upsert`) also needs `select`
  and `update`.
- Always scope by `bucket_id`; a policy without it applies to every bucket.
- `public: true` makes every object readable by URL without any policy. Use it only for files meant to be public,
  and still limit `file_size_limit` and `allowed_mime_types`.
- "Anyone may upload" (`to anon`) costs storage and can be abused; add size and type limits, and if something
  processes uploads (thumbnails, a model call), rate-limit that work.
- Server code with the service-role or secret key bypasses storage policies; keep that key server-side.
