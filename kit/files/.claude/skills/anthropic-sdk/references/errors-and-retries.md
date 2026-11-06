# Errors and retries

## What the SDK already does

- Retries 408, 409, 429 and every 5xx (529 included) and connection errors, `maxRetries` times (default 2), with
  exponential backoff (0.5 s doubling, capped at 8 s, jitter) or the server's `retry-after`.
- Does not retry other 4xx.
- Default timeout 10 minutes.

So your code sees an error only after those retries are used up. Do not wrap calls in a second blind retry loop:
it multiplies cost and load. Classify the error once and act.

## The error chain

Every HTTP error is an `Anthropic.APIError` with `status`, `type`, `headers` and `requestID`. Subclasses by status:
400 `BadRequestError`, 401 `AuthenticationError`, 403 `PermissionDeniedError`, 404 `NotFoundError`, 409
`ConflictError`, 422 `UnprocessableEntityError`, 429 `RateLimitError`, 5xx `InternalServerError`. Other statuses
(402, 408, 413) are a plain `APIError`. `APIUserAbortError`, `APIConnectionError` and its subclass
`APIConnectionTimeoutError` also extend `APIError`, so test them first. There is no `OverloadedError` class in 1.1.0:
an overload is `InternalServerError` with `status === 529` or `type === 'overloaded_error'`.

```ts
import Anthropic from '@anthropic-ai/sdk';

export type ErrorAction = 'retry_later' | 'other_model' | 'shrink_context' | 'stop';

// Call this only after the SDK's own retries are used up (maxRetries, default 2).
// Order matters: the abort and connection classes extend APIError, so test them first.
export function classify(err: unknown): ErrorAction {
  if (err instanceof Anthropic.APIUserAbortError) return 'stop';
  if (err instanceof Anthropic.APIConnectionTimeoutError) return 'retry_later';
  if (err instanceof Anthropic.APIConnectionError) return 'retry_later';
  if (err instanceof Anthropic.RateLimitError) return 'retry_later';
  if (err instanceof Anthropic.InternalServerError) {
    return err.status === 529 || err.type === 'overloaded_error' ? 'other_model' : 'retry_later';
  }
  if (err instanceof Anthropic.AuthenticationError) return 'stop'; // key missing or wrong: fix the environment
  if (err instanceof Anthropic.PermissionDeniedError) return 'stop';
  if (err instanceof Anthropic.NotFoundError) return 'stop'; // bad model id or no access
  if (err instanceof Anthropic.BadRequestError) return 'stop'; // a bug in the request; read err.type, not the message
  if (err instanceof Anthropic.APIError) {
    if (err.status === 413) return 'shrink_context'; // request body too large
    return 'stop'; // 402 billing, 422 and the rest
  }
  return 'stop';
}

// Construct the client with explicit retry and timeout settings so the behaviour is visible in code.
export const client = new Anthropic({ maxRetries: 2, timeout: 10 * 60 * 1000 });
```

## What each action means

| Action | Do |
|---|---|
| `retry_later` | A background job: leave the work queued for the next run (with a growing delay and a maximum attempt count). An interactive request: show "try again shortly". Never loop forever on the same item. |
| `other_model` | Overloaded. Optionally retry once on another model (it starts with a cold cache and without Opus thinking blocks), else treat as `retry_later`. |
| `shrink_context` | Make the request smaller: fewer documents or images, a summary instead of full history. |
| `stop` | A bug or a configuration problem. Fail the call, log `status`, `type` and `requestID` (never the body or the key), and surface it. Retrying the same body cannot help. |

Not errors, but `stop_reason` values to handle in the same place: `refusal` (see `refusals-and-fallbacks.md`),
`max_tokens` (raise `max_tokens` or shorten; never run a truncated tool call), `model_context_window_exceeded`
(shrink the context), `pause_turn` (send again).

Never match on error message text: it can change between versions. Use the class, `status` and `type`.

A 400 that says a thinking block signature is invalid means earlier turns were edited. Fix the code so history is
append-only; retrying the same body fails the same way.
