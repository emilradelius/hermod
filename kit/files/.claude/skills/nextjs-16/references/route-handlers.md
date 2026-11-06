# Route handlers in Next.js 16

Every example here type-checks against the `next` 16.4.1 types. `RouteContext`, `PageProps` and `LayoutProps` are
global helpers that `next dev`, `next build` or `next typegen` generate from your routes; run `next typegen` before
`tsc --noEmit` in CI.

## GET with a dynamic segment

```ts
// app/api/notes/[id]/route.ts
import { z } from 'zod';

const Id = z.uuid();

export async function GET(_request: Request, ctx: RouteContext<'/api/notes/[id]'>) {
  const { id } = await ctx.params; // a Promise in Next 16: always await it
  const parsed = Id.safeParse(id);
  if (!parsed.success) return Response.json({ error: 'bad id' }, { status: 400 });
  const note = await getNote(parsed.data);
  if (!note) return Response.json({ error: 'not found' }, { status: 404 });
  return Response.json(note);
}
```

Catch-all segments give arrays: `app/blog/[...slug]/route.ts` has `params: Promise<{ slug: string[] }>`.

## POST with a session, a validated body and response headers

```ts
// app/api/notes/route.ts
import { cookies, headers } from 'next/headers';
import { z } from 'zod';

const NewNote = z.object({ body: z.string().min(1).max(2000) });

export const maxDuration = 30; // seconds; the platform stops the handler after this

export async function POST(request: Request) {
  const jar = await cookies(); // async in Next 16
  const user = await userFromSession(jar.get('session')?.value);
  if (!user) return Response.json({ error: 'sign in first' }, { status: 401 });

  const ua = (await headers()).get('user-agent'); // read-only; set response headers on the Response
  let input: unknown;
  try {
    input = await request.json();
  } catch {
    return Response.json({ error: 'body must be JSON' }, { status: 400 });
  }
  const parsed = NewNote.safeParse(input);
  if (!parsed.success) return Response.json({ error: 'invalid body', issues: parsed.error.issues }, { status: 400 });

  const note = await createNote(user.id, parsed.data.body);
  return Response.json(note, { status: 201, headers: { 'Cache-Control': 'no-store', 'X-Client': ua ? 'known' : 'unknown' } });
}
```

- The request object works too: `request.cookies.get('x')` on a `NextRequest`, `request.headers.get('x')`.
- Set cookies with `(await cookies()).set(name, value, { httpOnly: true, sameSite: 'lax', secure: true })`. Only
  `path` has a default (`/`), so set the security flags yourself.
- Return errors as small JSON bodies with the right status. Log the details on the server (redacted), never return a
  stack trace or a database message.

## after(), revalidation, redirects

```ts
import { after, NextResponse, type NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { revalidateTag } from 'next/cache';

// after(): work after the response is sent; bounded by maxDuration
export async function POST(request: Request) {
  const payload: unknown = await request.json();
  after(async () => {
    await audit({ kind: 'received', payload });
  });
  return Response.json({ ok: true }, { status: 202 });
}

// revalidateTag needs a second argument in 16
export async function PUT(request: Request) {
  const raw = await request.text();
  if (!verifySignature(request, raw)) return new Response('forbidden', { status: 403 });
  const { tag } = JSON.parse(raw) as { tag: string };
  revalidateTag(tag, { expire: 0 }); // expire now (webhook); 'max' = serve stale while revalidating
  return Response.json({ revalidated: true });
}

// redirect() throws: call it outside try/catch
export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams.get('q') ?? '';
  let target: string | null = null;
  try {
    target = await lookup(q);
  } catch {
    return NextResponse.json({ error: 'lookup failed' }, { status: 502 });
  }
  if (!target) redirect('/search');
  (await cookies()).set('last', q, { httpOnly: true, sameSite: 'lax', secure: true });
  return NextResponse.redirect(new URL(target, request.url));
}
```

- `after()` also runs when the handler throws, calls `notFound()` or redirects. In route handlers you may call
  `cookies()` and `headers()` inside the callback; in server components read them before.
- `revalidateTag(tag)` with one argument is deprecated and a type error. `updateTag()` and `refresh()` work only in
  server actions and throw in route handlers.
- `redirect()` defaults to 307, `permanentRedirect()` to 308. Both throw `NEXT_REDIRECT`; a surrounding `catch`
  swallows the redirect.
- Verify the caller of any webhook or revalidation route (a signature or a secret header compared in constant time).

## Streaming

```ts
export async function PATCH() {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(c) {
      for (let i = 0; i < 3; i++) {
        c.enqueue(enc.encode(`data: ${i}\n\n`));
        await new Promise((r) => setTimeout(r, 200));
      }
      c.close();
    },
  });
  return new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' },
  });
}
```

Proxies (nginx) buffer unless `X-Accel-Buffering: no` is set; compression can delay the first chunk; some browsers
hold the first kilobyte.

## Segment config in route.ts

| Export | Use |
|---|---|
| `maxDuration` | seconds before the platform stops the handler (and its `after()` work) |
| `runtime` | default `'nodejs'`. `'edge'` is deprecated in the 16.4 docs and not allowed with Cache Components |
| `dynamic`, `revalidate`, `fetchCache` | previous caching model only; an error under `cacheComponents` |
| `dynamicParams` | previous model only; a build error under `cacheComponents` (call `notFound()` instead) |
| `preferredRegion` | deprecated in the 16.4 docs |

## Other facts

- Methods not exported get 405. `OPTIONS` is implemented for you (with `Allow`) when you do not export it.
- CORS is per handler through response headers; for many handlers use the proxy or `next.config` `headers()`.
- Handlers may run as short-lived functions: no shared memory between requests, maybe no writable file system,
  timeouts, no WebSockets.
- Static export supports only `GET` handlers with `dynamic = 'force-static'`.
- `request.ip` and `request.geo` were removed in 15; read your host's headers instead.
