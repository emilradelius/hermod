# Check queries

Run these after every migration, on the throwaway test database and on the real project (read-only queries). Each
was run on Postgres 16 against deliberate mistakes and found them. Replace `'public'` with your list of exposed
schemas if you expose more than one.

## 1. Tables without RLS (must return no rows)

```sql
select n.nspname as schema, c.relname as table_name
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where c.relkind in ('r', 'p') and n.nspname = 'public' and not c.relrowsecurity
order by 1, 2;
```

## 2. Views that run as their owner (must return no rows)

```sql
select n.nspname as schema, c.relname as view_name
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where c.relkind = 'v' and n.nspname = 'public'
  and not exists (select 1 from unnest(coalesce(c.reloptions, '{}')) o
                  where o in ('security_invoker=true', 'security_invoker=on', 'security_invoker=1', 'security_invoker=yes'))
order by 1, 2;
```

Postgres stores the option as written (`security_invoker=on`, `=1`, `=true`), hence the list.

## 3. Risky security definer functions (must return no rows)

Definer functions in an exposed schema, or without a pinned `search_path`:

```sql
select n.nspname as schema, p.proname as function_name, p.proconfig
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where p.prosecdef and n.nspname not in ('pg_catalog', 'information_schema')
  and (n.nspname = 'public'
       or not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) s where s like 'search_path=%'))
order by 1, 2;
```

On a Supabase project this also lists the platform's own schemas (`auth`, `storage`, `extensions` and others);
filter to your schemas (`and n.nspname in ('public', 'private')`).

## 4. What the API roles may do (review the list)

```sql
select c.relname as object, r.role, string_agg(p.priv, ', ' order by p.priv) as privileges
from pg_class c join pg_namespace n on n.oid = c.relnamespace
cross join (values ('anon'), ('authenticated')) r(role)
cross join (values ('select'), ('insert'), ('update'), ('delete'), ('truncate')) p(priv)
where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm')
  and has_table_privilege(r.role, c.oid, p.priv)
group by 1, 2 order by 1, 2;
```

Every line should be something the app needs. `truncate` for an API role is always a mistake.

## 5. RLS on, but no policy

```sql
select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
where c.relkind in ('r', 'p') and n.nspname = 'public' and c.relrowsecurity
  and not exists (select 1 from pg_policies p where p.schemaname = n.nspname and p.tablename = c.relname)
order by 1;
```

These tables are closed to the API. Correct for server-only tables; a bug for tables the app reads from the browser.

## 6. All policies, for review

```sql
select tablename, policyname, cmd, roles, qual as using_expr, with_check
from pg_policies where schemaname = 'public' order by tablename, cmd, policyname;
```

Look for `cmd = 'ALL'`, `roles = {public}` (no `to` clause), `using_expr = 'true'` on tables that are not public,
and update policies whose `with_check` is looser than `using_expr`.

## In CI

Wrap 1 to 3 in a `do` block that raises when a row is found, and run it after the migrations in the throwaway
database:

```sql
do $$ begin
  if exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
             where c.relkind in ('r', 'p') and n.nspname = 'public' and not c.relrowsecurity)
  then raise exception 'a table in public has no RLS'; end if;
end $$;
```
