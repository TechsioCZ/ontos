import type { DatabaseConfigError } from '@app/core-runtime';
import type { dispatchEmailBatch } from '@app/email-delivery/dispatcher';
import type { DeliveryReadScope, listDeliveries } from '@app/email-delivery/deliveries';
import { emailEnvironment, emailTransport } from '@app/email-delivery/transport';
import {
  EmailDeliveryReceiptsResponseSchema,
  EmailDeliverySourceSchema,
  EmailProviderViewSchema,
  EmailReceiptsApi,
  EmailReceiptsAuthenticationProblemSchema,
  EmailReceiptsForbiddenProblemSchema,
  EmailReceiptsInvalidProblemSchema,
} from '@app/email-delivery/receipt-api';
import { Context, Effect, Layer, Option, Redacted, Schema } from 'effect';
import { Cookies, HttpEffect, HttpRouter, HttpServerRequest, HttpServerResponse } from 'effect/unstable/http';
import { HttpApiBuilder } from 'effect/unstable/httpapi';
import { withEmailDispatchFailure, withEmailProviderFailure, withEmailReceiptFailure } from './http-error-seam.ts';
import { AuthenticationService } from '../auth/service.ts';

export type EmailDeliveryQuery = Parameters<typeof listDeliveries>[0];
type EmailDeliveryRead = ReturnType<typeof listDeliveries>;

interface EmailDeliveryRequestOperations {
  readonly dispatch: Effect.Effect<
    Effect.Success<typeof dispatchEmailBatch>,
    Effect.Error<typeof dispatchEmailBatch> | DatabaseConfigError
  >;
  readonly list: (
    query: EmailDeliveryQuery,
  ) => Effect.Effect<Effect.Success<EmailDeliveryRead>, Effect.Error<EmailDeliveryRead> | DatabaseConfigError>;
}

/** The application root supplies delivery operations scoped to each request; acquiring the service opens no database pool. */
export class EmailDeliveryRequests extends Context.Service<EmailDeliveryRequests, EmailDeliveryRequestOperations>()(
  '@app/shell-super-app/api/email/transport/EmailDeliveryRequests',
) {}

type ResponseStatus = NonNullable<HttpServerResponse.Options['status']>;

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Json));
const json = Effect.fn('EmailTransport.json')(function* jsonResponse(
  body: Schema.Json,
  status: ResponseStatus = 200,
  cookies: readonly string[] = [],
) {
  const encoded = yield* encodeJson(body);
  return HttpServerResponse.text(encoded, {
    contentType: 'application/json; charset=utf-8',
    cookies: Cookies.fromSetCookie(cookies),
    headers: { 'cache-control': 'no-store' },
    status,
  });
});

export const parseDeliveryQuery = (url: URL) => {
  const source = Option.getOrUndefined(
    Schema.decodeUnknownOption(EmailDeliverySourceSchema)(url.searchParams.get('source')),
  );
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
export const isDispatchAuthorized = (headers: Headers, secret: Redacted.Redacted | undefined): boolean => {
  if (secret === undefined) {
    return false;
  }
  const value = Redacted.value(secret);
  return value.trim() !== '' && headers.get('authorization') === `Bearer ${value}`;
};

const invalidReceiptQuery = EmailReceiptsInvalidProblemSchema.make({
  detail: 'Select bounded delivery subjects from one supported source.',
  error: 'invalid_query',
  status: EmailReceiptsInvalidProblemSchema.fields.status.literal,
  title: 'Invalid email receipt query',
  type: 'https://ontos.dev/problems/email-receipts-invalid',
});
const receiptAuthenticationRequired = EmailReceiptsAuthenticationProblemSchema.make({
  detail: 'An authenticated company session is required.',
  error: 'authentication_required',
  status: EmailReceiptsAuthenticationProblemSchema.fields.status.literal,
  title: 'Email receipt authentication required',
  type: 'https://ontos.dev/problems/email-receipts-authentication',
});
const receiptForbidden = EmailReceiptsForbiddenProblemSchema.make({
  detail: 'These delivery receipts are outside the authenticated scope.',
  error: 'forbidden',
  status: EmailReceiptsForbiddenProblemSchema.fields.status.literal,
  title: 'Email receipt access denied',
  type: 'https://ontos.dev/problems/email-receipts-forbidden',
});

const receipts = Effect.fn('EmailTransport.receipts')(function* receiptsEffect(request: Request) {
  const query = parseDeliveryQuery(new URL(request.url));
  if (query === null) {
    return yield* Effect.fail(invalidReceiptQuery);
  }
  let scope: DeliveryReadScope;
  if (query.recipient === null) {
    const auth = yield* AuthenticationService;
    const session = yield* auth.resolveShellContext(request.headers);
    yield* HttpEffect.appendPreResponseHandler((_request, response) =>
      Effect.succeed(HttpServerResponse.mergeCookies(response, Cookies.fromSetCookie(session.setCookieHeaders))),
    );
    if (session.state !== 'authenticated') {
      return yield* Effect.fail(receiptAuthenticationRequired);
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
    return yield* Effect.fail(receiptForbidden);
  }
  const deliveries = yield* (yield* EmailDeliveryRequests).list({ ...query, scope });
  return yield* Schema.decodeEffect(EmailDeliveryReceiptsResponseSchema)({ deliveries });
});

export const EmailReceiptHandlersLive = HttpApiBuilder.group(EmailReceiptsApi, 'emailReceipts', (handlers) =>
  handlers
    .handle('list', ({ request }) =>
      HttpEffect.appendPreResponseHandler((_request, response) =>
        Effect.succeed(HttpServerResponse.setHeader(response, 'cache-control', 'no-store')),
      ).pipe(Effect.andThen(HttpServerRequest.toWeb(request)), Effect.flatMap(receipts), withEmailReceiptFailure),
    )
    .handle('provider', () =>
      HttpEffect.appendPreResponseHandler((_request, response) =>
        Effect.succeed(HttpServerResponse.setHeader(response, 'cache-control', 'no-store')),
      ).pipe(
        Effect.andThen(emailTransport),
        Effect.flatMap((transport) => Schema.decodeEffect(EmailProviderViewSchema)(transport.provider)),
        withEmailProviderFailure,
      ),
    ),
);
export const EmailReceiptTransportLive = HttpApiBuilder.layer(EmailReceiptsApi);
const dispatch = Effect.fn('EmailTransport.dispatch')(function* dispatch(request: Request) {
  const environment = yield* emailEnvironment;
  const credential = environment.ONTOS_EMAIL_DISPATCH_SECRET;
  if (!isDispatchAuthorized(request.headers, credential)) {
    return yield* json({ error: 'unauthorized' }, 401);
  }
  return yield* EmailDeliveryRequests.pipe(
    Effect.flatMap((requests) => requests.dispatch),
    Effect.flatMap((result) => json({ ...result }, result.configured ? 200 : 503)),
  );
});
const route = <Failure, R>(
  method: 'GET' | 'POST',
  path: `/${string}`,
  handler: (request: Request) => Effect.Effect<HttpServerResponse.HttpServerResponse, Failure, R>,
) =>
  HttpRouter.add(method, path, (request) =>
    HttpServerRequest.toWeb(request).pipe(Effect.flatMap(handler), withEmailDispatchFailure),
  );

export const EmailTransportLive = Layer.mergeAll(EmailReceiptTransportLive, route('POST', '/email/dispatch', dispatch));
