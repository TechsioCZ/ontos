import { ContextAccess, CoreSearchProjectionHitSchema, CoreSearchQueryRuntime } from '@app/core-runtime';
import { makeReadTestHarness } from '@app/core-runtime/testing/reads';
import { NodeCrypto } from '@effect/platform-node';
import { Context, Crypto, DateTime, Effect, Layer, Predicate, Schema } from 'effect';
import { expect, it, rs } from 'effect-rstest';

import { leasesRead } from '../../src/search/leases.provider.ts';

const scope = {
  authBindingId: '60000000-0000-4000-8000-000000000001',
  authContextRef: 'better-auth-session:property-search-provider-test',
  authMethod: 'session',
  correlationId: 'property-search-provider-test',
  legalEntityId: '20000000-0000-4000-8000-000000000001',
  principalId: '30000000-0000-4000-8000-000000000001',
  tenantId: '10000000-0000-4000-8000-000000000001',
} as const;

const testProvider = () =>
  Effect.scoped(
    Effect.gen(function* providerScenario() {
      const cryptoServices = yield* Layer.build(NodeCrypto.layer);
      const crypto = Context.get(cryptoServices, Crypto.Crypto);
      const harness = yield* makeReadTestHarness({
        executeOwnerQuery: () => Effect.succeed([]),
        operationTime: DateTime.toDateUtc(DateTime.makeUnsafe('2026-11-01T09:00:00.000Z')),
        ownerAuthorizationDecision: 'allowed',
        permissionDecision: 'allowed',
        scope,
      }).pipe(Effect.provideService(Crypto.Crypto, crypto));
      const services = yield* Layer.build(harness.layer);
      const access = Context.get(services, ContextAccess);
      const checked: unknown[] = [];
      const check = rs.spyOn(access, 'resources').mockImplementation((input) => {
        checked.push(input);
        return Effect.succeed(
          input.resources.map((ref) => ({
            decision: 'denied' as const,
            key: `${ref.moduleId}:${ref.resourceType}:${ref.resourceId}`,
          })),
        );
      });
      const hit = yield* Schema.decodeUnknownEffect(CoreSearchProjectionHitSchema)({
        archived: false,
        facets: [],
        metadata: [],
        ref: {
          moduleId: 'property.leasing',
          resourceId: '40000000-0000-4000-8000-000000000001',
          resourceType: 'property.leasing.occupancy',
          tenantId: scope.tenantId,
        },
        selectedLegalEntityId: scope.legalEntityId,
        title: 'Parková zahrada',
      });
      const request = { input: { query: 'Park' }, principal: scope, transport: { correlationId: scope.correlationId } };
      const run = harness.runtime.runRead({ ...request, registration: leasesRead }).pipe(Effect.asVoid, Effect.flip);
      const failure = yield* run.pipe(
        Effect.provideService(CoreSearchQueryRuntime, { search: () => Effect.succeed([hit]) }),
        Effect.ensuring(Effect.sync(() => check.mockRestore())),
      );
      expect(Predicate.isTagged(failure, 'ReadPermissionDenied')).toBe(true);
      expect(checked.length).toBe(1);
      expect(checked[0]).toMatchObject({
        legalEntityId: scope.legalEntityId,
        resources: [hit.ref],
        tenantId: scope.tenantId,
      });
      expect(harness.snapshot().ownerQueries).toEqual([]);
    }),
  );

it.effect('lease result resources are checked even when module and company access allow the query', () =>
  testProvider(),
);
