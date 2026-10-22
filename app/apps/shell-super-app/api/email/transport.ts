// @effect-diagnostics *:off
import { DatabaseConfig, DatabaseConfigLive, ContextAccess, LegalEntityContext } from '@app/core-runtime';
import { dispatchEmailBatch } from '@app/email-delivery/dispatcher';
import { emailDeliverySources } from '@app/email-delivery/contract';
import type { EmailDeliverySource } from '@app/email-delivery/contract';
import { listDeliveries } from '@app/email-delivery/deliveries';
import type { DeliveryReadScope } from '@app/email-delivery/deliveries';
import { emailEnvironment, emailTransport } from '@app/email-delivery/transport';
import { PgClient } from '@effect/sql-pg';
import { Effect, Layer, Redacted } from 'effect';
import { Reactivity } from 'effect/unstable/reactivity';
import { HttpRouter, HttpServerRequest, HttpServerResponse } from 'effect/unstable/http';
import { AuthenticationService } from '../auth/service.ts';

// Only email routes acquire this request-owned pool. Workers resolve DATABASE_URL through HYPERDRIVE.
const EmailDatabaseLive = Layer.effect(
  PgClient.PgClient,
  Effect.gen(function* () {
    const config = yield* DatabaseConfig;
    return yield* PgClient.makeClient({ url: Redacted.make(config.connectionString) });
  }),
).pipe(Layer.provide(Layer.mergeAll(DatabaseConfigLive, Reactivity.layer)));

const json = (body: unknown, status = 200, cookies: readonly string[] = []): Response => {
  const headers = new Headers({ 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8' });
  for (const cookie of cookies) headers.append('set-cookie', cookie);
  return new Response(JSON.stringify(body), { headers, status });
};

export const parseDeliveryQuery = (url: URL) => {
  const source = url.searchParams.get('source') ?? '';
  const subjectIds = url.searchParams.getAll('subjectId');
  const subjectNumbers = url.searchParams.getAll('subjectNumber');
  const all = [...subjectIds, ...subjectNumbers];
  if (
    !emailDeliverySources.includes(source as EmailDeliverySource) ||
    all.length === 0 ||
    all.length > 200 ||
    all.some((value) => value.length === 0 || value.length > 120)
  )
    return null;
  const recipient = url.searchParams.get('recipient');
  if (
    recipient !== null &&
    (source !== 'akros-order' ||
      subjectIds.length !== 0 ||
      subjectNumbers.length !== 1 ||
      recipient.length > 254 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(recipient.trim()))
  )
    return null;
  return { source: source as EmailDeliverySource, subjectIds, subjectNumbers, recipient };
};

/** No query/body token, no disabled-auth mode. Unconfigured dispatch fails closed. */
export const isDispatchAuthorized = (headers: Headers, secret: string | undefined): boolean =>
  secret !== undefined && secret.trim() !== '' && headers.get('authorization') === `Bearer ${secret}`;

export const EmailTransportLive = Layer.unwrap(
  Effect.gen(function* () {
    const auth = yield* AuthenticationService;
    const contextAccess = yield* ContextAccess;
    const legalEntityContext = yield* LegalEntityContext;
    const receipts = (request: Request) =>
      Effect.gen(function* () {
        const query = parseDeliveryQuery(new URL(request.url));
        if (query === null) return json({ error: 'invalid_query' }, 400);
        let scope: DeliveryReadScope;
        let cookies: readonly string[] = [];
        if (query.recipient !== null) {
          scope = { kind: 'buyer', recipient: query.recipient };
        } else {
          const session = yield* auth
            .resolveShellContext(request.headers)
            .pipe(
              Effect.provideService(ContextAccess, contextAccess),
              Effect.provideService(LegalEntityContext, legalEntityContext),
            );
          cookies = session.setCookieHeaders;
          if (session.state !== 'authenticated') return json({ error: 'authentication_required' }, 401, cookies);
          scope = {
            kind: 'company',
            legalEntityId: session.identity.legalEntityId,
            principalId: session.identity.principalId,
            tenantId: session.identity.tenantId,
          };
        }
        if (
          query.source === 'facility-agenda' &&
          (scope.kind !== 'company' ||
            query.subjectNumbers.length > 0 ||
            query.subjectIds.some((id) => !id.startsWith(`${scope.principalId}:`)))
        ) {
          return json({ error: 'forbidden' }, 403, cookies);
        }
        const deliveries = yield* listDeliveries({ ...query, scope }).pipe(Effect.provide(EmailDatabaseLive));
        return json({ deliveries }, 200, cookies);
      });
    const dispatch = (request: Request) => {
      if (!isDispatchAuthorized(request.headers, emailEnvironment['ONTOS_EMAIL_DISPATCH_SECRET']))
        return Effect.succeed(json({ error: 'unauthorized' }, 401));
      return dispatchEmailBatch.pipe(
        Effect.provide(EmailDatabaseLive),
        Effect.map((result) => json(result, result.configured ? 200 : 503)),
      );
    };
    const route = (
      method: 'GET' | 'POST',
      path: `/${string}`,
      handler: (request: Request) => Effect.Effect<Response, unknown>,
    ) =>
      HttpRouter.add(method, path, (request) =>
        HttpServerRequest.toWeb(request).pipe(
          Effect.flatMap(handler),
          Effect.catchCause(() => Effect.succeed(json({ error: 'email_unavailable' }, 503))),
          Effect.map((response) =>
            HttpServerResponse.raw(response, { status: response.status, statusText: response.statusText }),
          ),
        ),
      );
    return Layer.mergeAll(
      route('GET', '/email/provider', () => Effect.succeed(json(emailTransport.provider))),
      route('GET', '/email/deliveries', receipts),
      route('POST', '/email/dispatch', dispatch),
    );
  }),
);
