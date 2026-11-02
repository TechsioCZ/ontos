import {
  ContextAccess,
  LegalEntityContext,
  LegalEntityContextUnavailableError,
  classifyActiveLegalEntities,
} from '@app/core-runtime';
import type { ContextAccessService, LegalEntityContextService, SafeLegalEntity } from '@app/core-runtime';
import { Effect, Layer, Option, Predicate, Ref } from 'effect';
import { TestClock } from 'effect/testing';
import { expect, it } from 'effect-rstest';

import { GatewayTimings } from '../../api/auth/gateway-timing.ts';
import type { GatewayPhase } from '../../api/auth/gateway-timing.ts';
import {
  canSelectTenantContext,
  resolveAuthorizedLegalEntities,
  validateAuthorizedLegalEntity,
} from '../../api/auth/legal-entity-selection.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const principalId = '20000000-0000-4000-8000-000000000001';
const alpha = {
  legalEntityId: '30000000-0000-4000-8000-000000000001',
  legalName: 'Alpha',
};
const beta = {
  legalEntityId: '30000000-0000-4000-8000-000000000002',
  legalName: 'Beta',
};

const context = (entities: readonly SafeLegalEntity[] = [alpha, beta]): LegalEntityContextService => ({
  listActiveForTenant: () => Effect.succeed(entities),
  validateSelection: (_tenantId, legalEntityId) => {
    const selected = entities.find((entity) => entity.legalEntityId === legalEntityId);
    return selected === undefined ? Effect.die('missing fixture entity') : Effect.succeed(selected);
  },
});

const access = (decisions: Readonly<Record<string, 'allowed' | 'denied' | 'unavailable'>>): ContextAccessService => ({
  legalEntities: ({ legalEntityIds }) =>
    Effect.succeed(
      legalEntityIds.map((key) => ({
        decision: decisions[key] ?? 'denied',
        key,
      })),
    ),
  modules: ({ moduleIds }) => Effect.succeed(moduleIds.map((key) => ({ decision: 'denied' as const, key }))),
  resources: () => Effect.succeed([]),
  tenants: ({ tenantIds }) => Effect.succeed(tenantIds.map((key) => ({ decision: 'denied' as const, key }))),
});

const provideSelectionServices = <Success, Failure>(
  effect: Effect.Effect<Success, Failure, ContextAccess | LegalEntityContext>,
  legalEntityContext: LegalEntityContextService,
  contextAccess: ContextAccessService,
): Effect.Effect<Success, Failure> =>
  effect.pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(LegalEntityContext, legalEntityContext),
        Layer.succeed(ContextAccess, contextAccess),
      ),
    ),
  );

it.effect('auto-selects the only authorized entity and preserves an exact saved choice', () =>
  Effect.gen(function* verifyCase1() {
    const only = yield* provideSelectionServices(
      resolveAuthorizedLegalEntities({ principalId, tenantId }),
      context(),
      access({ [alpha.legalEntityId]: 'allowed' }),
    );
    expect(only).toEqual({
      available: [alpha],
      selected: alpha,
      state: 'selected',
    });
    const saved = yield* provideSelectionServices(
      resolveAuthorizedLegalEntities({
        principalId,
        savedLegalEntityId: beta.legalEntityId,
        tenantId,
      }),
      context(),
      access({
        [alpha.legalEntityId]: 'allowed',
        [beta.legalEntityId]: 'allowed',
      }),
    );
    expect(saved).toEqual({
      available: [alpha, beta],
      selected: beta,
      state: 'selected',
    });
  }),
);

it.effect('requires a choice for several entities and blocks zero definite grants', () =>
  Effect.gen(function* verifyCase2() {
    expect(
      yield* provideSelectionServices(
        resolveAuthorizedLegalEntities({ principalId, tenantId }),
        context(),
        access({
          [alpha.legalEntityId]: 'allowed',
          [beta.legalEntityId]: 'allowed',
        }),
      ),
    ).toEqual({ available: [alpha, beta], state: 'selection_required' });
    expect(
      yield* provideSelectionServices(resolveAuthorizedLegalEntities({ principalId, tenantId }), context(), access({})),
    ).toEqual({ available: [], state: 'access_blocked' });
  }),
);

it.effect('fails closed for authorization uncertainty and validates a switch independently', () =>
  Effect.gen(function* verifyCase3() {
    const unavailable = yield* Effect.flip(
      provideSelectionServices(
        resolveAuthorizedLegalEntities({ principalId, tenantId }),
        context(),
        access({ [alpha.legalEntityId]: 'unavailable' }),
      ),
    );
    expect(Predicate.isTagged(unavailable, 'LegalEntitySelectionUnavailableError')).toBe(true);
    expect(
      yield* provideSelectionServices(
        validateAuthorizedLegalEntity({
          legalEntityId: beta.legalEntityId,
          principalId,
          tenantId,
        }),
        context(),
        access({ [beta.legalEntityId]: 'allowed' }),
      ),
    ).toEqual(beta);
  }),
);

it.effect('starts the shared demo tenant in a stable authorized company without changing other tenants', () =>
  Effect.gen(function* verifyDemoDefault() {
    const selected = yield* provideSelectionServices(
      resolveAuthorizedLegalEntities({ principalId, tenantId: '70000000-0000-4000-8000-000000000020' }),
      context([beta, alpha]),
      access({ [alpha.legalEntityId]: 'allowed', [beta.legalEntityId]: 'allowed' }),
    );
    expect(selected).toEqual({ available: [beta, alpha], selected: alpha, state: 'selected' });
  }),
);

it.effect('selects tenant context only through its exact graph capability, never company access', () =>
  Effect.gen(function* verifyTenantContextCapability() {
    const calls: unknown[] = [];
    const contextAccess: ContextAccessService = {
      ...access({ [alpha.legalEntityId]: 'allowed' }),
      tenants: (input) => {
        calls.push(input);
        return Effect.succeed([{ decision: 'allowed', key: tenantId }]);
      },
    };
    expect(
      yield* canSelectTenantContext({ principalId, tenantId }).pipe(
        Effect.provideService(ContextAccess, contextAccess),
      ),
    ).toBe(true);
    expect(calls).toEqual([{ permission: 'select_context', principalId, tenantIds: [tenantId] }]);
    expect(
      yield* canSelectTenantContext({ principalId, tenantId }).pipe(
        Effect.provideService(ContextAccess, access({ [alpha.legalEntityId]: 'allowed' })),
      ),
    ).toBe(false);
  }),
);

it.effect('rejects missing, foreign, duplicate or unavailable tenant context decisions', () =>
  Effect.gen(function* verifyTenantContextDecisions() {
    for (const decisions of [
      [],
      [{ decision: 'allowed' as const, key: 'another-tenant' }],
      [{ decision: 'unavailable' as const, key: tenantId }],
      [
        { decision: 'allowed' as const, key: tenantId },
        { decision: 'allowed' as const, key: tenantId },
      ],
    ]) {
      const error = yield* canSelectTenantContext({ principalId, tenantId }).pipe(
        Effect.provideService(ContextAccess, { ...access({}), tenants: () => Effect.succeed(decisions) }),
        Effect.flip,
      );
      expect(Predicate.isTagged(error, 'LegalEntitySelectionUnavailableError')).toBe(true);
    }
  }),
);

const gamma = {
  legalEntityId: '30000000-0000-4000-8000-000000000003',
  legalName: 'Gamma',
};

it.effect('replaces stale A only with the sole currently authorized same-Tenant B', () =>
  Effect.gen(function* replacesStaleSelection() {
    for (const candidates of [[alpha, beta], [beta]]) {
      expect(
        yield* provideSelectionServices(
          resolveAuthorizedLegalEntities({ principalId, savedLegalEntityId: alpha.legalEntityId, tenantId }),
          context(candidates),
          access({ [beta.legalEntityId]: 'allowed' }),
        ),
      ).toEqual({ available: [beta], selected: beta, state: 'selected' });
    }
  }),
);

it.effect('times SQL and SpiceDB independently for API-key and session legal-entity selection', () =>
  Effect.gen(function* timedSelections() {
    const timings = yield* Ref.make<readonly { readonly durationMs: number; readonly phase: GatewayPhase }[]>([]);
    const records = context();
    const permissions = access({ [alpha.legalEntityId]: 'allowed' });
    const timedRecords: LegalEntityContextService = {
      listActiveForTenant: (tenant) => TestClock.adjust(20).pipe(Effect.andThen(records.listActiveForTenant(tenant))),
      validateSelection: (tenant, entity) =>
        TestClock.adjust(20).pipe(Effect.andThen(records.validateSelection(tenant, entity))),
    };
    const timedPermissions: ContextAccessService = {
      ...permissions,
      legalEntities: (input) => TestClock.adjust(2000).pipe(Effect.andThen(permissions.legalEntities(input))),
    };
    yield* provideSelectionServices(
      validateAuthorizedLegalEntity({ legalEntityId: alpha.legalEntityId, principalId, tenantId }),
      timedRecords,
      timedPermissions,
    ).pipe(Effect.provideService(GatewayTimings, Option.some(timings)));
    yield* provideSelectionServices(
      resolveAuthorizedLegalEntities({ principalId, tenantId }),
      timedRecords,
      timedPermissions,
    ).pipe(Effect.provideService(GatewayTimings, Option.some(timings)));
    expect(yield* Ref.get(timings)).toEqual([
      { durationMs: 20, phase: 'legal-entity-sql' },
      { durationMs: 2000, phase: 'legal-entity-spicedb' },
      { durationMs: 20, phase: 'legal-entity-sql' },
      { durationMs: 2000, phase: 'legal-entity-spicedb' },
    ]);
  }),
);

it.effect('blocks stale A with no current grant and requires selection when several alternatives remain', () =>
  Effect.gen(function* boundsStaleSelection() {
    const request = { principalId, savedLegalEntityId: alpha.legalEntityId, tenantId };
    expect(
      yield* provideSelectionServices(resolveAuthorizedLegalEntities(request), context([beta]), access({})),
    ).toEqual({ available: [], state: 'access_blocked' });
    expect(
      yield* provideSelectionServices(
        resolveAuthorizedLegalEntities(request),
        context([alpha, beta, gamma]),
        access({ [beta.legalEntityId]: 'allowed', [gamma.legalEntityId]: 'allowed' }),
      ),
    ).toEqual({ available: [beta, gamma], state: 'selection_required' });
  }),
);

it.effect('does not turn an unavailable alternative into a singleton fallback', () =>
  Effect.gen(function* rejectsUncertainAlternative() {
    const failure = yield* Effect.flip(
      provideSelectionServices(
        resolveAuthorizedLegalEntities({ principalId, savedLegalEntityId: alpha.legalEntityId, tenantId }),
        context(),
        access({ [alpha.legalEntityId]: 'unavailable', [beta.legalEntityId]: 'allowed' }),
      ),
    );
    expect(Predicate.isTagged(failure, 'LegalEntitySelectionUnavailableError')).toBe(true);
  }),
);

it.effect('fails closed when the active Legal Entity provider is unavailable or returns foreign-Tenant records', () =>
  Effect.gen(function* rejectsInvalidCandidates() {
    const validContext = context();
    for (const listActiveForTenant of [
      () => Effect.fail(new LegalEntityContextUnavailableError({ reason: 'Fixture provider unavailable' })),
      (selectedTenant: string) =>
        classifyActiveLegalEntities(
          [{ ...beta, status: 'active', tenantId: '10000000-0000-4000-8000-000000000002' }],
          selectedTenant,
        ),
    ]) {
      const failure = yield* Effect.flip(
        provideSelectionServices(
          resolveAuthorizedLegalEntities({ principalId, savedLegalEntityId: alpha.legalEntityId, tenantId }),
          { ...validContext, listActiveForTenant },
          access({ [beta.legalEntityId]: 'allowed' }),
        ),
      );
      expect(Predicate.isTagged(failure, 'LegalEntitySelectionUnavailableError')).toBe(true);
    }
  }),
);

const incompleteDecisionCases = [
  { decisions: [{ decision: 'allowed' as const, key: beta.legalEntityId }], name: 'a missing response' },
  {
    decisions: [
      { decision: 'allowed' as const, key: beta.legalEntityId },
      { decision: 'denied' as const, key: beta.legalEntityId },
    ],
    name: 'contradictory duplicate keys',
  },
  {
    decisions: [
      { decision: 'allowed' as const, key: beta.legalEntityId },
      { decision: 'denied' as const, key: gamma.legalEntityId },
    ],
    name: 'an unexpected key replacing a missing response',
  },
];

for (const { decisions, name } of incompleteDecisionCases) {
  it.effect(`fails closed for ${name} instead of selecting B from incomplete authorization evidence`, () =>
    Effect.gen(function* rejectsIncompleteAuthorization() {
      const unavailable = yield* provideSelectionServices(
        resolveAuthorizedLegalEntities({ principalId, savedLegalEntityId: alpha.legalEntityId, tenantId }),
        context(),
        { ...access({}), legalEntities: () => Effect.succeed(decisions) },
      ).pipe(
        Effect.match({
          onFailure: (failure) => Predicate.isTagged(failure, 'LegalEntitySelectionUnavailableError'),
          onSuccess: () => false,
        }),
      );
      expect(unavailable).toBe(true);
    }),
  );
}

it.effect('accepts complete authorization evidence regardless of response order', () =>
  Effect.gen(function* acceptsReorderedEvidence() {
    expect(
      yield* provideSelectionServices(
        resolveAuthorizedLegalEntities({ principalId, savedLegalEntityId: alpha.legalEntityId, tenantId }),
        context(),
        {
          ...access({}),
          legalEntities: () =>
            Effect.succeed([
              { decision: 'allowed' as const, key: beta.legalEntityId },
              { decision: 'denied' as const, key: alpha.legalEntityId },
            ]),
        },
      ),
    ).toEqual({ available: [beta], selected: beta, state: 'selected' });
  }),
);
