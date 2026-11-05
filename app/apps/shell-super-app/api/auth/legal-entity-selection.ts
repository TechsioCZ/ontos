import { LegalEntityContext } from '@app/core-runtime';
import type { LegalEntityContextUnavailableError, OperationalScope, SafeLegalEntity } from '@app/core-runtime';
import { AccessDecisionGate } from '@app/core-runtime/access/enforcement';
import { DateTime, Effect, Schema } from 'effect';

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

/**
 * The companies this person may select, as the one access gate answers it (O28, CUTOVER-PLAN §3.2):
 * `access_legal_entity#select` in one engine snapshot, never a per-company permission loop. An
 * unreadable authority stays a retryable failure, so it can never narrow into "no companies".
 */
const selectableLegalEntityIds = Effect.fn('LegalEntitySelection.selectableLegalEntityIds')(
  function* selectableLegalEntityIdsEffect(scope: OperationalScope) {
    const access = yield* AccessDecisionGate;
    const now = yield* DateTime.nowAsDate;
    const selectable = yield* access.selectableLegalEntities({ now, scope });
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
        legalEntityContext
          .listActiveForTenant(input.scope.tenantId)
          .pipe(Effect.mapError((failureCause) => new LegalEntitySelectionUnavailableErrorValue({ failureCause }))),
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
    const only = available.length === 1 ? available[0] : undefined;
    return only === undefined
      ? ({ available, state: 'selection_required' } as const)
      : ({ available, selected: only, state: 'selected' } as const);
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
