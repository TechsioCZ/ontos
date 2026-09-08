import { ContextAccess, LegalEntityContext } from '@app/core-runtime';
import type {
  LegalEntityContextUnavailableError,
  SafeLegalEntity,
} from '@app/core-runtime';
import { Effect, Schema } from 'effect';

const legalEntitySelectionUnavailableFields = {
  failureCause: Schema.optionalKey(Schema.Defect()),
};
const LegalEntitySelectionUnavailableErrorValue = Schema.TaggedError<unknown>()(
  'LegalEntitySelectionUnavailableError',
  legalEntitySelectionUnavailableFields
);
export type LegalEntitySelectionUnavailableError = InstanceType<
  typeof LegalEntitySelectionUnavailableErrorValue
>;
export { LegalEntitySelectionUnavailableErrorValue as LegalEntitySelectionUnavailableError };

const LegalEntitySelectionForbiddenErrorValue = Schema.TaggedError<unknown>()(
  'LegalEntitySelectionForbiddenError',
  {}
);
export type LegalEntitySelectionForbiddenError = InstanceType<
  typeof LegalEntitySelectionForbiddenErrorValue
>;
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

export const resolveAuthorizedLegalEntities = Effect.fn(
  'LegalEntitySelection.resolveAuthorizedLegalEntities'
)(function* resolveAuthorizedLegalEntitiesEffect(input: {
  readonly principalId: string;
  readonly savedLegalEntityId?: string;
  readonly tenantId: string;
}): Effect.fn.Return<
  LegalEntitySelectionResolution,
  LegalEntitySelectionUnavailableError,
  ContextAccess | LegalEntityContext
> {
  const legalEntityContext = yield* LegalEntityContext;
  const contextAccess = yield* ContextAccess;
  const candidates = yield* legalEntityContext
    .listActiveForTenant(input.tenantId)
    .pipe(
      Effect.mapError(
        (failureCause) =>
          new LegalEntitySelectionUnavailableErrorValue({ failureCause })
      )
    );
  const decisions = yield* contextAccess.legalEntities({
    legalEntityIds: candidates.map(({ legalEntityId }) => legalEntityId),
    principalId: input.principalId,
    tenantId: input.tenantId,
  });
  if (
    decisions.length !== candidates.length ||
    decisions.some(({ decision }) => decision === 'unavailable')
  ) {
    return yield* new LegalEntitySelectionUnavailableErrorValue();
  }
  const byId = new Map(
    candidates.map((candidate) => [candidate.legalEntityId, candidate])
  );
  const available = decisions.flatMap(({ decision, key }) => {
    const candidate = byId.get(key);
    return decision === 'allowed' && candidate !== undefined ? [candidate] : [];
  });
  if (available.length === 0) {
    return { available: [], state: 'access_blocked' } as const;
  }
  const saved =
    input.savedLegalEntityId === undefined
      ? undefined
      : available.find(
          ({ legalEntityId }) => legalEntityId === input.savedLegalEntityId
        );
  if (saved !== undefined) {
    return { available, selected: saved, state: 'selected' } as const;
  }
  const only = available.length === 1 ? available[0] : undefined;
  return only === undefined
    ? ({ available, state: 'selection_required' } as const)
    : ({ available, selected: only, state: 'selected' } as const);
});

export const validateAuthorizedLegalEntity = Effect.fn(
  'LegalEntitySelection.validateAuthorizedLegalEntity'
)(function* validateAuthorizedLegalEntityEffect(input: {
  readonly legalEntityId: string;
  readonly principalId: string;
  readonly tenantId: string;
}): Effect.fn.Return<
  SafeLegalEntity,
  LegalEntitySelectionForbiddenError | LegalEntitySelectionUnavailableError,
  ContextAccess | LegalEntityContext
> {
  const legalEntityContext = yield* LegalEntityContext;
  const contextAccess = yield* ContextAccess;
  const failForbiddenSelection = () =>
    Effect.fail(new LegalEntitySelectionForbiddenErrorValue());
  const failUnavailableSelection = (
    failureCause: LegalEntityContextUnavailableError
  ) =>
    Effect.fail(
      new LegalEntitySelectionUnavailableErrorValue({ failureCause })
    );
  const candidate = yield* legalEntityContext
    .validateSelection(input.tenantId, input.legalEntityId)
    .pipe(
      Effect.catchTags({
        LegalEntityContextAmbiguousError: failForbiddenSelection,
        LegalEntityContextInactiveError: failForbiddenSelection,
        LegalEntityContextInvalidError: failForbiddenSelection,
        LegalEntityContextMissingError: failForbiddenSelection,
        LegalEntityContextUnavailableError: failUnavailableSelection,
      })
    );
  const [decision, ...unexpected] = yield* contextAccess.legalEntities({
    legalEntityIds: [candidate.legalEntityId],
    principalId: input.principalId,
    tenantId: input.tenantId,
  });
  if (
    unexpected.length > 0 ||
    decision === undefined ||
    decision.decision === 'unavailable'
  ) {
    return yield* new LegalEntitySelectionUnavailableErrorValue();
  }
  if (
    decision.key !== candidate.legalEntityId ||
    decision.decision !== 'allowed'
  ) {
    return yield* new LegalEntitySelectionForbiddenErrorValue();
  }
  return candidate;
});
