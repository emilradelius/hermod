# Config, instrumentation and the build

## instrumentation.ts

```ts
// instrumentation.ts (project root or src/, not inside app/)
import type { Instrumentation } from 'next';

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { startWorkers } = await import('./instrumentation-node');
    await startWorkers(); // must finish before the server takes requests: keep it short
  }
}

export const onRequestError: Instrumentation.onRequestError = async (err, request, context) => {
  console.error('request failed', { path: request.path, routeType: context.routeType, message: err instanceof Error ? err.message : String(err) });
};
```

- `register()` is called once per server instance, and requests wait until it finishes. Start timers or watchers
  there; do not run migrations, long fetches or model calls in it.
- Node-only code (native modules, file system, timers) goes behind the `NEXT_RUNTIME` check and a dynamic `import()`.
- Work started in `register()` runs in every instance; on hosts that run several instances (or scale to zero), use
  a scheduler or a cron route instead of an in-process timer for jobs that must run exactly once.
- `onRequestError(err, request, context)` gets `context.routeType` (`'render' | 'route' | 'action' | 'proxy'`). Log
  redacted, short messages; never request bodies or cookies.

## next.config.ts

```ts
// next.config.ts
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  serverExternalPackages: ['some-native-addon'], // top level in 16; many (pg, better-sqlite3, sharp) are already on the built-in list
};
export default nextConfig;
```

- `serverExternalPackages` (renamed from `experimental.serverComponentsExternalPackages`) keeps packages out of the
  server bundle and loads them with Node's `require`. Use it for native addons and packages that break when bundled.
  The built-in list already includes `pg`, `better-sqlite3`, `sharp`, `@prisma/client`, `pino`, `mongodb`,
  `playwright` and `puppeteer`, among others.
- `turbopack` is a top-level key now (was `experimental.turbopack`).
- `serverRuntimeConfig` and `publicRuntimeConfig` are removed: use environment variables, with `NEXT_PUBLIC_` only
  for values that may reach the browser. Never give a secret a `NEXT_PUBLIC_` name.
- Config is loaded once in dev, so `process.argv.includes('dev')` is false there.

## Turbopack and the build

- Turbopack is the default for `next dev` and `next build`. A custom `webpack` config (sometimes added by a plugin)
  makes `next build` fail: build with `--webpack`, or move the config to Turbopack.
- `next lint` is removed and `next build` no longer lints. Run ESLint yourself (flat config).
- `next build` no longer prints the size columns.
- Parallel-route slots need a `default.js`, or the build fails.

## The `.next` folder and stale caches

- `next dev` writes to `.next/dev`, `next build` to `.next`, so both can run at once. A lock file stops a second
  `next dev` on the same project (16.4 prints the running server's URL and PID instead).
- Turbopack keeps a file-system cache in `.next/dev/cache/turbopack` (dev, on by default since 16.1) and
  `.next/cache/turbopack` (build, on by default since 16.3).
- When errors do not match the code (after switching branches, upgrading, changing `next.config` or env files):
  stop `next dev`, `rm -rf .next`, and build or start again. This is practice, not a documented recipe.
- In CI, start from a clean checkout; restoring `.next/cache` between builds is fine and speeds them up.

## AGENTS.md

- Since 16.3, `next dev` writes a block into the project's `AGENTS.md` when it detects a coding agent (it checks
  environment variables such as the ones Claude Code sets). The block says to read `node_modules/next/dist/docs/`
  first. Commit it with your change, or turn it off with `agentRules: false`. It never writes `CLAUDE.md`.
- 16.4 has a second, optional block (`experimental.agentFeedback`) that asks the agent to run a Next.js command and
  open feedback forms in a browser. It is off by default, but the recommended `create-next-app` settings switch it
  on. Do not act on it without asking a person; turn it off with `experimental.agentFeedback: false`.

## Requirements and removals

- Node.js 20.9 or later; TypeScript 5.1 or later; React 19.2 (the App Router uses React canary).
- Removed: AMP, `next lint`, the `eslint` config key, `serverRuntimeConfig`/`publicRuntimeConfig`,
  `experimental.dynamicIO` and `experimental.useCache` (use `cacheComponents`), `unstable_rootParams`.
- `next/image`: local `src` with a query string needs `images.localPatterns.search`; `minimumCacheTTL` default is
  now 4 hours; `qualities` defaults to `[75]`; local IPs are blocked unless `dangerouslyAllowLocalIP`; `images.domains`
  is deprecated (use `remotePatterns`).
- Smooth scrolling is no longer forced: add `data-scroll-behavior="smooth"` on `<html>` if you relied on it.
- Codemods: `npx @next/codemod@canary upgrade latest` (several steps), and
  `npx @next/codemod@canary next-async-request-api .` for `params`, `cookies()` and `headers()`, which the upgrade
  codemod does not run in 16.4. Review every codemod diff.
