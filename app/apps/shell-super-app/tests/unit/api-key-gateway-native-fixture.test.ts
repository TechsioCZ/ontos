import { NodeChildProcessSpawner, NodeCrypto, NodeServices, NodeSocket } from '@effect/platform-node';
import { Deferred, Effect, Fiber, FileSystem, Layer, Option, Ref, Result, Schema, Stream } from 'effect';
import { Socket } from 'effect/socket';
import { TestClock } from 'effect/testing';
import { expect, it } from 'effect-rstest';

import type { ShellNativeRequestDiagnosticSchema } from '../fixtures/api-key-gateway-native.ts';
import {
  ApiKeyGatewayNativeFixtureError,
  ShellNativeChildCommandSchema,
  ShellNativeIssueCommandSchema,
  ShellNativeIssuedResponseSchema,
  ShellNativeSessionGatewayCommandSchema,
  ShellNativeSessionGatewayResponseSchema,
  ShellNativeSetupGatewayRequestSchema,
  ShellNativeGatewayDiagnosticsResponseSchema,
  ShellNativeIssuerDiagnosticsResponseSchema,
  ShellNativeRequestDiagnosticsResponseSchema,
  ShellNativeReleaseDiagnosticsResponseSchema,
  ShellNativeChildReadySchema,
  ShellNativeChildResponseSchema,
  ShellNativeRelaySourceSchema,
  ShellNativeAdditionalRelaySourceSchema,
  ShellNativeModuleSourceProvisionCommandSchema,
  decodeShellNativeRegionsEnvironment,
  decodeShellNativePriceReadEnvironment,
  ShellNativeStartupEventSchema,
  ShellNativeSetupKeyIssueCommandSchema,
  ShellNativeSetupKeyIssuedResponseSchema,
  ShellNativeTenantSetupGatewayCommandSchema,
  ShellNativeProvisionedResponseSchema,
  ShellNativeRelaySourceProvisionCommandSchema,
  makeApiKeyGatewayNativeFixture,
  openShellNativePrivateChannel,
  observeShellNativeRequestDispatch,
  describeShellNativeIssuerFailure,
} from '../fixtures/api-key-gateway-native.ts';
import { GatewayIssuerError } from '../../api/auth/gateway-issuer.ts';
import {
  ShellGatewayReleaseObserver,
  ShellGatewayReleaseObservationError,
  withShellGatewayReleaseDiagnostic,
} from '../../api/auth/gateway-release-diagnostic.ts';

const infrastructure = NodeChildProcessSpawner.layer.pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeCrypto.layer),
);
const connection = (database: string, user: string) =>
  Object.freeze({
    connectionString: `postgresql://${user}:fixture@localhost/${database}`,
    database,
    expectedRole: user,
    host: 'localhost',
    port: 5432,
    user,
  });
const credentials = (database: string) => ({
  ownedDatabase: {
    composition: {
      closeAdmission: () => Effect.die('Fixture cannot change composition'),
      drain: () => Effect.die('Fixture cannot change composition'),
      observe: () => Effect.die('Invalid fixture input cannot inspect the owned database'),
      observeRetainedOriginal: () => Effect.die('Invalid fixture input cannot inspect the owned database'),
      publishReplacement: () => Effect.die('Fixture cannot change composition'),
      renewObservation: () => Effect.die('Fixture cannot change composition'),
      seal: () => Effect.die('Fixture cannot change composition'),
    },
    connections: { admin: connection(database, 'administrator'), runtime: connection(database, 'runtime') },
  },
  snapshotJson: '{}',
});

it.layer(infrastructure)('owned Shell native fixture', (suite) => {
  suite.effect('refuses a source database before migration, bundling or client construction', () =>
    Effect.scoped(
      Effect.gen(function* rejectSourceDatabase() {
        const failure = yield* makeApiKeyGatewayNativeFixture(credentials('source_database')).pipe(Effect.flip);
        expect(failure).toBeInstanceOf(ApiKeyGatewayNativeFixtureError);
      }),
    ),
  );
  suite.effect('rejects an invalid immutable snapshot before constructing any owned infrastructure', () =>
    Effect.scoped(
      Effect.gen(function* rejectInvalidComposition() {
        const failure = yield* makeApiKeyGatewayNativeFixture(credentials('ontos_test_party_gateway_component')).pipe(
          Effect.flip,
        );
        expect(failure).toBeInstanceOf(ApiKeyGatewayNativeFixtureError);
      }),
    ),
  );
  suite.effect('carries a closed issue command and private issued credential through a real owned Unix socket', () =>
    Effect.gen(function* realPrivateChannel() {
      const fs = yield* FileSystem.FileSystem;
      const socketPath = yield* Effect.scoped(
        Effect.gen(function* privateExchangeScope() {
          const channel = yield* openShellNativePrivateChannel();
          const socket = yield* NodeSocket.makeNet({ openTimeout: '2 seconds', path: channel.socketPath });
          const peer = yield* Effect.gen(function* privateChildPeer() {
            // This is transport-only; no identity, authorization, key issuance, or gateway outcome is simulated.
            const reader = yield* socket.reader;
            const chunks = yield* reader.pull;
            let input = '';
            for (const chunk of chunks) {
              input += Schema.is(Schema.String)(chunk) ? chunk : new TextDecoder().decode(chunk);
            }
            const command = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ShellNativeChildCommandSchema))(
              input.trim(),
            );
            expect(Schema.is(ShellNativeIssueCommandSchema)(command)).toBe(true);
            const writer = yield* socket.writer;
            const line = yield* Schema.decodeUnknownEffect(ShellNativeChildResponseSchema)({
              _tag: 'issued',
              providerKeyId: '11111111-1111-4111-8111-111111111111',
              secret: 'private-protocol-test-value',
            }).pipe(Effect.flatMap(Schema.encodeEffect(Schema.fromJsonString(ShellNativeChildResponseSchema))));
            yield* writer.write(`${line}\n`);
          }).pipe(Effect.forkChild);
          const response = yield* channel.exchange({
            _tag: 'issue',
            principalId: '22222222-2222-4222-8222-222222222222',
            tenantId: '33333333-3333-4333-8333-333333333333',
          });
          expect(Schema.is(ShellNativeChildResponseSchema)(response)).toBe(true);
          expect(Schema.is(ShellNativeIssuedResponseSchema)(response)).toBe(true);
          yield* Fiber.join(peer);
          yield* channel.close;
          return channel.socketPath;
        }),
      );
      expect(yield* fs.exists(socketPath)).toBe(false);
    }),
  );
  suite.effect('keeps concurrent module exchanges paired with their own private credential responses', () =>
    Effect.scoped(
      Effect.gen(function* serializeModuleCredentialExchanges() {
        const channel = yield* openShellNativePrivateChannel();
        const socket = yield* NodeSocket.makeNet({ openTimeout: '2 seconds', path: channel.socketPath });
        const first = 'privacy';
        const second = 'party-registry';
        const peer = yield* Socket.toStream(socket).pipe(
          Stream.decodeText(),
          Stream.splitLines,
          Stream.take(2),
          Stream.mapEffect(
            (line) =>
              Effect.gen(function* respondToTransportCommand() {
                // Transport-only scheduling deliberately reverses overlapping responses. No credential is issued here.
                const command = yield* Schema.decodeUnknownEffect(
                  Schema.fromJsonString(ShellNativeModuleSourceProvisionCommandSchema),
                )(line);
                if (command.sourceAppId === first) {
                  yield* Effect.yieldNow;
                }
                const response = yield* Schema.decodeUnknownEffect(ShellNativeProvisionedResponseSchema)({
                  _tag: 'provisioned',
                  principalId: '11111111-1111-4111-8111-111111111111',
                  providerKeyId: command.sourceAppId,
                  secret: 'transport-only-private-value',
                }).pipe(
                  Effect.flatMap(Schema.encodeEffect(Schema.fromJsonString(ShellNativeProvisionedResponseSchema))),
                );
                const writer = yield* socket.writer;
                yield* writer.write(`${response}\n`);
              }),
            { concurrency: 2 },
          ),
          Stream.runDrain,
          Effect.forkChild,
        );
        const responses = yield* Effect.forEach(
          [first, second] as const,
          (sourceAppId) => channel.exchange({ _tag: 'module-source-provision', sourceAppId }),
          { concurrency: 2 },
        );
        expect(
          responses.map((response) =>
            Schema.is(ShellNativeProvisionedResponseSchema)(response) ? response.providerKeyId : undefined,
          ),
        ).toEqual([first, second]);
        yield* Fiber.join(peer);
        yield* channel.close;
      }),
    ),
  );
});

it.layer(infrastructure)('private channel disposal', (suite) => {
  suite.effect('refuses a new command after explicit scoped close before waiting for a peer', () =>
    Effect.scoped(
      Effect.gen(function* refuseClosedChannel() {
        const channel = yield* openShellNativePrivateChannel();
        yield* channel.close;
        const failure = yield* channel.exchange({ _tag: 'bound' }).pipe(Effect.flip);
        expect(Schema.is(ApiKeyGatewayNativeFixtureError)(failure)).toBe(true);
      }),
    ),
  );
});

it('keeps the private protocol closed and public readiness separate from issued credentials', () => {
  expect(Schema.is(ShellNativeChildCommandSchema)({ _tag: 'reset' })).toBe(false);
  expect(Schema.is(ShellNativeChildCommandSchema)({ _tag: 'sign', principalId: 'caller-selected' })).toBe(false);
  expect(Schema.is(ShellNativeChildCommandSchema)({ _tag: 'issue', principalId: 'invalid', tenantId: 'invalid' })).toBe(
    false,
  );
  expect(Schema.is(ShellNativeChildResponseSchema)({ _tag: 'issued', providerKeyId: '', secret: 'credential' })).toBe(
    false,
  );
  expect(Schema.is(ShellNativeChildReadySchema)({ _tag: 'issued', providerKeyId: 'key', secret: 'credential' })).toBe(
    false,
  );
});

it('keeps session issuance closed to public gateway inputs without caller identity or cookie injection', () => {
  const request = { audience: 'privacy', compositionRevision: 'a'.repeat(64) };
  const decode = Schema.decodeUnknownResult(ShellNativeSessionGatewayCommandSchema, { onExcessProperty: 'error' });
  expect(Schema.is(ShellNativeSessionGatewayCommandSchema)({ _tag: 'session-gateway', request })).toBe(true);
  for (const command of [
    { _tag: 'session-gateway', request: { ...request, audience: '' } },
    { _tag: 'session-gateway', request: { ...request, compositionRevision: 'invalid' } },
    { _tag: 'session-gateway', request: { ...request, legalEntityId: 'invalid' } },
    { _tag: 'session-gateway', cookie: 'caller-selected', request },
    { _tag: 'session-gateway', request: { ...request, principalId: 'caller-selected' } },
  ]) {
    expect(Result.isFailure(decode(command))).toBe(true);
  }
});

it('keeps session assertion replies private and validates the published gateway result', () => {
  // Codec-only data is never accepted by an authority or advertised as real issuance.
  const response = {
    _tag: 'session-gateway',
    gateway: {
      apiBaseUrl: '/privacy-api',
      compositionRevision: 'a'.repeat(64),
      expiresAt: 1_900_000_000,
      token: 'private-codec-only-token',
    },
  };
  expect(Schema.is(ShellNativeSessionGatewayResponseSchema)(response)).toBe(true);
  expect(Schema.is(ShellNativeChildReadySchema)(response)).toBe(false);
  expect(
    Schema.is(ShellNativeSessionGatewayResponseSchema)({ ...response, gateway: { ...response.gateway, token: '' } }),
  ).toBe(false);
});

it('bounds fixture setup assertions to finite audiences and their declared scope', () => {
  const decode = Schema.decodeUnknownResult(ShellNativeSetupGatewayRequestSchema, { onExcessProperty: 'error' });
  expect(Result.isSuccess(decode({ audience: 'catalog' }))).toBe(true);
  expect(Result.isSuccess(decode({ audience: 'pricing' }))).toBe(true);
  expect(
    Result.isSuccess(
      decode({ audience: 'commerce-market-catalog', legalEntityId: '33333333-3333-4333-8333-333333333333' }),
    ),
  ).toBe(true);
  expect(Result.isSuccess(decode({ audience: 'privacy', legalEntityId: '33333333-3333-4333-8333-333333333333' }))).toBe(
    true,
  );
  for (const audience of ['party-registry', 'commerce-customer-context']) {
    expect(Result.isSuccess(decode({ audience, legalEntityId: '33333333-3333-4333-8333-333333333333' }))).toBe(true);
    expect(Result.isFailure(decode({ audience }))).toBe(true);
    expect(Result.isFailure(decode({ audience, legalEntityId: 'invalid' }))).toBe(true);
    expect(
      Result.isFailure(
        decode({ audience, legalEntityId: '33333333-3333-4333-8333-333333333333', principalId: 'caller-selected' }),
      ),
    ).toBe(true);
  }
  for (const input of [
    { audience: 'privacy' },
    { audience: 'symmy-integration', legalEntityId: '33333333-3333-4333-8333-333333333333' },
    { audience: 'commerce-market-catalog' },
    { audience: 'commerce-market-catalog', legalEntityId: 'invalid' },
    { audience: 'catalog', legalEntityId: '33333333-3333-4333-8333-333333333333' },
    { audience: 'pricing', legalEntityId: '33333333-3333-4333-8333-333333333333' },
    { audience: 'catalog', compositionRevision: 'a'.repeat(64) },
    { audience: 'catalog', principalId: '33333333-3333-4333-8333-333333333333' },
    { audience: 'catalog', cookie: 'caller-selected' },
  ]) {
    expect(Result.isFailure(decode(input))).toBe(true);
  }
});

it.effect('forwards only production-schema-validated Regions configuration in the child environment', () =>
  Effect.gen(function* regionsEnvironment() {
    expect(yield* decodeShellNativeRegionsEnvironment()).toEqual({});
    const tenantId = '11111111-1111-4111-8111-111111111111';
    const region = {
      currencyCode: 'CZK',
      marketRef: {
        moduleId: 'commerce.market-catalog',
        resourceId: '33333333-3333-4333-8333-333333333333',
        resourceType: 'commerce.market-catalog.market',
        tenantId,
      },
      sourceRegionId: 'source-region-a',
    };
    const route = {
      issuerId: 'fixture-source',
      legalEntityId: '22222222-2222-4222-8222-222222222222',
      regions: [region],
      route: { integrationRouteId: 'fixture-regions-route', tenantId },
      sourceNamespace: 'fixture-cz',
    };
    const json = Schema.encodeSync(Schema.fromJsonString(Schema.Json));
    const value = { routes: [route], schemaVersion: 1 };
    const environment = yield* decodeShellNativeRegionsEnvironment(json(value));
    expect(Object.keys(environment)).toEqual(['ONTOS_SYMMY_REGIONS_PROJECTION']);
    const decoded = yield* Schema.decodeUnknownEffect(
      Schema.Struct({ ONTOS_SYMMY_REGIONS_PROJECTION: Schema.fromJsonString(Schema.Json) }),
    )(environment);
    expect(decoded.ONTOS_SYMMY_REGIONS_PROJECTION).toEqual(value);
    for (const invalid of [
      '{',
      json({ ...value, schemaVersion: 2 }),
      json({ ...value, secret: 'caller-selected' }),
      json({ routes: [{ ...route, regions: [region, region] }], schemaVersion: 1 }),
      json({
        routes: [
          {
            ...route,
            regions: [
              { ...region, marketRef: { ...region.marketRef, tenantId: '44444444-4444-4444-8444-444444444444' } },
            ],
          },
        ],
        schemaVersion: 1,
      }),
    ]) {
      const failure = yield* decodeShellNativeRegionsEnvironment(invalid).pipe(Effect.flip);
      expect(Schema.is(ApiKeyGatewayNativeFixtureError)(failure)).toBe(true);
    }
  }),
);

it('limits issuer diagnostics to bounded native statuses and existing problem tags', () => {
  const decode = Schema.decodeUnknownResult(ShellNativeGatewayDiagnosticsResponseSchema, { onExcessProperty: 'error' });
  const outcome = { problem: 'GatewayForbiddenProblem', status: 403 };
  expect(Result.isSuccess(decode({ _tag: 'gateway-diagnostics', outcomes: [outcome] }))).toBe(true);
  for (const invalid of [
    { _tag: 'gateway-diagnostics', outcomes: [{ ...outcome, secret: 'credential' }] },
    { _tag: 'gateway-diagnostics', outcomes: [{ ...outcome, request: 'private-request' }] },
    { _tag: 'gateway-diagnostics', outcomes: [{ ...outcome, problem: 'caller-selected' }] },
    { _tag: 'gateway-diagnostics', outcomes: [{ ...outcome, status: 999 }] },
    { _tag: 'gateway-diagnostics', outcomes: Array.from({ length: 33 }, () => outcome) },
  ]) {
    expect(Result.isFailure(decode(invalid))).toBe(true);
  }
});

it('keeps direct issuer observations finite and excludes credential or claim data', () => {
  const decode = Schema.decodeUnknownResult(ShellNativeIssuerDiagnosticsResponseSchema, { onExcessProperty: 'error' });
  const outcome = { audience: 'commerce-customer-context', outcome: 'scope_grant' };
  expect(Result.isSuccess(decode({ _tag: 'issuer-diagnostics', outcomes: [outcome] }))).toBe(true);
  for (const invalid of [
    { _tag: 'issuer-diagnostics', outcomes: [{ ...outcome, token: 'credential' }] },
    { _tag: 'issuer-diagnostics', outcomes: [{ ...outcome, principal: {} }] },
    { _tag: 'issuer-diagnostics', outcomes: [{ ...outcome, audience: 'caller-selected' }] },
    { _tag: 'issuer-diagnostics', outcomes: [{ ...outcome, outcome: 'arbitrary-error' }] },
    { _tag: 'issuer-diagnostics', outcomes: [{ ...outcome, code: 'caller-selected' }] },
    { _tag: 'issuer-diagnostics', outcomes: [{ ...outcome, failureCauseTag: 'caller-selected' }] },
    { _tag: 'issuer-diagnostics', outcomes: [{ ...outcome, nestedCauseTag: 'caller-selected' }] },
    { _tag: 'issuer-diagnostics', outcomes: Array.from({ length: 33 }, () => outcome) },
  ]) {
    expect(Result.isFailure(decode(invalid))).toBe(true);
  }
});

it('observes only native issuer codes and two finite cause tags without retaining the original failures', () => {
  const failure = new GatewayIssuerError({
    code: 'gateway_issuer_unavailable',
    failureCause: {
      _tag: 'InstalledModuleCatalogUnavailableError',
      cause: {
        _tag: 'ActiveApplicationCompositionUnavailableError',
        cause: { _tag: 'private-third-cause', message: 'credential' },
        message: 'private-source',
      },
      message: 'private-catalog',
    },
    reason: 'private-issuer',
    stage: 'audience',
  });
  expect(describeShellNativeIssuerFailure(failure)).toEqual({
    code: 'gateway_issuer_unavailable',
    failureCauseTag: 'InstalledModuleCatalogUnavailableError',
    nestedCauseTag: 'ActiveApplicationCompositionUnavailableError',
    outcome: 'audience',
  });
  expect(
    describeShellNativeIssuerFailure(
      new GatewayIssuerError({
        code: 'gateway_audience_invalid',
        failureCause: { _tag: 'credential', cause: { _tag: 'private-source' } },
        reason: 'private-issuer',
        stage: 'audience',
      }),
    ),
  ).toEqual({
    code: 'gateway_audience_invalid',
    failureCauseTag: 'other',
    nestedCauseTag: 'other',
    outcome: 'audience',
  });
  expect(
    describeShellNativeIssuerFailure(
      new GatewayIssuerError({
        code: 'gateway_revision_unsupported',
        reason: 'private-issuer',
        stage: 'audience',
      }),
    ),
  ).toEqual({ code: 'gateway_revision_unsupported', outcome: 'audience' });
});

it('bounds request timing diagnostics without accepting paths or identifying request data', () => {
  const decode = Schema.decodeUnknownResult(ShellNativeRequestDiagnosticsResponseSchema, { onExcessProperty: 'error' });
  const outcome = { elapsedMillis: 20_000, phase: 'dispatch_timeout', surface: 'symmy' };
  expect(Result.isSuccess(decode({ _tag: 'request-diagnostics', outcomes: [outcome] }))).toBe(true);
  expect(Result.isSuccess(decode({ _tag: 'request-diagnostics', outcomes: [{ ...outcome, status: 503 }] }))).toBe(true);
  for (const invalid of [
    { _tag: 'request-diagnostics', outcomes: [{ ...outcome, path: '/private-path' }] },
    { _tag: 'request-diagnostics', outcomes: [{ ...outcome, token: 'credential' }] },
    { _tag: 'request-diagnostics', outcomes: [{ ...outcome, elapsedMillis: -1 }] },
    { _tag: 'request-diagnostics', outcomes: [{ ...outcome, elapsedMillis: 60_001 }] },
    { _tag: 'request-diagnostics', outcomes: [{ ...outcome, phase: 'arbitrary-phase' }] },
    { _tag: 'request-diagnostics', outcomes: [{ ...outcome, surface: 'caller-selected' }] },
    { _tag: 'request-diagnostics', outcomes: [{ ...outcome, status: 999 }] },
    { _tag: 'request-diagnostics', outcomes: Array.from({ length: 33 }, () => outcome) },
  ]) {
    expect(Result.isFailure(decode(invalid))).toBe(true);
  }
});

it('keeps release observations closed to finite reasons without release identity or source data', () => {
  const decode = Schema.decodeUnknownResult(ShellNativeReleaseDiagnosticsResponseSchema, { onExcessProperty: 'error' });
  const outcome = { reason: 'catalog_unavailable', stage: 'release' };
  expect(Result.isSuccess(decode({ _tag: 'release-diagnostics', outcomes: [outcome] }))).toBe(true);
  for (const invalid of [
    { _tag: 'release-diagnostics', outcomes: [{ ...outcome, reason: 'caller-selected' }] },
    { _tag: 'release-diagnostics', outcomes: [{ ...outcome, stage: 'caller-selected' }] },
    { _tag: 'release-diagnostics', outcomes: [{ ...outcome, token: 'credential' }] },
    { _tag: 'release-diagnostics', outcomes: [{ ...outcome, revision: 'private-release' }] },
    { _tag: 'release-diagnostics', outcomes: [{ ...outcome, cause: {} }] },
    { _tag: 'release-diagnostics', outcomes: Array.from({ length: 33 }, () => outcome) },
  ]) {
    expect(Result.isFailure(decode(invalid))).toBe(true);
  }
});

it.effect(
  'keeps release observation optional and preserves the operation result and failure if the observer fails',
  () =>
    Effect.gen(function* preserveReleaseResult() {
      const value = Object.freeze({ admitted: true });
      const failure = new ApiKeyGatewayNativeFixtureError({ reason: 'Original release failure' });
      expect(yield* withShellGatewayReleaseDiagnostic('catalog_unavailable', Effect.succeed(value))).toBe(value);
      expect(
        yield* withShellGatewayReleaseDiagnostic('shell_marker_mismatch', Effect.fail(failure)).pipe(Effect.flip),
      ).toBe(failure);
      const observed = yield* Ref.make<readonly string[]>([]);
      expect(
        yield* withShellGatewayReleaseDiagnostic('catalog_invalid', Effect.succeed(value)).pipe(
          Effect.provideService(ShellGatewayReleaseObserver, (reason) =>
            Ref.update(observed, (previous) => [...previous, reason]),
          ),
        ),
      ).toBe(value);
      expect(yield* Ref.get(observed)).toEqual(['catalog_invalid']);
      for (const observation of [Effect.fail(new ShellGatewayReleaseObservationError()), Effect.die(failure)]) {
        expect(
          yield* withShellGatewayReleaseDiagnostic('catalog_unavailable', Effect.succeed(value)).pipe(
            Effect.provideService(ShellGatewayReleaseObserver, () => observation),
          ),
        ).toBe(value);
        expect(
          yield* withShellGatewayReleaseDiagnostic('catalog_invalid', Effect.fail(failure)).pipe(
            Effect.provideService(ShellGatewayReleaseObserver, () => observation),
            Effect.flip,
          ),
        ).toBe(failure);
      }
    }),
);

it.effect('preserves the original dispatch response and typed failure while retaining only bounded observations', () =>
  Effect.gen(function* observeDispatchResults() {
    const outcomes = yield* Ref.make<readonly (typeof ShellNativeRequestDiagnosticSchema.Type)[]>([]);
    const response = new Response(null, { status: 204 });
    const failure = new ApiKeyGatewayNativeFixtureError({ reason: 'Expected dispatch failure' });
    const timeout = Effect.fail(new ApiKeyGatewayNativeFixtureError({ reason: 'Expected timeout failure' }));
    expect(yield* observeShellNativeRequestDispatch(Effect.succeed(response), timeout, outcomes, 'symmy')).toBe(
      response,
    );
    expect(
      yield* observeShellNativeRequestDispatch(Effect.fail(failure), timeout, outcomes, 'gateway').pipe(Effect.flip),
    ).toBe(failure);
    const records = yield* Ref.get(outcomes);
    expect(records.map(({ phase }) => phase)).toEqual([
      'dispatch_started',
      'dispatch_completed',
      'dispatch_started',
      'dispatch_failed',
    ]);
    expect(records[1]?.status).toBe(204);
    yield* Effect.forEach(Array.from({ length: 18 }), () =>
      observeShellNativeRequestDispatch(Effect.succeed(response), timeout, outcomes, 'symmy'),
    );
    expect(yield* Ref.get(outcomes).pipe(Effect.map((values) => values.length))).toBe(32);
  }),
);

it.effect('keeps the exact twenty-second timeout and records its safe phase without retaining the failure', () =>
  Effect.gen(function* observeDispatchTimeout() {
    const outcomes = yield* Ref.make<readonly (typeof ShellNativeRequestDiagnosticSchema.Type)[]>([]);
    const began = yield* Deferred.make<boolean>();
    const failure = new ApiKeyGatewayNativeFixtureError({ reason: 'Expected timeout failure' });
    const fiber = yield* observeShellNativeRequestDispatch(
      Deferred.succeed(began, true).pipe(Effect.andThen(Effect.never)),
      Effect.fail(failure),
      outcomes,
      'symmy',
    ).pipe(Effect.forkChild);
    yield* Deferred.await(began);
    yield* TestClock.adjust('19 seconds');
    expect(yield* Ref.get(outcomes)).toEqual([{ elapsedMillis: 0, phase: 'dispatch_started', surface: 'symmy' }]);
    yield* TestClock.adjust('1 second');
    expect(yield* Fiber.join(fiber).pipe(Effect.flip)).toBe(failure);
    expect(yield* Ref.get(outcomes)).toEqual([
      { elapsedMillis: 0, phase: 'dispatch_started', surface: 'symmy' },
      { elapsedMillis: 20_000, phase: 'dispatch_timeout', surface: 'symmy' },
    ]);
  }).pipe(Effect.provide(TestClock.layer())),
);

it('keeps startup phases and private human setup commands closed to bounded data', () => {
  const stage = Schema.decodeUnknownResult(ShellNativeStartupEventSchema, { onExcessProperty: 'error' });
  expect(Result.isSuccess(stage({ stage: 'creating_authentication' }))).toBe(true);
  expect(Result.isFailure(stage({ stage: 'caller-selected' }))).toBe(true);
  expect(Result.isFailure(stage({ secret: 'credential', stage: 'ready' }))).toBe(true);
  const issue = Schema.decodeUnknownResult(ShellNativeSetupKeyIssueCommandSchema, { onExcessProperty: 'error' });
  expect(Result.isSuccess(issue({ _tag: 'setup-key-issue' }))).toBe(true);
  expect(Result.isFailure(issue({ _tag: 'setup-key-issue', principalId: 'caller-selected' }))).toBe(true);
  const issued = Schema.decodeUnknownResult(ShellNativeSetupKeyIssuedResponseSchema, { onExcessProperty: 'error' });
  expect(Result.isSuccess(issued({ _tag: 'setup-key-issued', providerKeyId: 'provider-key-identifier' }))).toBe(true);
  expect(
    Result.isFailure(
      issued({ _tag: 'setup-key-issued', providerKeyId: 'provider-key-identifier', secret: 'credential' }),
    ),
  ).toBe(true);
  const tenant = Schema.decodeUnknownResult(ShellNativeTenantSetupGatewayCommandSchema, { onExcessProperty: 'error' });
  const request = { audience: 'catalog', compositionRevision: 'a'.repeat(64) };
  expect(Result.isSuccess(tenant({ _tag: 'tenant-setup-gateway', request }))).toBe(true);
  expect(Result.isFailure(tenant({ _tag: 'tenant-setup-gateway', request: { ...request, audience: 'privacy' } }))).toBe(
    true,
  );
  expect(
    Result.isFailure(
      tenant({
        _tag: 'tenant-setup-gateway',
        request: { ...request, legalEntityId: '22222222-2222-4222-8222-222222222222' },
      }),
    ),
  ).toBe(true);
});

it.effect('forwards only the typed price-read source mapping to the child environment', () =>
  Effect.gen(function* priceEnvironment() {
    expect(yield* decodeShellNativePriceReadEnvironment()).toEqual({});
    const route = {
      issuerId: 'fixture-issuer',
      legalEntityId: '22222222-2222-4222-8222-222222222222',
      routeId: '33333333-3333-4333-8333-333333333333',
      sourceNamespace: 'fixture-source',
      sourceSystem: { ownerModuleId: 'integration.symmy', sourceSystemRef: 'native-price-source' },
      tenantId: '11111111-1111-4111-8111-111111111111',
    };
    const json = Schema.encodeSync(Schema.fromJsonString(Schema.Json));
    const value = { routes: [route], schemaVersion: 1 };
    const environment = yield* decodeShellNativePriceReadEnvironment(json(value));
    expect(Object.keys(environment)).toEqual(['ONTOS_SYMMY_PRICE_READ_SOURCES']);
    const decoded = yield* Schema.decodeUnknownEffect(
      Schema.Struct({ ONTOS_SYMMY_PRICE_READ_SOURCES: Schema.fromJsonString(Schema.Json) }),
    )(environment);
    expect(decoded.ONTOS_SYMMY_PRICE_READ_SOURCES).toEqual(value);
    for (const invalid of [
      '{',
      json({ ...value, secret: 'credential' }),
      json({ ...value, schemaVersion: 2 }),
      json({ routes: [{ ...route, routeId: 'invalid' }], schemaVersion: 1 }),
    ]) {
      const failure = yield* decodeShellNativePriceReadEnvironment(invalid).pipe(Effect.flip);
      expect(Schema.is(ApiKeyGatewayNativeFixtureError)(failure)).toBe(true);
    }
  }),
);

it('lets the parent ask only for the platform to provision the relay source, choosing nothing about it', () => {
  const decode = Schema.decodeUnknownResult(ShellNativeRelaySourceProvisionCommandSchema, {
    onExcessProperty: 'error',
  });
  expect(Result.isSuccess(decode({ _tag: 'relay-source-provision' }))).toBe(true);
  for (const chosen of [
    { principalId: '11111111-1111-4111-8111-111111111111' },
    { providerKeyId: 'caller-selected' },
    { sourceAppId: 'catalog' },
    { secret: 'caller-selected' },
  ]) {
    expect(Result.isFailure(decode({ _tag: 'relay-source-provision', ...chosen }))).toBe(true);
  }
  const provisioned = Schema.decodeUnknownResult(ShellNativeProvisionedResponseSchema, { onExcessProperty: 'error' });
  const answer = {
    _tag: 'provisioned',
    principalId: '11111111-1111-4111-8111-111111111111',
    providerKeyId: 'platform-provider-key',
    secret: 'platform-issued-module-key',
  };
  expect(Result.isSuccess(provisioned(answer))).toBe(true);
  expect(Result.isFailure(provisioned({ ...answer, principalId: 'invalid' }))).toBe(true);
});

it('restricts fixture source configuration to exact Market release metadata and keeps credentials off readiness', () => {
  // Codec-only data; no authority or Current is produced by these checks.
  const source = {
    compositionRevision: 'a'.repeat(64),
    sourceAppId: 'commerce-market-catalog',
    sourceBuildMarker: 'codec-only-marker',
  };
  const decode = Schema.decodeUnknownResult(ShellNativeRelaySourceSchema, { onExcessProperty: 'error' });
  expect(Result.isSuccess(decode(source))).toBe(true);
  const optionalSource = Schema.fromJsonString(Schema.OptionFromNullOr(ShellNativeRelaySourceSchema));
  expect(Schema.encodeSync(optionalSource)(Option.none())).toBe('null');
  expect(Option.isNone(Schema.decodeUnknownSync(optionalSource)('null'))).toBe(true);
  const selected = Schema.decodeUnknownSync(ShellNativeRelaySourceSchema)(source);
  const encoded = Schema.encodeSync(optionalSource)(Option.some(selected));
  expect(Schema.decodeUnknownSync(optionalSource)(encoded)).toEqual(Option.some(selected));
  for (const invalid of [
    { ...source, sourceAppId: 'catalog' },
    { ...source, sourceBuildMarker: '' },
    { ...source, compositionRevision: 'invalid' },
    { ...source, providerKeyId: 'caller-selected' },
  ]) {
    expect(Result.isFailure(decode(invalid))).toBe(true);
  }
  const ready = Schema.decodeUnknownResult(ShellNativeChildReadySchema, { onExcessProperty: 'error' });
  const oldReady = { baseUrl: 'http://127.0.0.1:1234', providerUserId: 'personal-provider-user' };
  expect(Result.isSuccess(ready(oldReady))).toBe(true);
  const sourceReady = { ...oldReady, readerProviderUserId: 'reader-provider-user' };
  expect(Result.isSuccess(ready(sourceReady))).toBe(true);
  expect(Result.isFailure(ready({ ...sourceReady, secret: 'credential' }))).toBe(true);
});

it('lets the parent name only a configured module for platform provisioning, choosing nothing else about it', () => {
  const decode = Schema.decodeUnknownResult(ShellNativeModuleSourceProvisionCommandSchema, {
    onExcessProperty: 'error',
  });
  const command = { _tag: 'module-source-provision', sourceAppId: 'party-registry' };
  expect(Result.isSuccess(decode(command))).toBe(true);
  for (const invalid of [
    { ...command, sourceAppId: 'caller-selected' },
    { ...command, principalId: '11111111-1111-4111-8111-111111111111' },
    { ...command, tenantId: '22222222-2222-4222-8222-222222222222' },
    { ...command, providerKeyId: 'caller-selected' },
    { ...command, secret: 'caller-selected' },
    { ...command, sourceBuildMarker: 'caller-selected' },
    { ...command, compositionRevision: 'a'.repeat(64) },
  ]) {
    expect(Result.isFailure(decode(invalid))).toBe(true);
  }
});

it('derives additional module releases from the admitted composition and keeps provider users off readiness', () => {
  const source = {
    compositionRevision: 'a'.repeat(64),
    sourceAppId: 'privacy',
    sourceBuildMarker: 'codec-only-marker',
  };
  const decode = Schema.decodeUnknownResult(ShellNativeAdditionalRelaySourceSchema, { onExcessProperty: 'error' });
  expect(Result.isSuccess(decode(source))).toBe(true);
  expect(Result.isFailure(decode({ ...source, providerKeyId: 'caller-selected' }))).toBe(true);
  expect(Result.isFailure(decode({ ...source, sourceAppId: 'caller-selected' }))).toBe(true);
  // A module's credential belongs to the platform's module principal: no person per module is published.
  const ready = Schema.decodeUnknownResult(ShellNativeChildReadySchema, { onExcessProperty: 'error' });
  const readiness = { baseUrl: 'http://127.0.0.1:1234', providerUserId: 'personal-provider-user' };
  expect(Result.isSuccess(ready(readiness))).toBe(true);
  expect(
    Result.isFailure(
      ready({
        ...readiness,
        additionalRelaySourceProviderUsers: [{ providerUserId: 'private-provider-join-id', sourceAppId: 'privacy' }],
      }),
    ),
  ).toBe(true);
});
