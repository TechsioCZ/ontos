import type { ActionHandlerContext } from '@app/core-runtime';
import { DateTime, Effect, Match } from 'effect';

import { SetCompositionActionError } from '../../shared/actions/set-composition-contract.ts';
import type { SetCompositionMutationPayload } from '../../shared/actions/set-composition-contract.ts';
import type {
  PublishSetCompositionInput,
  SetCompositionBasis,
  SetCompositionPersistence,
} from '../persistence/set-composition-persistence.ts';
import { setCompositionPersistenceForScope } from '../persistence/set-composition-persistence.ts';
import { setCompositionComponentCurrentBasisForScope } from '../persistence/set-composition-component-current-basis.ts';
import { cartOpenSelectionPopulationFromEnvironment } from '../../shared/domain/catalog-open-selection-population.ts';
import { setCompositionSelectionImpactForScope } from '../persistence/catalog-selection-change-impact.ts';

type ScopedTransaction = Parameters<typeof setCompositionPersistenceForScope>[0];
type Scope = Parameters<typeof setCompositionPersistenceForScope>[1];
type Context = Pick<
  ActionHandlerContext<Readonly<Record<string, never>>, SetCompositionPersistence>,
  'actionInvocationId' | 'recordDataAccess' | 'scope' | 'services'
>;

export const setCompositionBasisForScope = (transaction: ScopedTransaction, scope: Scope): SetCompositionBasis => {
  const current = setCompositionComponentCurrentBasisForScope(transaction, scope);
  return {
    verify: ({ at, revision }) => current.read(revision, at).pipe(Effect.map((result) => result.status === 'VALID')),
  };
};

export const setCompositionPersistenceServiceFactory = Effect.fn('SetCompositionActionSupport.makePersistence')(
  function* makeSetCompositionPersistence(transaction: ScopedTransaction, scope: Scope) {
    const configuredPopulation = yield* cartOpenSelectionPopulationFromEnvironment;
    return setCompositionPersistenceForScope(
      transaction,
      scope,
      setCompositionBasisForScope(transaction, scope),
      setCompositionSelectionImpactForScope(transaction, scope, configuredPopulation),
    );
  },
);

export const handleSetCompositionMutation = Effect.fn('SetCompositionAction.handleMutation')(
  function* handleSetCompositionMutation(
    kind: 'CREATE' | 'REVISE',
    payload: SetCompositionMutationPayload,
    context: Context,
  ) {
    const { revision } = payload;
    if (
      (kind === 'CREATE') !== (payload.expectedRevision === 0) ||
      revision.productRef.tenantId !== context.scope.tenantId ||
      revision.variantRef.tenantId !== context.scope.tenantId ||
      revision.reference.resourceRef.tenantId !== context.scope.tenantId
    ) {
      return yield* new SetCompositionActionError({
        code: 'set_composition_invalid',
        reason: 'Set mutation type or Tenant identity is invalid',
      });
    }
    const publishInput: PublishSetCompositionInput = {
      actingPrincipalId: context.scope.principalId,
      actionInvocationId: context.actionInvocationId,
      effectiveFrom: DateTime.toDateUtc(DateTime.makeUnsafe(payload.effectiveFrom)),
      expectedRevision: payload.expectedRevision,
      lifecycleState: payload.lifecycleState,
      revision,
    };
    if (payload.effectiveTo !== undefined) {
      Object.assign(publishInput, { effectiveTo: DateTime.toDateUtc(DateTime.makeUnsafe(payload.effectiveTo)) });
    }
    const outcome = yield* context.services.publish(publishInput).pipe(
      Effect.mapError((cause) => {
        const failure = new SetCompositionActionError({
          code: 'set_composition_unavailable',
          reason: 'Authoritative Set Current basis or persistence is unavailable',
        });
        Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
        return failure;
      }),
    );
    const published = yield* Match.value(outcome).pipe(
      Match.tag('published', () => Effect.succeed(revision.reference)),
      Match.tag('invalid', ({ reason }) =>
        Effect.fail(new SetCompositionActionError({ code: 'set_composition_invalid', reason })),
      ),
      Match.tag('not_found', () =>
        Effect.fail(new SetCompositionActionError({ code: 'set_composition_not_found', reason: 'Set not found' })),
      ),
      Match.tag('stale', () =>
        Effect.fail(new SetCompositionActionError({ code: 'set_composition_stale', reason: 'Set revision changed' })),
      ),
      Match.exhaustive,
    );
    yield* context.recordDataAccess({
      accessKind: 'read',
      queryHash: `catalog-set-composition:${revision.reference.resourceRef.resourceId}`,
      resultCount: 1,
      servingModuleKey: 'commerce.catalog',
      targetModuleKey: 'commerce.catalog',
      targetResourceId: revision.reference.resourceRef.resourceId,
      targetResourceType: 'commerce.catalog.set-composition',
    });
    return { revision: published };
  },
);
