import { Effect } from 'effect';
import { HttpClientError } from 'effect/http';

/** Log classifications only: HTTP objects and schema inputs may contain credentials or identity data. */
export const reportHomeLoaderFailure = (error: { readonly _tag: string }, request: Request) =>
  Effect.suspend(() => {
    if (globalThis.window !== undefined && globalThis.window !== null) {
      return Effect.void;
    }
    const correlationId = request.headers.get('x-correlation-id') ?? 'missing';
    const base = {
      correlationId: /^[\w-]{1,64}$/u.test(correlationId) ? correlationId : 'invalid',
      errorTag: error._tag,
    };
    const annotations = HttpClientError.isHttpClientError(error)
      ? {
          ...base,
          status: 'response' in error.reason ? error.reason.response.status : 'missing',
          transportError: error.reason._tag,
        }
      : base;
    return Effect.logError('Authenticated Shell home loader failed').pipe(Effect.annotateLogs(annotations));
  });
