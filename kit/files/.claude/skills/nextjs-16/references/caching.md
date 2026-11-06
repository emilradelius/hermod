# Caching in Next.js 16

First find out which model the app uses: look for `cacheComponents: true` in `next.config.*`. New apps made with the
recommended `create-next-app` settings in 16.4 have it on; apps upgraded from 15 usually do not.

## What is the same in both models

- `fetch()` is **not cached** by default. Opt in per request: `cache: 'force-cache'`, `next: { revalidate: 60 }` or
  `next: { tags: ['products'] }`. Conflicting options (`revalidate` with `cache: 'no-store'`) are both ignored. Tags:
  at most 256 characters each, 128 per request.
- `revalidateTag(tag, profile)` takes a required second argument: `'max'` (serve stale while revalidating) or
  `{ expire: 0 }` (expire now, for webhooks). It works in route handlers and server actions. `updateTag(tag)` (read
  your own writes) and `refresh()` work only in server actions.
- `cacheLife` and `cacheTag` are stable: drop the `unstable_` prefix.

## Previous model (no `cacheComponents`)

- Route handlers are dynamic by default. Only `GET` can opt in to caching, for example with
  `export const dynamic = 'force-static'` or `export const revalidate = 60`.
- `force-static` makes `cookies()` and `headers()` return empty values: never combine it with per-user data.
- Other methods are never cached, even next to a cached `GET`.

## Cache Components (`cacheComponents: true`)

```ts
// cacheComponents: true — a GET handler with a cached helper
import { cacheLife, cacheTag } from 'next/cache';

export async function GET() {
  return Response.json(await listProducts());
}

async function listProducts() {
  'use cache';
  cacheLife('hours');
  cacheTag('products');
  return db.query('select id, name from products');
}
```

- A `GET` handler that touches no request data or uncached I/O is **prerendered at build time**. Prerendering stops
  at network requests, database queries, async file reads, `request.url`, `request.headers`, `request.cookies`,
  `request.body`, `cookies()`, `headers()`, `connection()` and non-deterministic calls such as `Math.random()`.
- A `GET` that reads only constants or environment variables can therefore be frozen with build-time values. Call
  `await connection()` (from `next/server`) first when it must run per request. (This follows from the docs; they do
  not state it for route handlers in so many words.)
- `'use cache'` cannot go in the handler body: put it in an async helper, as above. Arguments and return values must
  be serializable (no class instances, functions or `URL` objects).
- `cookies()`, `headers()` and `searchParams` are not allowed inside a cached scope, and the check follows the call
  stack: code can pass `next build` and fail under `next start`. Read them outside and pass plain values in.
- Without `cacheLife`, the default profile applies (stale 5 minutes, revalidate 15 minutes, never expires). Pair
  every `'use cache'` with a `cacheLife`. Built-in profiles: `seconds`, `minutes`, `hours`, `days`, `weeks`, `max`,
  `default`.
- The in-memory cache does not survive across serverless instances or deploys.
- Exports of `dynamic`, `revalidate` or `fetchCache` are errors; `dynamicParams` fails the build.
- 16.4 wants `partialPrefetching: true` next to `cacheComponents` (a warning if unset; an error if set without it).
- Under Cache Components, a handler that reads request data bails out of prerendering by throwing; a surrounding
  `try`/`catch` catches that and logs noise. Keep request reads outside `try`, or rethrow with `unstable_rethrow`.

## Migrating a handler to Cache Components

| Before | After |
|---|---|
| `export const dynamic = 'force-dynamic'` | delete it (dynamic is the default for request data) |
| `export const dynamic = 'force-static'` / `revalidate = n` | `'use cache'` + `cacheLife(...)` in a helper |
| `export const fetchCache = ...` | delete it |
| `export const dynamicParams = false` | delete it; call `notFound()` for unknown params |
