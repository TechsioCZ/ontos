import { ContextAccess, LegalEntityContext } from '@app/core-runtime';
import type { LegalEntityContextUnavailableError, OperationalScope, SafeLegalEntity } from '@app/core-runtime';
import { AccessDecisionGate } from '@app/core-runtime/access/enforcement';
import { DateTime, Effect, Schema } from 'effect';

import { observeGatewayPhase } from './gateway-timing.ts';

const legalEntitySelectionUnavailableFields = {
  failureCause: Schema.optionalKey(Schema.Defect()),
};
const LegalEntitySelectionUnavailableErrorValue = Schema.TaggedError<unknown>()(
  'LegalEntitySelectionUnavailableError',
  legalEntitySelectionUnavailableFields,
);
export type LegalEntitySelectionUnavailableError = InstanceType<typeof LegalEntitySelectionUnavailableErrorValue>;
export { LegalEntitySelectionUnavailableErrorValue as LegalEntitySelectionUnavailableError };

const LegalEntitySelectionForbiddenErrorValue = Schema.TaggedError<unknown>()('LegalEntitySelectionForbiddenError', {});
export type LegalEntitySelectionForbiddenError = InstanceType<typeof LegalEntitySelectionForbiddenErrorValue>;
export { LegalEntitySelectionForbiddenErrorValue as LegalEntitySelectionForbiddenError };

export type LegalEntitySelectionResolution =
  | {
      readonly available: readonly SafeLegalEntity[];
      readonly selected: SafeLegalEntity;
      readonly state: 'selected';
    }
  | {
      readonly available: readonly SafeLegalEntity[];
      readonly state: 'selection_required';
    }
  | {
      readonly available: readonly [];
      readonly state: 'access_blocked';
    };

/** Context selection is a graph capability, not a grant of any tenant Action. */
export const canSelectTenantContext = Effect.fn('ContextSelection.canSelectTenantContext')(
  function* canSelectTenantContextEffect(input: {
    readonly principalId: string;
    readonly tenantId: string;
  }): Effect.fn.Return<boolean, LegalEntitySelectionUnavailableError, ContextAccess> {
    const access = yield* ContextAccess;
    const [decision, ...unexpected] = yield* access.tenants({
      permission: 'select_context',
      principalId: input.principalId,
      tenantIds: [input.tenantId],
    });
    if (
      unexpected.length > 0 ||
      decision === undefined ||
      decision.key !== input.tenantId ||
      decision.decision === 'unavailable'
    ) {
      return yield* new LegalEntitySelectionUnavailableErrorValue();
    }
    return decision.decision === 'allowed';
  },
);

/**
 * The companies this person may select, as the one access gate answers it (O28, CUTOVER-PLAN §3.2):
 * `access_legal_entity#select` in one engine snapshot, never a per-company permission loop. An
 * unreadable authority stays a retryable failure, so it can never narrow into "no companies".
 */
const selectableLegalEntityIds = Effect.fn('LegalEntitySelection.selectableLegalEntityIds')(
  function* selectableLegalEntityIdsEffect(scope: OperationalScope) {
    const access = yield* AccessDecisionGate;
    const now = yield* DateTime.nowAsDate;
    const selectable = yield* access
      .selectableLegalEntities({ now, scope })
      .pipe(observeGatewayPhase('legal-entity-spicedb'));
    return new Set<string>(selectable);
  },
);

export const resolveAuthorizedLegalEntities = Effect.fn('LegalEntitySelection.resolveAuthorizedLegalEntities')(
  function* resolveAuthorizedLegalEntitiesEffect(input: {
    readonly savedLegalEntityId?: string;
    readonly scope: OperationalScope;
  }): Effect.fn.Return<
    LegalEntitySelectionResolution,
    LegalEntitySelectionUnavailableError,
    LegalEntityContext | AccessDecisionGate
  > {
    const legalEntityContext = yield* LegalEntityContext;
    const [candidates, selectable] = yield* Effect.all(
      [
        legalEntityContext.listActiveForTenant(input.scope.tenantId).pipe(
          observeGatewayPhase('legal-entity-sql'),
          Effect.mapError((failureCause) => new LegalEntitySelectionUnavailableErrorValue({ failureCause })),
        ),
        selectableLegalEntityIds(input.scope).pipe(
          Effect.mapError((failureCause) => new LegalEntitySelectionUnavailableErrorValue({ failureCause })),
        ),
      ] as const,
      { concurrency: 2 },
    );
    const byId = new Map(candidates.map((candidate) => [candidate.legalEntityId, candidate]));
    if (byId.size !== candidates.length) {
      return yield* new LegalEntitySelectionUnavailableErrorValue();
    }
    const available = candidates.filter(({ legalEntityId }) => selectable.has(legalEntityId));
    if (available.length === 0) {
      return { available: [], state: 'access_blocked' } as const;
    }
    const saved =
      input.savedLegalEntityId === undefined
        ? undefined
        : available.find(({ legalEntityId }) => legalEntityId === input.savedLegalEntityId);
    if (saved !== undefined) {
      return { available, selected: saved, state: 'selected' } as const;
    }
    // Sales demo: a person in several companies starts in the first one (lowest id, e.g. Obchodní firma 0020)
    // instead of an empty "select a legal entity" page; the switcher still offers the others.
    if (available.length > 1 && input.scope.tenantId !== '70000000-0000-4000-8000-000000000020') {
      return { available, state: 'selection_required' } as const;
    }
    const [first] = available.toSorted((left, right) => left.legalEntityId.localeCompare(right.legalEntityId));
    return first === undefined
      ? ({ available, state: 'selection_required' } as const)
      : ({ available, selected: first, state: 'selected' } as const);
  },
);

const failForbiddenSelection = () => Effect.fail(new LegalEntitySelectionForbiddenErrorValue());

const failUnavailableSelection = (failureCause: LegalEntityContextUnavailableError) =>
  Effect.fail(new LegalEntitySelectionUnavailableErrorValue({ failureCause }));

export const validateAuthorizedLegalEntity = Effect.fn('LegalEntitySelection.validateAuthorizedLegalEntity')(
  function* validateAuthorizedLegalEntityEffect(input: {
    readonly legalEntityId: string;
    readonly scope: OperationalScope;
  }): Effect.fn.Return<
    SafeLegalEntity,
    LegalEntitySelectionForbiddenError | LegalEntitySelectionUnavailableError,
    LegalEntityContext | AccessDecisionGate
  > {
    const legalEntityContext = yield* LegalEntityContext;
    const candidate = yield* legalEntityContext.validateSelection(input.scope.tenantId, input.legalEntityId).pipe(
      observeGatewayPhase('legal-entity-sql'),
      Effect.catchTags({
        LegalEntityContextAmbiguousError: failForbiddenSelection,
        LegalEntityContextInactiveError: failForbiddenSelection,
        LegalEntityContextInvalidError: failForbiddenSelection,
        LegalEntityContextMissingError: failForbiddenSelection,
        LegalEntityContextUnavailableError: failUnavailableSelection,
      }),
    );
    const selectable = yield* selectableLegalEntityIds(input.scope).pipe(
      Effect.mapError((failureCause) => new LegalEntitySelectionUnavailableErrorValue({ failureCause })),
    );
    if (!selectable.has(candidate.legalEntityId)) {
      return yield* new LegalEntitySelectionForbiddenErrorValue();
    }
    return candidate;
  },
);
