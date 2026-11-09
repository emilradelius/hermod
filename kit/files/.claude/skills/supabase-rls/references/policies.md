# Policies: the per-table template

## Template: rows owned by one user

```sql
create table public.notes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) default auth.uid(),
  body text not null check (char_length(body) <= 2000),
  created_at timestamptz not null default now()
);
create index notes_user_id_idx on public.notes (user_id);   -- every column a policy filters on

alter table public.notes enable row level security;
revoke all on table public.notes from anon, authenticated;    -- default deny, also against default privileges
grant select, insert, update, delete on table public.notes to authenticated;

create policy notes_select on public.notes for select to authenticated
  using ((select auth.uid()) = user_id);
create policy notes_insert on public.notes for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy notes_update on public.notes for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
create policy notes_delete on public.notes for delete to authenticated
  using ((select auth.uid()) = user_id);

notify pgrst, 'reload schema';
```

## USING and WITH CHECK, per command

| Command | `using` (existing rows) | `with check` (row being written) | When denied |
|---|---|---|---|
| `select` | which rows are returned | n/a | fewer rows, no error |
| `insert` | n/a | the new row must pass | error 42501 |
| `update` | which rows may be changed | the changed row must pass | `using`: zero rows changed, no error; `with check`: 42501 |
| `delete` | which rows may be deleted | n/a | zero rows deleted, no error |

Facts that were checked on Postgres 16:
- An update policy **without** `with check` reuses `using` for the new row. That is safe.
- An update policy with a **looser** `with check` (for example `with check (true)`) lets a user hand their row to
  someone else with `update notes set user_id = '<other id>'`. Write `with check` as strict as `using`.
- When an update's `where` reads columns, the select policy is also applied, which can hide a loose `with check` in a
  quick test. Test with an update that reads no column (see `testing.md`).
- An update needs a matching select policy to find rows at all.
- A missing grant fails with 42501 before any policy runs. If a request that a policy should allow fails, check the
  grants first.

## Roles

- Always name the role: `to authenticated`, `to anon, authenticated`. A policy without `to` applies to every role.
- `anon` = no session. Signed-in users (including Supabase "anonymous users") are `authenticated`.
- `to anon using (true)` makes every row readable by anyone with the public key. Use it only for data that is meant
  to be public.

## Read the caller safely

- `(select auth.uid())` returns the user id from the request's token, or null with no session. The `select`
  wrapper lets Postgres evaluate it once per statement. Use the same wrapper for `auth.jwt()` and helper functions
  whose result does not depend on the row.
- `auth.jwt() -> 'app_metadata'` is set by the server and safe for authorization. `user_metadata` is editable by the
  user: never authorize on it.
- Claims in a token are as old as the token. Removing someone from a team in `app_metadata` takes effect when their
  token is refreshed; a membership table takes effect at once.

## Limits in WITH CHECK need both bounds

A public "anyone may add" table often limits what can be written. A lower bound alone is a loophole:

```sql
create policy reports_insert on public.reports for insert to anon, authenticated
  with check (created_at between now() - interval '1 minute' and now() + interval '1 minute');
```

With only `created_at > now() - interval '1 minute'`, a client can insert rows dated a year ahead (checked). The same
goes for sizes, counts and numeric ranges: bound both ends, or let the database set the value (a default that the
policy then checks, or a column the client has no grant to write).

## Column-level limits

Policies work on rows. To stop a role from writing a column (a status set by the server, a computed field), grant
column lists: `grant insert (body) on public.notes to authenticated;` and give the column a default. Or check it in
the policy, as in `with check (... and reviewed_by is null)`.

## Restrictive policies

Policies are permissive by default: a row passes if any policy for the command passes. `as restrictive` policies must
also pass. Use one for a rule that must hold whatever else is allowed, for example requiring a second factor:

```sql
create policy notes_update_mfa on public.notes as restrictive for update to authenticated
  using ((select auth.jwt() ->> 'aal') = 'aal2');
```
