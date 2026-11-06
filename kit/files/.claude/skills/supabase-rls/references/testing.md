# Testing policies

## Where and as whom

- **A throwaway database only**: a local Supabase stack (`supabase start`, then `supabase test db` for pgTAP files
  under `supabase/tests/`), or a disposable Postgres in CI. Never a real project.
- **As a non-superuser.** Superusers and roles with `bypassrls` skip RLS, and a table's owner skips its own table's
  policies. Apply the migrations as an owner that is not a superuser (like Supabase's `postgres`), then switch to the
  API roles for the assertions.
- **Plain Postgres** has no Supabase roles or `auth` schema. Create them first (below). Then the same migration files
  and tests run in CI with no Supabase account and no secrets.

## Plain-Postgres setup (CI or local)

Run as a superuser of the throwaway server:

```sql
create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;
create role app_owner login password 'app_owner' nosuperuser createrole;
grant anon, authenticated to app_owner;               -- so the owner can switch to them
create database app_test owner app_owner;
```

Then, in `app_test`, a stand-in for what Supabase provides (same behaviour as `auth.uid()` there):

```sql
create schema auth;
create table auth.users (id uuid primary key, email text);
create function auth.uid() returns uuid language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
                  (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid
$$;
create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;
grant usage on schema auth to anon, authenticated, app_owner;
grant execute on function auth.uid(), auth.jwt() to anon, authenticated;
grant select, insert, references on auth.users to app_owner;
```

Apply the migrations as `app_owner`, run the checks in `checks.md`, then the tests.

## A test file (plain SQL; every check raises on failure)

```sql
\set ON_ERROR_STOP on
begin;
-- synthetic data, written as the owner
insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'a@example.com'),
  ('22222222-2222-2222-2222-222222222222', 'b@example.com');
insert into public.notes (id, user_id, body) values
  ('aaaaaaaa-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'note of a');

-- anon has no grant: fails before any policy (42501)
set local role anon;
do $$ begin
  perform 1 from public.notes;
  raise exception 'FAIL anon read notes';
exception when insufficient_privilege then raise notice 'PASS anon cannot read notes';
end $$;
reset role;

-- the owner
set local role authenticated;
set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';
do $$ declare n int; begin
  if (select count(*) from public.notes) <> 1 then raise exception 'FAIL a should see 1 note'; end if;
  update public.notes set body = 'edited' where id = 'aaaaaaaa-0000-0000-0000-000000000001';
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'FAIL a could not update own note'; end if;
  raise notice 'PASS owner reads and updates own note';
end $$;

-- another signed-in user
set local request.jwt.claims = '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}';
do $$ declare n int; begin
  if (select count(*) from public.notes) <> 0 then raise exception 'FAIL b sees a''s note'; end if;
  update public.notes set body = 'stolen';            -- USING filters: no error, zero rows
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL b updated a''s note'; end if;
  delete from public.notes;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL b deleted a''s note'; end if;
  begin                                                -- WITH CHECK violation: raises 42501
    insert into public.notes (user_id, body) values ('11111111-1111-1111-1111-111111111111', 'forged');
    raise exception 'FAIL b inserted a row owned by a';
  exception when insufficient_privilege then null; end;
  raise notice 'PASS stranger: no read, zero-row update and delete, forged insert refused';
end $$;

-- B owns a row and tries to hand it to A. The update reads no column, so only WITH CHECK can stop it.
insert into public.notes (body) values ('note of b');  -- user_id defaults to auth.uid()
do $$ begin
  update public.notes set user_id = '11111111-1111-1111-1111-111111111111';
  raise exception 'FAIL b gave a row away (WITH CHECK too loose)';
exception when insufficient_privilege then raise notice 'PASS WITH CHECK stops handing a row to someone else';
end $$;

-- no session at all
set local request.jwt.claims = '';
do $$ begin
  if (select count(*) from public.notes) <> 0 then raise exception 'FAIL no session sees rows'; end if;
  raise notice 'PASS no session sees nothing';
end $$;
rollback;
```

Run it with `psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f tests/notes_rls_test.sql`. Everything runs in one
transaction that is rolled back, so the file can run again.

## What to assert, and how

| Denied by | What Postgres does | Assert |
|---|---|---|
| a missing grant | raises 42501 (`insufficient_privilege`) | catch it; fail if no error |
| a `with check` violation | raises 42501 | catch it; fail if no error |
| a `using` filter | no error, zero rows | `get diagnostics n = row_count` is 0, and the target row is unchanged |

- Never prove an allowed write by "no error": an update that matched zero rows also raises nothing. Check
  `row_count` (or `returning`) and read the row back.
- Pair each denied write with a read (as the owner) showing the row is intact.
- Test one update that reads no column (`set user_id = …` without a `where` on a column): when the `where` reads
  columns, the select policy also applies and can hide a loose `with check`.
- For shared tables add a member who is not the owner (allowed) and a non-member (denied).
- For limits in `with check`, test just inside, just outside and far outside both bounds (a date a year ahead).
- Make sure the tests can fail: break one policy on purpose (for example `using (true)`) and watch the test fail
  before you trust it.

With pgTAP (`supabase test db`), the same cases use `throws_ok(…, '42501')`, `is_empty(…)` and
`results_eq(… returning …)`; `lives_ok` alone is not proof, for the reason above.
