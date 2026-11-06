---
name: supabase-rls
description: Row level security rules for Supabase Postgres. Use when creating or changing a table, view, function, policy, grant, storage bucket or migration in a Supabase project, when a query returns rows it should not (or none at all), when handling Supabase keys, and when reviewing database access.
---

# Supabase row level security

In Supabase the browser can talk to the database directly (the Data API, with the publishable or anon key). So the
database itself must decide who sees and changes which rows. Grants decide whether a role may run an operation on a
table at all; RLS policies decide which rows it applies to. You need both, on every table.

## Rules

1. **RLS on every table** in an exposed schema (normally `public`), in the same migration that creates the table.
   Run the check query in [checks](references/checks.md) after every migration: it must return no rows.
2. **Default deny.** Many projects grant every new table in `public` to `anon` and `authenticated`. After `enable
   row level security`, `revoke all ... from anon, authenticated`, then grant back only what each role needs.
   Policies do not take grants back. A table with RLS on and no policy is closed to the API, which is right for
   server-only tables.
3. **One policy per command** (`select`, `insert`, `update`, `delete`), always with `to <role>`. Avoid `for all`:
   it hides which rule covers which command.
4. **USING vs WITH CHECK.** `using` filters the rows a command can see or touch (no error, just fewer rows).
   `with check` tests the row being written (a violation raises 42501). Insert takes `with check`; update takes
   both, and its `with check` must be as strict as its `using`, or a user can hand a row to someone else.
5. **`(select auth.uid())`**, not bare `auth.uid()`: the wrapped form runs once per statement instead of once per
   row. `auth.uid()` is null without a session, so `auth.uid() = user_id` is never true for `anon`. Index every
   column a policy filters on.
6. **Authorization never comes from `user_metadata`** (`raw_user_meta_data`): the user can change it. Use
   `app_metadata`, a table, or a helper function.
7. **Helpers are `security definer` with `set search_path = ''`**, live in a schema the API does not expose
   (for example `private`), schema-qualify every name, and `revoke execute ... from public` before granting it to
   the roles that need it. Use them to read membership tables and to break recursive policies.
8. **Views use `with (security_invoker = true)`.** A plain view runs as its owner and returns every row its tables'
   policies were meant to hide.
9. **Storage is RLS too.** Access to files is policies on `storage.objects`, scoped by `bucket_id` and usually by
   the first folder of the object name. A public bucket is readable by anyone who has the URL.
10. **The service-role key (or secret key) never reaches a browser.** It bypasses RLS. Server code only, from an
    environment variable that has no `NEXT_PUBLIC_` (or similar client) prefix; never in a client bundle, a log or a
    chat. The publishable (anon) key is the only key a browser gets.
11. **Test policies as a non-superuser in a throwaway database.** Superusers and table owners bypass RLS, so a test
    run as `postgres` proves nothing. Switch to `anon` and `authenticated` with a fake user id, and assert both what
    is allowed and what is denied. Never run tests against a real project.
12. **After DDL, `notify pgrst, 'reload schema';`** so the Data API sees new tables, columns and functions.
13. **`create table if not exists` does not add columns** to a table that already exists. Add them with `alter table
    ... add column if not exists`. Never edit a migration that has already been applied; write a new one.

## Procedure: a new table

1. Write a new numbered migration. Template in [policies](references/policies.md): create table, index the owner
   column, enable RLS, revoke from `anon` and `authenticated`, grant back, one policy per command, `notify pgrst`.
2. If access depends on another table (members, teams, roles), read it through a `security definer` helper in
   `private`, as in [helpers, views and storage](references/helpers-views-storage.md).
3. Views on the table: `security_invoker = true`, and grant them like tables.
4. Files: a bucket plus `storage.objects` policies per command.
5. Write the test (see [testing](references/testing.md)): for `anon`, the owner, another signed-in user, and a member
   if the table is shared. Cover read, insert, update (including handing a row to someone else) and delete, and a
   request with no session.
6. Apply the migrations to a fresh throwaway database as a non-superuser owner, run the checks and the tests, and only
   then apply to the real project. Changes to a schema are in [migrations](references/migrations.md).
7. In the pull request, list the tables, grants and policies you added and how they were tested.

## Before you call it done

- [ ] The "tables without RLS" check returns nothing; so do the view and function checks.
- [ ] `anon` and `authenticated` hold only the grants the app needs (check 4 in `references/checks.md`).
- [ ] Every policy names its role and command; update policies have a `with check` as strict as `using`.
- [ ] Helpers are `security definer`, `search_path = ''`, outside `public`, execute revoked from `public`.
- [ ] Time or quantity limits in `with check` have both bounds (a lower bound alone accepts dates in the future).
- [ ] Tests ran as `anon` and `authenticated` on a throwaway database, with allowed and denied cases.
- [ ] No service-role or secret key in client code, env files with a client prefix, logs or fixtures.
- [ ] `notify pgrst, 'reload schema';` is at the end of the migration.

## Why

RLS failures are silent. A missing policy usually returns an empty list, and a missing revoke or a plain view
returns everyone's rows to anyone with the public key, with nothing in the logs. Only a test that runs as the real API
roles shows the difference, which is why every rule above ends in a check query or a test.
