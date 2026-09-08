import { ContextAccess, LegalEntityContext } from '@app/core-runtime';
import type {
  ContextAccessService,
  LegalEntityContextService,
} from '@app/core-runtime';
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

const context = (
  entities = [alpha, beta] as const
): LegalEntityContextService => ({
  listActiveForTenant: () => Effect.succeed(entities),
  validateSelection: (_tenantId, legalEntityId) => {
    const selected = entities.find(
      (entity) => entity.legalEntityId === legalEntityId
    );
    return selected === undefined
      ? Effect.die('missing fixture entity')
      : Effect.succeed(selected);
  },
});

const access = (
  decisions: Readonly<Record<string, 'allowed' | 'denied' | 'unavailable'>>
): ContextAccessService => ({
  legalEntities: ({ legalEntityIds }) =>
    Effect.succeed(
      legalEntityIds.map((key) => ({
        decision: decisions[key] ?? 'denied',
        key,
      }))
    ),
  modules: ({ moduleIds }) =>
    Effect.succeed(
      moduleIds.map((key) => ({ decision: 'denied' as const, key }))
    ),
  resources: () => Effect.succeed([]),
  tenants: ({ tenantIds }) =>
    Effect.succeed(
      tenantIds.map((key) => ({ decision: 'denied' as const, key }))
    ),
});

const provideSelectionServices = <Success, Failure>(
  effect: Effect.Effect<Success, Failure, ContextAccess | LegalEntityContext>,
  legalEntityContext: LegalEntityContextService,
  contextAccess: ContextAccessService
): Effect.Effect<Success, Failure> =>
  effect.pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(LegalEntityContext, legalEntityContext),
        Layer.succeed(ContextAccess, contextAccess)
      )
    )
  );

it.effect(
  'auto-selects the only authorized entity and preserves an exact saved choice',
  () =>
    Effect.gen(function* verifyCase1() {
      const only = yield* provideSelectionServices(
        resolveAuthorizedLegalEntities({ principalId, tenantId }),
        context(),
        access({ [alpha.legalEntityId]: 'allowed' })
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
        })
      );
      expect(saved).toEqual({
        available: [alpha, beta],
        selected: beta,
        state: 'selected',
      });
    })
);

it.effect(
  'requires a choice for several entities and blocks zero definite grants',
  () =>
    Effect.gen(function* verifyCase2() {
      expect(
        yield* provideSelectionServices(
          resolveAuthorizedLegalEntities({ principalId, tenantId }),
          context(),
          access({
            [alpha.legalEntityId]: 'allowed',
            [beta.legalEntityId]: 'allowed',
          })
        )
      ).toEqual({ available: [alpha, beta], state: 'selection_required' });
      expect(
        yield* provideSelectionServices(
          resolveAuthorizedLegalEntities({ principalId, tenantId }),
          context(),
          access({})
        )
      ).toEqual({ available: [], state: 'access_blocked' });
    })
);

it.effect(
  'fails closed for authorization uncertainty and validates a switch independently',
  () =>
    Effect.gen(function* verifyCase3() {
      const unavailable = yield* Effect.flip(
        provideSelectionServices(
          resolveAuthorizedLegalEntities({ principalId, tenantId }),
          context(),
          access({ [alpha.legalEntityId]: 'unavailable' })
        )
      );
      expect(
        Predicate.isTagged(unavailable, 'LegalEntitySelectionUnavailableError')
      ).toBe(true);
      expect(
        yield* provideSelectionServices(
          validateAuthorizedLegalEntity({
            legalEntityId: beta.legalEntityId,
            principalId,
            tenantId,
          }),
          context(),
          access({ [beta.legalEntityId]: 'allowed' })
        )
      ).toEqual(beta);
    })
);
