import { TrustedPrincipalContextSchema } from '@app/core-runtime/actions/principal-context';
import {
  RegisteredGatewayWorkloadSchema,
  trustVerifiedGatewayPrincipalContext,
  preserveSystemPrincipalContextTrust,
} from '@app/core-runtime/auth/system-principal-context-provenance';
import { ConfigProvider, Crypto, Effect, Match, Redacted, Result, Schema, Struct } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { expect, it } from 'effect-rstest';

import { holdTestModuleCredentials } from '../../../core-runtime/tests/support/module-credentials.ts';
import { acquireDelegatedGatewayContext, GatewayDelegationSourceError } from '../../src/gateway-context-server.ts';
import { GatewayDelegatedContextRequestSchema } from '../../src/gateway-context.ts';

const revision = 'a'.repeat(64);
const requestHash = 'b'.repeat(64);
const targetDeclaration = 'integration.symmy.symmy-source-organization-facts.read';
const tenantId = '30000000-0000-4000-8000-000000000001';
const legalEntityId = '30000000-0000-4000-8000-000000000002';
const configuration = ConfigProvider.fromEnvRecord({
  ONTOS_SHELL_GATEWAY_BASE_URL: 'https://shell.example.test/shell-super-app-api',
});
/** Each calling module's key, handed over the way the host does. */
const holdCallerKeys = holdTestModuleCredentials({
  privacy: 'fixture-privacy-module-key',
  'symmy-integration': 'fixture-symmy-module-key',
});
const crypto = Crypto.make({
  digest: () => Effect.succeed(new Uint8Array()),
  randomBytes: (size) => new Uint8Array(size).fill(1),
});

/** Shared transport fixture only: the response is harmless wire data and is never used as an authenticated token. */
const sourceScope = (finite = false) => {
  const principal = Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authContextRef: 'job:processing:run:60000000-0000-4000-8000-000000000001',
    authMethod: 'system',
    principalId: '10000000-0000-4000-8000-000000000001',
    tenantId,
  });
  const base = {
    admissionInvocationId: '60000000-0000-4000-8000-000000000001',
    bindingIncarnation: '60000000-0000-4000-8000-000000000002',
    claimId: 'current-native-claim',
    declarationKey: finite ? targetDeclaration : 'privacy.core.source-processing-eligibility.read',
    entrypointKey: finite
      ? 'integration.symmy.api.symmy-source-organization-facts'
      : 'privacy.core.api.source-processing-eligibility',
    jobKey: 'processing',
    legalEntityId,
    legalEntityScope: 'required',
    originalOwnerBindingIncarnation: '60000000-0000-4000-8000-000000000003',
    originalPrincipalId: '40000000-0000-4000-8000-000000000002',
    originalWorkloadBindingIncarnation: '60000000-0000-4000-8000-000000000004',
    originalWorkloadKey: 'integration.source-admit',
    runReference: '60000000-0000-4000-8000-000000000001',
    schemaVersion: '1',
    sourceAppId: 'symmy-integration',
    sourceBuildMarker: 'symmy-build',
    sourceMode: 'worker',
    workerKey: 'integration.source-worker',
    workerModuleKey: 'integration.source',
    workloadKey: finite ? 'integration.symmy.source-organization-facts.read' : 'privacy.core.source-processing-check',
  };
  const workload = Schema.decodeUnknownSync(RegisteredGatewayWorkloadSchema)(
    finite ? { ...base, organizationProcessingRead: { requestHash } } : base,
  );
  const trusted = trustVerifiedGatewayPrincipalContext(
    principal,
    revision,
    { assertion: Redacted.make('actual-source-proof-fixture'), audience: finite ? 'symmy-integration' : 'privacy' },
    undefined,
    workload,
  );
  return preserveSystemPrincipalContextTrust(trusted, { ...trusted, correlationId: 'processing-wire', legalEntityId });
};
const recordingFetch =
  (requests: Request[]): typeof globalThis.fetch =>
  (input, init) => {
    requests.push(new Request(input, init));
    return Promise.resolve(
      Response.json({
        apiBaseUrl: '/symmy-api',
        compositionRevision: revision,
        expiresAt: 1_700_000_300,
        token: 'harmless-wire-response',
      }),
    );
  };

it.effect('preserves the exact decoded processing request hash on the typed registered-assertion wire', () =>
  Effect.gen(function* processingHashWire() {
    yield* holdCallerKeys;
    const requests: Request[] = [];
    yield* acquireDelegatedGatewayContext(
      {
        audience: 'symmy-integration',
        callingAppId: 'privacy',
        legalEntityScope: 'subject',
        requestCorrelation: 'processing-wire',
        subject: {
          _tag: 'RegisteredAssertion',
          declarationKey: targetDeclaration,
          expectedPrincipalId: '10000000-0000-4000-8000-000000000009',
          processingRequestHash: requestHash,
          scope: sourceScope(),
        },
      },
      crypto,
    ).pipe(
      Effect.provideService(ConfigProvider.ConfigProvider, configuration),
      Effect.provideService(FetchHttpClient.Fetch, recordingFetch(requests)),
    );
    const [request] = requests;
    if (request === undefined) {
      return yield* Effect.die('Expected one captured wire request');
    }
    const decoded = yield* Effect.promise(() => request.json()).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(GatewayDelegatedContextRequestSchema)),
    );
    return yield* Match.value(decoded.subject).pipe(
      Match.tag('RegisteredAssertion', (subject) => {
        expect(subject.processingRequestHash).toBe(requestHash);
        expect(subject.expectedPrincipalId).toBe('10000000-0000-4000-8000-000000000009');
        expect(Redacted.value(subject.sourceAssertion)).toBe('actual-source-proof-fixture');
        return Effect.void;
      }),
      Match.orElse(() => Effect.die('Expected exact registered assertion wire')),
    );
  }),
);

it.effect('rejects processing/recovery mixing, changed target, and finite processing onward use before HTTP', () =>
  Effect.gen(function* processingRestrictionPreHttp() {
    yield* holdCallerKeys;
    const normal = sourceScope();
    const cases = [
      {
        audience: 'party-registry',
        callingAppId: 'privacy',
        subject: {
          _tag: 'RegisteredAssertion',
          declarationKey: targetDeclaration,
          processingRequestHash: requestHash,
          scope: normal,
        },
      },
      {
        audience: 'symmy-integration',
        callingAppId: 'privacy',
        subject: {
          _tag: 'RegisteredAssertion',
          declarationKey: 'integration.symmy.other.read',
          processingRequestHash: requestHash,
          scope: normal,
        },
      },
      {
        audience: 'symmy-integration',
        callingAppId: 'privacy',
        subject: {
          _tag: 'RegisteredAssertion',
          declarationKey: targetDeclaration,
          processingRequestHash: requestHash,
          recoveryRequestHash: requestHash,
          scope: normal,
        },
      },
      {
        audience: 'symmy-integration',
        callingAppId: 'privacy',
        subject: {
          _tag: 'RegisteredAssertion',
          declarationKey: targetDeclaration,
          processingRequestHash: requestHash,
          scope: { ...normal },
        },
      },
      {
        audience: 'symmy-integration',
        callingAppId: 'symmy-integration',
        subject: { _tag: 'Assertion', scope: sourceScope(true) },
      },
    ] as const;
    for (const item of cases) {
      const requests: Request[] = [];
      const failure = yield* acquireDelegatedGatewayContext(
        { ...item, legalEntityScope: 'subject', requestCorrelation: 'denied-processing-wire' },
        crypto,
      ).pipe(
        Effect.provideService(ConfigProvider.ConfigProvider, configuration),
        Effect.provideService(FetchHttpClient.Fetch, recordingFetch(requests)),
        Effect.flip,
      );
      expect(Schema.is(GatewayDelegationSourceError)(failure)).toBe(true);
      expect(requests).toHaveLength(0);
    }
  }),
);

it('rejects a raw wire that combines independent recovery and processing restrictions', () => {
  const wire = {
    audience: 'symmy-integration',
    compositionRevision: revision,
    exchangeId: '10000000-0000-4000-8000-000000000001',
    legalEntityScope: 'subject',
    subject: {
      _tag: 'RegisteredAssertion',
      declarationKey: targetDeclaration,
      processingRequestHash: requestHash,
      recoveryRequestHash: requestHash,
      sourceAssertion: 'fixture-source-proof',
    },
  };
  expect(Result.isSuccess(Schema.decodeUnknownResult(GatewayDelegatedContextRequestSchema)(wire))).toBe(false);
  expect(
    Result.isSuccess(
      Schema.decodeUnknownResult(GatewayDelegatedContextRequestSchema)({
        ...wire,
        subject: Struct.omit(wire.subject, ['recoveryRequestHash']),
      }),
    ),
  ).toBe(true);
});
