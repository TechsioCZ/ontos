// @rstest-environment node
import { ContextAccess, LegalEntityContext, TrustedPrincipalContextSchema } from '@app/core-runtime';
import type { EmailDeliveryView } from '@app/email-delivery/contract';
import {
  EmailReceiptsAuthenticationProblemSchema,
  EmailReceiptsForbiddenProblemSchema,
  EmailReceiptsInvalidProblemSchema,
  EmailReceiptsUnavailableProblemSchema,
} from '@app/email-delivery/receipt-api';
import { ConfigProvider, Context, Effect, Layer, Option, Redacted, Schema } from 'effect';
import { HttpRouter, HttpServer } from 'effect/unstable/http';
import { ConnectionError, SqlError } from 'effect/unstable/sql/SqlError';
import { describe, expect, it } from 'effect-rstest';
import {
  EmailDeliveryRequests,
  EmailReceiptTransportLive,
  EmailReceiptHandlersLive,
  isDispatchAuthorized,
  parseDeliveryQuery,
} from '../../api/email/transport.ts';
import type { EmailDeliveryQuery } from '../../api/email/transport.ts';
import { AuthenticationService } from '../../api/auth/service.ts';
import type { AuthenticationServiceContract, ShellContextResult } from '../../api/auth/service.ts';
import { makeContextAccessDouble } from '../support/context-access-double.ts';

const query = (parameters: string) => parseDeliveryQuery(new URL(`https://shell.test/email/deliveries?${parameters}`));

const tenantId = '70000000-0000-4000-8000-000000000020';
const legalEntityId = '71000000-0000-4000-8000-000000000024';
const principalId = '72000000-0000-4000-8000-000000000001';
const refreshedCookie = 'ontos-session=refreshed; Path=/; HttpOnly; SameSite=Lax';
const receipt = {
  createdAt: '2026-10-22T06:00:00.000Z',
  event: 'ORDER_CREATED',
  eventAt: '2026-10-22T06:00:00.000Z',
  eventLabel: null,
  sentAt: null,
  source: 'akros-order',
  status: 'SENDING',
  subjectId: 'order-1',
  subjectNumber: 'OBJ-1',
} as const;

const authenticatedSession = Schema.decodeUnknownEffect(TrustedPrincipalContextSchema)({
  authBindingId: '73000000-0000-4000-8000-000000000001',
  authContextRef: 'session:email-receipt-test',
  authMethod: 'session',
  legalEntityId,
  principalId,
  tenantId,
}).pipe(
  Effect.map((principal): ShellContextResult => ({
    availableLegalEntities: [{ legalEntityId, legalName: 'Receipt fixture company' }],
    identity: {
      displayName: 'Receipt fixture staff',
      email: 'staff@example.test',
      legalEntityId,
      legalName: 'Receipt fixture company',
      principalId,
      tenantId,
    },
    principal,
    setCookieHeaders: [refreshedCookie],
    state: 'authenticated',
  })),
  Effect.orDie,
);

const unexpectedAuthentication = () => Effect.die('Unexpected authentication operation in receipt test');
const defaultReceiptConfiguration = { EMAIL_PROVIDER: 'none', SMTP_PORT: '1025' };
const makeReceiptServer = (
  resolve: AuthenticationServiceContract['resolveShellContext'],
  list: (query: EmailDeliveryQuery) => Effect.Effect<readonly EmailDeliveryView[], SqlError>,
  configuration = defaultReceiptConfiguration,
) =>
  Effect.acquireRelease(
    Effect.sync(() =>
      HttpRouter.toWebHandler(
        EmailReceiptTransportLive.pipe(
          Layer.provide(EmailReceiptHandlersLive),
          Layer.provideMerge(
            Layer.mergeAll(
              Layer.succeed(
                ConfigProvider.ConfigProvider,
                ConfigProvider.fromUnknown({
                  EMAIL_TEST_SMTP_HOST: 'none',
                  SMTP_HOST: '127.0.0.1',
                  ...configuration,
                }),
              ),
              Layer.succeed(AuthenticationService, {
                availableTenants: unexpectedAuthentication,
                createFixtureUser: unexpectedAuthentication,
                currentSession: unexpectedAuthentication,
                resolveDocumentContext: unexpectedAuthentication,
                resolveShellContext: resolve,
                resolveTenantContext: unexpectedAuthentication,
                signIn: unexpectedAuthentication,
                signOut: unexpectedAuthentication,
                switchLegalEntity: unexpectedAuthentication,
                switchTenant: unexpectedAuthentication,
                switchToTenantContext: unexpectedAuthentication,
              }),
              Layer.succeed(EmailDeliveryRequests, {
                dispatch: Effect.die('Receipt reads must not dispatch an email'),
                list: (requestQuery) => list(requestQuery).pipe(Effect.map((deliveries) => [...deliveries])),
              }),
              Layer.succeed(ContextAccess, makeContextAccessDouble('allowed')),
              Layer.succeed(LegalEntityContext, {
                listActiveForTenant: unexpectedAuthentication,
                validateSelection: unexpectedAuthentication,
              }),
            ),
          ),
          Layer.provide(HttpServer.layerServices),
        ),
        { disableLogger: true },
      ),
    ),
    (server) => Effect.promise(() => server.dispose()),
  );

const requestReceipts = (server: Effect.Success<ReturnType<typeof makeReceiptServer>>, parameters: string) =>
  Effect.promise(() =>
    server.handler(new Request(`https://shell.test/email/deliveries?${parameters}`), Context.empty()),
  );

describe('email endpoint policy', () => {
  it('accepts staff selectors, but not missing, unbounded, or unknown selectors', () => {
    expect(query('source=rent-reminder&subjectId=reminder-1')?.source).toBe('rent-reminder');
    expect(query('source=rent-reminder')).toBeNull();
    expect(query('source=unknown&subjectId=x')).toBeNull();
    expect(query('source=rent-reminder&subjectId=')).toBeNull();
    const selectors = Array.from({ length: 201 }, (_, index) => `subjectId=${index}`).join('&');
    expect(query(`source=rent-reminder&${selectors}`)).toBeNull();
  });
  it('allows buyer access only for one order number plus the checkout recipient', () => {
    expect(query('source=akros-order&subjectNumber=OBJ-1&recipient=buyer%40real.dev')?.recipient).toBe(
      'buyer@real.dev',
    );
    expect(query('source=akros-order&subjectId=private-id&recipient=buyer%40real.dev')).toBeNull();
    expect(query('source=akros-order&subjectNumber=OBJ-1&subjectNumber=OBJ-2&recipient=buyer%40real.dev')).toBeNull();
    expect(query('source=rent-reminder&subjectNumber=INV-1&recipient=buyer%40real.dev')).toBeNull();
    expect(query('source=facility-agenda&subjectNumber=person&recipient=buyer%40real.dev')).toBeNull();
    expect(query('source=akros-order&subjectNumber=OBJ-1&recipient=not-email')).toBeNull();
  });
  it('fails closed for an absent, empty, or wrong dispatch secret and accepts only the bearer header', () => {
    const headers = new Headers({ authorization: 'Bearer fixture-secret' });
    expect(isDispatchAuthorized(headers, Option.getOrUndefined(Option.none<Redacted.Redacted>()))).toBe(false);
    expect(isDispatchAuthorized(headers, Redacted.make(''))).toBe(false);
    expect(isDispatchAuthorized(headers, Redacted.make('different'))).toBe(false);
    expect(isDispatchAuthorized(new Headers(), Redacted.make('fixture-secret'))).toBe(false);
    expect(isDispatchAuthorized(headers, Redacted.make('fixture-secret'))).toBe(true);
    expect(
      isDispatchAuthorized(new Headers({ authorization: 'fixture-secret' }), Redacted.make('fixture-secret')),
    ).toBe(false);
  });
});

describe('email receipt HTTP boundary', () => {
  it.live('serves public configured and disabled provider status without authentication or ledger access', () =>
    Effect.gen(function* publicEmailProvider() {
      for (const configured of [false, true]) {
        let authenticationCalls = 0;
        let databaseCalls = 0;
        const server = yield* makeReceiptServer(
          () =>
            Effect.sync(() => {
              authenticationCalls += 1;
              return { setCookieHeaders: [], state: 'anonymous' } as const;
            }),
          () =>
            Effect.sync(() => {
              databaseCalls += 1;
              return [];
            }),
          { EMAIL_PROVIDER: configured ? 'smtp' : 'none', SMTP_PORT: '1025' },
        );
        const response = yield* Effect.promise(() =>
          server.handler(new Request('https://shell.test/email/provider'), Context.empty()),
        );
        expect(response.status).toBe(200);
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect(yield* Effect.promise(() => response.json())).toEqual({
          configured,
          label: configured ? 'SMTP server 127.0.0.1:1025 (Mailpit)' : null,
        });
        expect(authenticationCalls).toBe(0);
        expect(databaseCalls).toBe(0);
      }
    }),
  );

  it.live('retains a declared unavailable provider category when configuration cannot be decoded', () =>
    Effect.gen(function* invalidProviderConfiguration() {
      const server = yield* makeReceiptServer(unexpectedAuthentication, unexpectedAuthentication, {
        EMAIL_PROVIDER: 'smtp',
        SMTP_PORT: 'invalid-port',
      });
      const response = yield* Effect.promise(() =>
        server.handler(new Request('https://shell.test/email/provider'), Context.empty()),
      );
      expect(response.status).toBe(503);
      expect(response.headers.get('cache-control')).toBe('no-store');
      const problem = yield* Effect.promise(() => response.json()).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(EmailReceiptsUnavailableProblemSchema)),
      );
      expect(problem.error).toBe('email_unavailable');
      expect(problem.retryable).toBe(true);
    }),
  );

  it.live('keeps invalid queries outside authentication and database acquisition', () =>
    Effect.gen(function* invalidReceiptSelectors() {
      let authenticationCalls = 0;
      let databaseCalls = 0;
      const server = yield* makeReceiptServer(
        () =>
          Effect.sync(() => {
            authenticationCalls += 1;
            return { setCookieHeaders: [], state: 'anonymous' } as const;
          }),
        () =>
          Effect.sync(() => {
            databaseCalls += 1;
            return [];
          }),
      );
      const response = yield* requestReceipts(
        server,
        'source=akros-order&subjectId=order-1&recipient=buyer%40real.dev',
      );
      expect(response.status).toBe(400);
      expect(response.headers.get('cache-control')).toBe('no-store');
      const problem = yield* Effect.promise(() => response.json()).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(EmailReceiptsInvalidProblemSchema)),
      );
      expect(problem.error).toBe('invalid_query');
      expect(authenticationCalls).toBe(0);
      expect(databaseCalls).toBe(0);
    }),
  );

  it.live('forwards refreshed cookies on authentication failure and never reads the ledger', () =>
    Effect.gen(function* anonymousReceiptRead() {
      let databaseCalls = 0;
      const server = yield* makeReceiptServer(
        () => Effect.succeed({ setCookieHeaders: [refreshedCookie], state: 'anonymous' }),
        () =>
          Effect.sync(() => {
            databaseCalls += 1;
            return [];
          }),
      );
      const response = yield* requestReceipts(server, 'source=akros-order&subjectId=order-1');
      expect(response.status).toBe(401);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.getSetCookie()).toEqual([refreshedCookie]);
      expect(response.headers.get('content-type')).toContain('application/problem+json');
      const problem = yield* Effect.promise(() => response.json()).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(EmailReceiptsAuthenticationProblemSchema)),
      );
      expect(problem.error).toBe('authentication_required');
      expect(databaseCalls).toBe(0);
    }),
  );

  it.live('reads only the authenticated company scope and encodes acceptance receipts without private fields', () =>
    Effect.gen(function* companyReceiptRead() {
      const observed: EmailDeliveryQuery[] = [];
      const privateReceipt = {
        ...receipt,
        html: '<p>Private body</p>',
        messageId: 'private-provider-id',
        recipient: 'private@real.dev',
        text: 'Private body',
      };
      const server = yield* makeReceiptServer(
        () => authenticatedSession,
        (selectors) =>
          Effect.sync(() => {
            observed.push(selectors);
            return [privateReceipt];
          }),
      );
      const response = yield* requestReceipts(server, 'source=akros-order&subjectId=order-1');
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.getSetCookie()).toEqual([refreshedCookie]);
      expect(yield* Effect.promise(() => response.json())).toEqual({ deliveries: [receipt] });
      expect(observed).toEqual([
        {
          recipient: null,
          scope: { kind: 'company', legalEntityId, principalId, tenantId },
          source: 'akros-order',
          subjectIds: ['order-1'],
          subjectNumbers: [],
        },
      ]);
    }),
  );

  it.live(
    'uses buyer scope only for the validated recipient and one order number without resolving a staff session',
    () =>
      Effect.gen(function* buyerReceiptRead() {
        let authenticationCalls = 0;
        const observed: EmailDeliveryQuery[] = [];
        const server = yield* makeReceiptServer(
          () =>
            Effect.sync(() => {
              authenticationCalls += 1;
              return { setCookieHeaders: [], state: 'anonymous' } as const;
            }),
          (selectors) =>
            Effect.sync(() => {
              observed.push(selectors);
              return [];
            }),
        );
        const response = yield* requestReceipts(
          server,
          'source=akros-order&subjectNumber=OBJ-1&recipient=buyer%40real.dev',
        );
        expect(response.status).toBe(200);
        expect(observed).toEqual([
          {
            recipient: 'buyer@real.dev',
            scope: { kind: 'buyer', recipient: 'buyer@real.dev' },
            source: 'akros-order',
            subjectIds: [],
            subjectNumbers: ['OBJ-1'],
          },
        ]);
        expect(authenticationCalls).toBe(0);
      }),
  );

  it.live('denies another principal agenda receipts before any ledger read and keeps refreshed cookies', () =>
    Effect.gen(function* anotherPrincipalReceiptRead() {
      let databaseCalls = 0;
      const server = yield* makeReceiptServer(
        () => authenticatedSession,
        () =>
          Effect.sync(() => {
            databaseCalls += 1;
            return [];
          }),
      );
      const response = yield* requestReceipts(server, 'source=facility-agenda&subjectId=another-principal%3Abatch');
      expect(response.status).toBe(403);
      expect(response.headers.getSetCookie()).toEqual([refreshedCookie]);
      const problem = yield* Effect.promise(() => response.json()).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(EmailReceiptsForbiddenProblemSchema)),
      );
      expect(problem.error).toBe('forbidden');
      expect(databaseCalls).toBe(0);
    }),
  );

  it.live('maps a ledger connection failure to the declared unavailable category without exposing its cause', () =>
    Effect.gen(function* unavailableReceiptRead() {
      const server = yield* makeReceiptServer(
        () => authenticatedSession,
        () => Effect.fail(new SqlError({ reason: new ConnectionError({ cause: 'private-database-diagnostic' }) })),
      );
      const response = yield* requestReceipts(server, 'source=akros-order&subjectId=order-1');
      expect(response.status).toBe(503);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.getSetCookie()).toEqual([refreshedCookie]);
      const body = yield* Effect.promise(() => response.text());
      expect(body).not.toContain('private-database-diagnostic');
      const problem = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(EmailReceiptsUnavailableProblemSchema))(
        body,
      );
      expect(problem.error).toBe('email_unavailable');
      expect(problem.retryable).toBe(true);
    }),
  );
});
