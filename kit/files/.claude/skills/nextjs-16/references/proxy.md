# proxy.ts and middleware.ts

In Next.js 16 the `middleware` file convention is deprecated and renamed to `proxy`. Features are the same; only the
file name and the export name change.

| | `proxy.ts` | `middleware.ts` |
|---|---|---|
| Status | current | deprecated (works, with a warning) |
| Export | `export function proxy(request)` or a default export | `export function middleware(request)` |
| Runtime | Node.js only; setting `runtime` throws | Edge (keep it only if you need Edge) |
| Both files present | build and dev server fail | |

Migrate with the codemod `npx @next/codemod@canary middleware-to-proxy .` (review its diff), and rename config flags
(`skipMiddlewareUrlNormalize` is now `skipProxyUrlNormalize`). Do not rename Edge middleware blindly: check it does
not depend on Edge-only behaviour first.

## Shape

```ts
// proxy.ts (project root, or src/ next to app/)
import { NextResponse, type NextRequest } from 'next/server';

export function proxy(request: NextRequest) {
  if (!request.cookies.has('session')) {
    return NextResponse.redirect(new URL('/login', request.url));
  }
  const headers = new Headers(request.headers);
  headers.set('x-pathname', request.nextUrl.pathname);
  return NextResponse.next({ request: { headers } }); // forwards to the app, not to the browser
}

export const config = {
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico|login).*)'], // a static constant
};
```

## Pitfalls

- **Without a matcher, the proxy runs on every request**, including static files and images. Matcher values must be
  static constants (no variables, no function calls).
- **The proxy is not your authorization.** Server functions are POST requests to the page's route; a matcher that
  skips a path also skips its server functions. Check the session and the user's rights again inside every route
  handler and server function. A cookie being present proves nothing about who sent it.
- `NextResponse.next({ headers })` sends those headers to the **browser**. To pass values to the app, use
  `NextResponse.next({ request: { headers } })`.
- No slow work: no database round trips per request, no full session management. One proxy file per project.
- Do not rely on module-level state or globals between requests.
- `fetch` cache options have no effect inside the proxy, and `revalidateTag` cannot run there.
- The order of execution: `next.config` `headers`, then `redirects`, then the proxy, then `beforeFiles` rewrites,
  then file-system routes, then `afterFiles` rewrites, then dynamic routes, then `fallback` rewrites.
- 16.4 documents a second argument, `event: NextFetchEvent`, with `event.waitUntil(promise)`.
- For unit tests there are experimental helpers in `next/experimental/testing/server` (`unstable_doesProxyMatch`,
  `isRewrite`, `getRewrittenUrl`).
