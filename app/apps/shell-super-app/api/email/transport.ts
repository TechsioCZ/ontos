import { DatabaseConfig } from '@app/core-runtime';
import { dispatchEmailBatch } from '@app/email-delivery/dispatcher';
import type { DispatchResult } from '@app/email-delivery/dispatcher';
import { emailDeliverySources } from '@app/email-delivery/contract';
import type { EmailDeliveriesResponse, EmailProviderView } from '@app/email-delivery/contract';
import { listDeliveries } from '@app/email-delivery/deliveries';
import type { DeliveryReadScope } from '@app/email-delivery/deliveries';
import { emailEnvironment, emailTransport } from '@app/email-delivery/transport';
import { PgClient } from '@effect/sql-pg';
import { Effect, Layer, Redacted } from 'effect';
import { Cookies, HttpRouter, HttpServerRequest, HttpServerResponse } from 'effect/http';
import { AuthenticationService } from '../auth/service.ts';

// The composition root owns the request scope, DatabaseConfig and Reactivity dependencies.
export const EmailDatabaseLive = Layer.effect(
  PgClient.PgClient,
  Effect.gen(function* makeEmailDatabase() {
    const config = yield* DatabaseConfig;
    return yield* PgClient.makeClient({ url: Redacted.make(config.connectionString) });
  }),
);

type EmailResponseBody =
  | EmailProviderView
  | EmailDeliveriesResponse
  | DispatchResult
  | {
      readonly error: 'invalid_query' | 'authentication_required' | 'forbidden' | 'unauthorized' | 'email_unavailable';
    };

const json = (body: EmailResponseBody, status = 200, cookies: readonly string[] = []) =>
  HttpServerResponse.json(body, {
    cookies: Cookies.fromSetCookie(cookies),
    headers: { 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8' },
    status,
  });

export const parseDeliveryQuery = (url: URL) => {
  const sourceValue = url.searchParams.get('source');
  const source = emailDeliverySources.find((candidate) => candidate === sourceValue);
  const subjectIds = url.searchParams.getAll('subjectId');
  const subjectNumbers = url.searchParams.getAll('subjectNumber');
  const all = [...subjectIds, ...subjectNumbers];
  if (
    source === undefined ||
    all.length === 0 ||
    all.length > 200 ||
    all.some((value) => value.length === 0 || value.length > 120)
  ) {
    return null;
  }
  const recipient = url.searchParams.get('recipient');
  if (
    recipient !== null &&
    (source !== 'akros-order' ||
      subjectIds.length !== 0 ||
      subjectNumbers.length !== 1 ||
      recipient.length > 254 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(recipient.trim()))
  ) {
    return null;
  }
  return { recipient, source, subjectIds, subjectNumbers };
};

/** No query/body token, no disabled-auth mode. Unconfigured dispatch fails closed. */
export const isDispatchAuthorized = (headers: Headers, secret: Redacted.Redacted | undefined): boolean =>
  secret !== undefined &&
  Redacted.value(secret).trim() !== '' &&
  headers.get('authorization') === `Bearer ${Redacted.value(secret)}`;

const receipts = Effect.fn('EmailTransport.receipts')(function* readReceipts(request: Request) {
  const query = parseDeliveryQuery(new URL(request.url));
  if (query === null) {
    return yield* json({ error: 'invalid_query' }, 400);
  }
  let scope: DeliveryReadScope;
  let cookies: readonly string[] = [];
  if (query.recipient === null) {
    const auth = yield* AuthenticationService;
    const session = yield* auth.resolveShellContext(request.headers);
    cookies = session.setCookieHeaders;
    if (session.state !== 'authenticated') {
      return yield* json({ error: 'authentication_required' }, 401, cookies);
    }
    scope = {
      kind: 'company',
      legalEntityId: session.identity.legalEntityId,
      principalId: session.identity.principalId,
      tenantId: session.identity.tenantId,
    };
  } else {
    scope = { kind: 'buyer', recipient: query.recipient };
  }
  if (
    query.source === 'facility-agenda' &&
    (scope.kind !== 'company' ||
      query.subjectNumbers.length > 0 ||
      query.subjectIds.some((id) => !id.startsWith(`${scope.principalId}:`)))
  ) {
    return yield* json({ error: 'forbidden' }, 403, cookies);
  }
  const deliveries = yield* listDeliveries({ ...query, scope });
  return yield* json({ deliveries }, 200, cookies);
});
const dispatch = (request: Request) => {
  const configuredSecret = emailEnvironment['ONTOS_EMAIL_DISPATCH_SECRET'];
  const secret = configuredSecret === undefined ? undefined : Redacted.make(configuredSecret);
  if (!isDispatchAuthorized(request.headers, secret)) {
    return json({ error: 'unauthorized' }, 401);
  }
  return dispatchEmailBatch.pipe(Effect.flatMap((result) => json(result, result.configured ? 200 : 503)));
};
const route = <E, R>(
  method: 'GET' | 'POST',
  path: `/${string}`,
  handler: (request: Request) => Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
) =>
  HttpRouter.add(method, path, (request) =>
    HttpServerRequest.toWeb(request).pipe(
      Effect.flatMap(handler),
      Effect.matchEffect({
        onFailure: (error) =>
          Effect.logError('Email request failed', error).pipe(
            Effect.andThen(json({ error: 'email_unavailable' }, 503)),
          ),
        onSuccess: Effect.succeed,
      }),
    ),
  );

// Keep provider discovery independent of the database-backed routes at the composition root.
export const EmailProviderTransportLive = route('GET', '/email/provider', () => json(emailTransport.provider));

// Expected failures keep the established 503 body. Defects belong to the outer HTTP error seam.
export const EmailDeliveryTransportLive = Layer.mergeAll(
  route('GET', '/email/deliveries', receipts),
  route('POST', '/email/dispatch', dispatch),
);

export const EmailTransportLive = Layer.mergeAll(EmailProviderTransportLive, EmailDeliveryTransportLive);
