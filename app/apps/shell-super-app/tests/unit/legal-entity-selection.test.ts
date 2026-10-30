import {
  ContextAccess,
  LegalEntityContext,
  LegalEntityContextUnavailableError,
  classifyActiveLegalEntities,
} from '@app/core-runtime';
import type { ContextAccessService, LegalEntityContextService, SafeLegalEntity } from '@app/core-runtime';
import { Effect, Layer, Predicate } from 'effect';
import { expect, it } from 'effect-rstest';

import {
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
