# Migrations, keys and the Data API

## Migrations

- One new numbered file per change. Never edit a migration that has already run anywhere; fix forward with a new
  file.
- Grants, `enable row level security` and policies go in the **same** migration as the table. A table that exists
  for one deploy without RLS is readable through the API for that whole time.
- `create table if not exists t (…)` does nothing when `t` exists, so columns added to that statement later never
  reach databases that already have the table. Add columns with:
  ```sql
  alter table public.notes add column if not exists pinned boolean not null default false;
  ```
  Use `create index if not exists`, and `drop policy if exists` before re-creating a policy, so a re-run is safe.
- Add a column to an existing table with a default (or nullable), so the running app keeps working until it is
  deployed. Run database migrations **before** deploying the code that needs them.
- End every migration that changes tables, columns, views or functions with:
  ```sql
  notify pgrst, 'reload schema';
  ```
  Otherwise the Data API can answer from a stale schema cache ("column not found" or a missing table) until it
  reloads. (`notify pgrst, 'reload config';` is for configuration changes such as a pre-request function.)
- Destructive steps (`drop table`, `drop column`, type changes) get their own migration, after the code that used
  the old shape is gone, and a backup or a way back.

## Default privileges

On many projects every new table, sequence and function in `public` is granted to `anon`, `authenticated` and
`service_role` automatically. That is why each migration revokes before it grants. To stop the automatic grants for
new objects (check with your project's settings first; it affects helper functions too, which then need explicit
`execute` grants):

```sql
alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated, service_role;
alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated, service_role;
alter default privileges for role postgres in schema public revoke all on functions from anon, authenticated, service_role;
alter default privileges for role postgres revoke execute on functions from public;
```

Test the migrations once with these automatic grants switched on (as many real projects have them), so a missing
revoke shows up in CI and not in production.

## Keys

| Key | Who may hold it | What it does |
|---|---|---|
| Publishable key (legacy: anon key) | the browser, the mobile app | requests run as `anon`, or as `authenticated` with a user's token; RLS applies |
| Secret key (legacy: service-role key) | server code only | runs as `service_role`, which bypasses RLS and storage policies |

- The secret key lives in the server's environment (hosting env vars or a git-ignored local env file), never in a
  variable with a client prefix such as `NEXT_PUBLIC_`, never in client code, a log, a fixture, a commit or a chat.
  Document the variable name in `.env.example` with an empty value.
- A server request made with the secret key but carrying a user's access token runs as that user, under RLS. Do
  not rely on the secret key to bypass RLS in code that forwards user tokens.
- Server code that uses the secret key must do its own authorization: it is outside RLS by design. Prefer running
  server queries as the user (their token) so RLS stays the second wall.
- If a secret key leaked, rotate it at once; deleting the commit does not help.

## Data API surface

- Only schemas listed as exposed in the API settings are reachable. Keep helpers and internal tables in other
  schemas (for example `private`).
- RLS does not cover functions: an exposed function with `execute` granted to `anon` is callable by anyone.
- Rate limits, quotas and extra key checks are not RLS. Use a pre-request function or server routes for them.
