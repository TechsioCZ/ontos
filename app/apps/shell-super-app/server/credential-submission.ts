import { credentialSubmissionRedirect, isAuthenticationPath } from '@app/shared-contracts/credential-url';
import { Effect, Option, Predicate } from 'effect';

import type { MiddlewareContext, RequestLog } from './root-routes.ts';

/**
 * Modern's error monitor formats req.url as a plain string, outside Effect's URL redaction.
 * Keep its diagnostics and timing subscribers, but remove this auth request's query before formatting.
 */
const redactAuthenticationRequestLogs = (context: MiddlewareContext, requestUrl: string, url: URL) => {
  const monitors = context.get?.('monitors');
  if (monitors === undefined || !isAuthenticationPath(url.pathname)) {
    return;
  }
  const clean = new URL(url);
  clean.search = '';
  clean.hash = '';
  const redact = (value: string) => value.replaceAll(requestUrl, clean.href);
  const wrap =
    (log: RequestLog): RequestLog =>
    (message, ...args) =>
      log(redact(message), ...args.map((argument) => (Predicate.isString(argument) ? redact(argument) : argument)));
  context.set?.('monitors', {
    ...monitors,
    debug: wrap(monitors.debug),
    error: wrap(monitors.error),
    info: wrap(monitors.info),
    trace: wrap(monitors.trace),
    warn: wrap(monitors.warn),
  });
};

/** Runs before routing or loading the BFF. Native form bodies are deliberately never read. */
export const guardCredentialSubmission = Effect.fn('Shell.guardCredentialSubmission')(function* guardSubmission<
  Failure,
  Requirements,
>(context: MiddlewareContext, next: Effect.Effect<void, Failure, Requirements>) {
  const requestUrl = context.req.raw?.url ?? context.req.url ?? context.req.path;
  const url = new URL(requestUrl, 'https://shell.invalid');
  yield* Effect.sync(() => redactAuthenticationRequestLogs(context, requestUrl, url));
  const location = credentialSubmissionRedirect(url, context.req.method);
  if (location === undefined) {
    return yield* next.pipe(Effect.as(Option.none<Response>()));
  }
  return Option.some(
    new Response(null, {
      headers: { 'cache-control': 'no-store', location, 'referrer-policy': 'no-referrer' },
      status: 303,
    }),
  );
});
