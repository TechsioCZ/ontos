import { ContextAccess, CoreSearchProjectionHitSchema, CoreSearchQueryRuntime } from '@app/core-runtime';
import { makeReadTestHarness } from '@app/core-runtime/testing/reads';
import { NodeCrypto } from '@effect/platform-node';
import { Context, Crypto, DateTime, Effect, Layer, Schema } from 'effect';
import { expect, it, rs } from 'effect-rstest';

import { LeasesProviderResponseSchema } from '../../shared/apis/leases-search.ts';
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

const hitFor = (suffix: string, title: string) =>
  Schema.decodeUnknownEffect(CoreSearchProjectionHitSchema)({
    archived: false,
    facets: [],
    metadata: [],
    ref: {
      moduleId: 'property.leasing',
      resourceId: `40000000-0000-4000-8000-00000000000${suffix}`,
      resourceType: 'property.leasing.occupancy',
      tenantId: scope.tenantId,
    },
    selectedLegalEntityId: scope.legalEntityId,
    title,
  });

const testProvider = (
  items: readonly (typeof CoreSearchProjectionHitSchema.Type)[],
  allow: (resourceId: string) => boolean,
) =>
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
            decision: allow(ref.resourceId) ? ('allowed' as const) : ('denied' as const),
            key: `${ref.moduleId}:${ref.resourceType}:${ref.resourceId}`,
          })),
        );
      });
      const result = yield* harness.runtime
        .runRead({
          input: { query: 'Park' },
          principal: scope,
          registration: leasesRead,
          transport: { correlationId: scope.correlationId },
        })
        .pipe(
          Effect.provideService(CoreSearchQueryRuntime, { search: () => Effect.succeed(items) }),
          Effect.ensuring(Effect.sync(() => check.mockRestore())),
        );
      return { checked, result, snapshot: harness.snapshot() };
    }),
  );

it.effect('returns only explicitly allowed lease rows and checks every candidate resource once', () =>
  Effect.gen(function* mixedDecisions() {
    const hits = yield* Effect.all([hitFor('1', 'A zahr ada'), hitFor('2', 'B zahr ada'), hitFor('3', 'C zahr ada')]);
    const outcome = yield* testProvider(hits, (resourceId) => !resourceId.endsWith('2'));
    expect(outcome.result.map(({ title }) => title)).toEqual(['A zahr ada', 'C zahr ada']);
    expect(outcome.checked).toEqual([
      {
        legalEntityId: scope.legalEntityId,
        permission: 'read',
        principalId: scope.principalId,
        resources: hits.map(({ ref }) => ({
          moduleId: ref.moduleId,
          resourceId: ref.resourceId,
          resourceType: ref.resourceType,
        })),
        tenantId: scope.tenantId,
      },
    ]);
    expect(outcome.snapshot.ownerQueries).toEqual([]);
  }),
);

it.effect('turns an all-denied lease candidate set into an empty admitted collection', () =>
  Effect.gen(function* deniedDecisions() {
    const hits = yield* Effect.all([hitFor('1', 'A'), hitFor('2', 'B')]);
    const outcome = yield* testProvider(hits, () => false);
    expect(outcome.result).toEqual([]);
    expect(outcome.checked.length).toBe(1);
  }),
);

it.effect('keeps every row when all lease candidates are explicitly allowed', () =>
  Effect.gen(function* allowedDecisions() {
    const hits = yield* Effect.all([hitFor('1', 'A'), hitFor('2', 'B')]);
    const outcome = yield* testProvider(hits, () => true);
    expect(outcome.result.map(({ ref }) => ref.resourceId)).toEqual(hits.map(({ ref }) => ref.resourceId));
  }),
);

it('accepts only the verified optional Core relevance v1 score range', () => {
  const result = {
    ref: {
      moduleId: 'property.leasing',
      resourceId: '40000000-0000-4000-8000-000000000001',
      resourceType: 'property.leasing.occupancy',
      tenantId: scope.tenantId,
    },
    selectedLegalEntityId: scope.legalEntityId,
    title: 'Nájem od 1. 11. 2026 na dobu neurčitou · Aktivní · 40000000-0000-4000-8000-000000000001',
  } as const;
  expect(Schema.is(LeasesProviderResponseSchema)([result])).toBe(true);
  for (const relevance of [
    { score: 0, version: '1' },
    { score: 1000, version: '1' },
  ]) {
    expect(Schema.is(LeasesProviderResponseSchema)([{ ...result, relevance }])).toBe(true);
  }
  for (const relevance of [
    { score: -1, version: '1' },
    { score: 1001, version: '1' },
    { score: 500.5, version: '1' },
    { score: 500, version: '2' },
  ]) {
    expect(Schema.is(LeasesProviderResponseSchema)([{ ...result, relevance }])).toBe(false);
  }
});
