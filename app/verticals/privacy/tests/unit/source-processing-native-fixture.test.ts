import { NodeCrypto } from '@effect/platform-node';
import { ConfigProvider, Effect, Redacted, Schema } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { describe, expect, it } from 'effect-rstest';
import {
  SourceProcessingNativeFixtureError,
  seedCommittedProfileSourceProcessingNativeFixture,
  seedSourceProcessingNativeFixture,
} from '../support/source-processing-native.ts';

const database = 'ontos_test_party_gateway_00000000000000000000000000000001';
const input = {
  connections: {
    admin: {
      connectionString: 'postgres://fixture-admin@127.0.0.1:1/unused',
      database,
      host: '127.0.0.1',
      port: 1,
      user: 'fixture-admin',
    },
    runtime: {
      connectionString: 'postgres://fixture-runtime@127.0.0.1:1/unused',
      database,
      host: '127.0.0.1',
      port: 1,
      user: 'fixture-runtime',
    },
  },
  contexts: [
    {
      authMethod: 'system',
      principalId: '10000000-0000-4000-8000-000000000003',
      request: {
        consumerModuleId: 'party.registry' as const,
        operation: 'CREATE',
        source: {
          issuer: 'internal:fixture',
          namespace: 'clients',
          occurrenceId: 'one',
          recordId: 'one',
          recordType: 'customer',
          routeRef: 'route:one',
        },
        target: null,
      },
    },
  ],
  contractEvidenceRef: 'internal-fixture:explicit-contract',
  controllerRef: 'internal-fixture:controller',
  dataCategoryRefs: ['party:name'],
  governancePrincipalId: '10000000-0000-4000-8000-000000000004',
  legalEntityId: '10000000-0000-4000-8000-000000000002',
  meaning: 'Explicit isolated test records only',
  tenantId: '10000000-0000-4000-8000-000000000001',
};

describe('native source fixture isolation boundary', () => {
  it.effect('uses the live public receipt admission and rejects another target before database writes', () =>
    Effect.gen(function* committedTargetMismatch() {
      const source = {
        effectId: 'internal:profile-effect',
        issuer: 'internal:fixture',
        mappingRevision: 'mapping:1',
        namespace: 'clients',
        occurrenceId: 'one',
        order: 0,
        recordId: 'one',
        recordType: 'customer',
        revision: '1',
        route: { id: 'route:one', revision: '1' },
      };
      const partyRef = {
        moduleId: 'party.registry',
        resourceId: '20000000-0000-4000-8000-000000000001',
        resourceType: 'party.registry.party',
        tenantId: input.tenantId,
      };
      const partySourceReference = {
        occurrenceId: 'one',
        recordId: 'one',
        source: {
          issuer: source.issuer,
          namespace: source.namespace,
          recordType: source.recordType,
          routeRef: source.route.id,
        },
      };
      const profileRef = {
        moduleId: 'commerce.customer-context',
        resourceId: 'profile:committed',
        resourceType: 'commerce.customer-context.retail-customer-profile',
        tenantId: input.tenantId,
      };
      const profileResponse = {
        _tag: 'MINIMAL_RECEIPT',
        receipt: {
          actionInvocationId: '30000000-0000-4000-8000-000000000001',
          actorPrincipalId: input.contexts[0].principalId,
          intent: {
            effectiveAt: '2026-11-07T12:00:00.000Z',
            partySourceReference,
            source,
            subject: {
              kind: 'RETAIL',
              partyRef,
              sellingLegalEntityRef: {
                moduleId: 'core.identity',
                resourceId: input.legalEntityId,
                resourceType: 'core.identity.legal-entity',
                tenantId: input.tenantId,
              },
            },
            trigger: 'AUTHORIZED_ONBOARDING',
          },
          profileKind: 'RETAIL',
          recordedAt: '2026-11-07T12:00:00.000Z',
          result: {
            outcome: 'PROFILE_CREATED',
            profileRef,
            revision: 1,
            sourceEffect: { effectId: source.effectId, replayed: false },
            state: 'ACTIVE',
          },
        },
      };
      const personResponse = {
        outcome: 'SOURCE_PERSON_CURRENT',
        partyRef,
        partyRevision: 1,
        sourceActionInvocationId: '30000000-0000-4000-8000-000000000002',
        sourceDecisionRef: {
          moduleId: 'party.registry',
          resourceId: '30000000-0000-4000-8000-000000000003',
          resourceType: 'party.registry.party-match-decision',
          tenantId: input.tenantId,
        },
      };
      const calls: string[] = [];
      const fakeFetch: typeof globalThis.fetch = (url, init) => {
        const request = new Request(url, init);
        calls.push(request.url);
        return Promise.resolve(
          Response.json(
            request.url.includes('source-person-admission')
              ? personResponse
              : { ...profileResponse, currentAdmission: { ...personResponse, sourceReference: partySourceReference } },
          ),
        );
      };
      const proofTransport = {
        authorization: Redacted.make('Bearer internal-public-proof-fixture'),
        baseUrl: 'https://owner.test',
        compositionRevision: 'a'.repeat(64),
        requestCorrelation: 'internal:proof',
      };
      const error = yield* Effect.flip(
        seedCommittedProfileSourceProcessingNativeFixture({
          ...input,
          contexts: [
            {
              ...input.contexts[0],
              request: {
                ...input.contexts[0].request,
                consumerModuleId: 'commerce.customer-context',
                operation: 'PRICE_GROUP_ASSIGN',
                target: { kind: 'RETAIL_CUSTOMER_PROFILE', resourceId: 'profile:other' },
              },
            },
          ],
          personAdmission: proofTransport,
          profileReceipt: { ...proofTransport, request: { ...source, mode: 'MINIMAL_RECEIPT' } },
        }).pipe(Effect.provideService(FetchHttpClient.Fetch, fakeFetch)),
      );
      expect(Schema.is(SourceProcessingNativeFixtureError)(error)).toBe(true);
      expect(calls).toHaveLength(1);
      if (Schema.is(SourceProcessingNativeFixtureError)(error)) {
        expect(error.cause === undefined ? undefined : Redacted.value(error.cause)).toBeUndefined();
      } else {
        return yield* Effect.fail(error);
      }
      return yield* Effect.void;
    }).pipe(
      Effect.provide(NodeCrypto.layer),
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown({})),
    ),
  );
  it.effect('refuses deployed execution before opening either database connection', () =>
    Effect.gen(function* deployedFixtureRefusal() {
      const error = yield* Effect.flip(
        seedSourceProcessingNativeFixture(input).pipe(
          Effect.provideService(
            ConfigProvider.ConfigProvider,
            ConfigProvider.fromUnknown({ ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: 'production' }),
          ),
        ),
      );
      expect(Schema.is(SourceProcessingNativeFixtureError)(error)).toBe(true);
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );
  it.effect(
    'refuses unsafe database boundaries, conflicting classification, and native-target requests without I/O',
    () =>
      Effect.gen(function* foreignFixtureRefusal() {
        const requests = [
          { ...input, connections: { ...input.connections, admin: { ...input.connections.admin, database: 'ontos' } } },
          {
            ...input,
            connections: { ...input.connections, runtime: { ...input.connections.runtime, user: 'fixture-admin' } },
          },
          { ...input, contexts: [{ ...input.contexts[0], request: { ...input.contexts[0].request, source: null } }] },
          { ...input, dataCategoryRefs: ['party:name', 'commerce:customer-profile'] },
        ];
        for (const request of requests) {
          const error = yield* Effect.flip(seedSourceProcessingNativeFixture(request));
          expect(Schema.is(SourceProcessingNativeFixtureError)(error)).toBe(true);
        }
      }).pipe(
        Effect.provide(NodeCrypto.layer),
        Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown({})),
      ),
  );
});
