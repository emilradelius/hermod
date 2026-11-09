---
name: nextjs-16
description: Next.js 16 rules for route handlers and config. Use when writing or changing a route handler, page params or searchParams, cookies or headers, proxy.ts or middleware.ts, caching and revalidation, instrumentation, next.config, or when a build or dev server behaves oddly after an upgrade.
---

# Next.js 16: route handlers, request APIs, proxy, caching, config

Next.js 16 changed APIs that most examples on the web, and most training data, still show the old way. The
version installed in the repository is the truth, and it ships its own documentation.

## Procedure: before writing a route handler (or any Next.js code)

1. **Read the bundled docs first.** They are in `node_modules/next/dist/docs/` (since 16.2). Start with
   `01-app/01-getting-started/15-route-handlers.md` and
   `01-app/03-api-reference/03-file-conventions/route.md`, and for anything that looks unfamiliar,
   `01-app/02-guides/upgrading/version-16.md`. Heed deprecation notices. In a monorepo, look in the app's own
   `node_modules`.
2. **Check the version and the caching model.** `node -p "require('next/package.json').version"`, then look for
   `cacheComponents: true` in `next.config.*`. The caching rules differ completely between the two models (see
   [caching](references/caching.md)).
3. **Write the handler** in the shapes in [route handlers](references/route-handlers.md): await `params`,
   `cookies()` and `headers()`; validate the body with zod; return `Response.json(...)` with an explicit status.
4. **Check it**: `next typegen && tsc --noEmit` (generates `RouteContext`, `PageProps` and `LayoutProps`), then the
   repository's own tests and a build.

## Rules

1. **`params` is a Promise**, in route handlers, pages, layouts and image functions. Type the second argument as
   `RouteContext<'/api/notes/[id]'>` and `await ctx.params`. Synchronous access is removed in 16.
2. **`cookies()`, `headers()` and `draftMode()` are async**: `await cookies()`. `headers()` is read-only; set response
   headers on the `Response`. Cookies can be set only in route handlers and server functions, never while a server
   component renders. Pages get `searchParams` as a Promise of a plain object.
3. **Route handler shape.** Named exports per method (`GET POST PUT PATCH DELETE HEAD OPTIONS`) in `app/**/route.ts`,
   never next to a `page.ts` in the same folder. No body parser: `await request.json()`, `request.text()` or
   `request.formData()` (form values are strings). Validate every input. Return `Response.json` or `NextResponse`.
4. **`proxy.ts` replaces `middleware.ts`.** Same features, new file and export name (`proxy`), Node.js runtime only.
   Having both files fails the build. Keep `middleware.ts` only if you need the Edge runtime. Proxy is for redirects,
   rewrites and quick checks, not for authorization on its own: check access again in every route handler and
   server function. See [proxy](references/proxy.md).
5. **Caching in 16.** `fetch` is not cached by default. Without Cache Components, route handlers are dynamic unless
   a `GET` opts in. With `cacheComponents: true`, cache with `'use cache'` plus `cacheLife` in a helper, and remove
   `dynamic`, `revalidate` and `fetchCache` exports (they error). `revalidateTag(tag, profile)` needs its second
   argument (`'max'` or `{ expire: 0 }`).
6. **`redirect()` throws**, so call it outside `try`/`catch` (or rethrow with `unstable_rethrow`).
7. **Do not fetch your own route handlers** from server components or other handlers: call the shared function
   directly. A fetch to your own URL fails at build time and adds a network hop at run time.
8. **`after()`** runs work after the response, bounded by `maxDuration`. Use it for audit lines and cleanup, not for
   work whose failure the caller must see.
9. **Set `maxDuration`** on handlers that call slow services (a model, an external API), and make long jobs stop
   inside it and resume on the next run.
10. **`instrumentation.ts` `register()`** runs once per server instance before requests are served. Keep it fast;
    guard Node-only code with `process.env.NEXT_RUNTIME === 'nodejs'` and a dynamic `import()`.
11. **`serverExternalPackages`** is a top-level config key (not under `experimental`). Native or large server-only
    packages that fail to bundle go there; many common ones are already on the built-in list.
12. **Stale `.next`.** When a build or the dev server shows errors that do not match the code (after a branch switch,
    an upgrade or a config change), stop `next dev` and run `rm -rf .next` before building. CI builds from a clean
    `.next` (it may restore `.next/cache` only).

Details: [config and build](references/config-and-build.md) for instrumentation, config, Turbopack, `.next`, the
`AGENTS.md` block and version requirements.

## Before you call it done

- [ ] You read the matching page in `node_modules/next/dist/docs/` for every API you used.
- [ ] Every `params`, `searchParams`, `cookies()` and `headers()` is awaited; `next typegen && tsc --noEmit` passes.
- [ ] Each handler validates its input, checks the caller, returns explicit statuses, and never leaks an error stack.
- [ ] Nothing in the handler assumes it is cached (or not) without checking the caching model.
- [ ] No `middleware.ts` next to a `proxy.ts`; no auth that lives only in the proxy.
- [ ] A clean build (`rm -rf .next` first) passes.

## Why

Most Next.js bugs after the upgrade to 16 compile in one version and fail in another: a sync `params` access, an
unawaited `cookies()`, an export that is ignored under one caching model and an error under the other. Reading the
installed version's docs and type-checking with generated route types catches them before a user does.
