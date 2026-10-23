import { ContextAccess, LegalEntityContext } from '@app/core-runtime';
import type { LegalEntityContextUnavailableError, SafeLegalEntity } from '@app/core-runtime';
import { Effect, Schema } from 'effect';

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

export const resolveAuthorizedLegalEntities = Effect.fn('LegalEntitySelection.resolveAuthorizedLegalEntities')(
  function* resolveAuthorizedLegalEntitiesEffect(input: {
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
    const candidates = yield* legalEntityContext.listActiveForTenant(input.tenantId).pipe(
      observeGatewayPhase('legal-entity-sql'),
      Effect.mapError((failureCause) => new LegalEntitySelectionUnavailableErrorValue({ failureCause })),
    );
    const decisions = yield* contextAccess
      .legalEntities({
        legalEntityIds: candidates.map(({ legalEntityId }) => legalEntityId),
        principalId: input.principalId,
        tenantId: input.tenantId,
      })
      .pipe(observeGatewayPhase('legal-entity-spicedb'));
    if (decisions.length !== candidates.length || decisions.some(({ decision }) => decision === 'unavailable')) {
      return yield* new LegalEntitySelectionUnavailableErrorValue();
    }
    const byId = new Map(candidates.map((candidate) => [candidate.legalEntityId, candidate]));
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
        : available.find(({ legalEntityId }) => legalEntityId === input.savedLegalEntityId);
    if (saved !== undefined) {
      return { available, selected: saved, state: 'selected' } as const;
    }
    // Sales demo: a person in several companies starts in the first one (lowest id, e.g. Obchodní firma 0020)
    // instead of an empty "select a legal entity" page; the switcher still offers the others.
    if (available.length > 1 && input.tenantId !== '70000000-0000-4000-8000-000000000020') {
      return { available, state: 'selection_required' } as const;
    }
    const [first] = available.toSorted((left, right) => left.legalEntityId.localeCompare(right.legalEntityId));
    return first === undefined
      ? ({ available, state: 'selection_required' } as const)
      : ({ available, selected: first, state: 'selected' } as const);
  },
);

export const validateAuthorizedLegalEntity = Effect.fn('LegalEntitySelection.validateAuthorizedLegalEntity')(
  function* validateAuthorizedLegalEntityEffect(input: {
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
    const failForbiddenSelection = () => Effect.fail(new LegalEntitySelectionForbiddenErrorValue());
    const failUnavailableSelection = (failureCause: LegalEntityContextUnavailableError) =>
      Effect.fail(new LegalEntitySelectionUnavailableErrorValue({ failureCause }));
    const candidate = yield* legalEntityContext.validateSelection(input.tenantId, input.legalEntityId).pipe(
      observeGatewayPhase('legal-entity-sql'),
      Effect.catchTags({
        LegalEntityContextAmbiguousError: failForbiddenSelection,
        LegalEntityContextInactiveError: failForbiddenSelection,
        LegalEntityContextInvalidError: failForbiddenSelection,
        LegalEntityContextMissingError: failForbiddenSelection,
        LegalEntityContextUnavailableError: failUnavailableSelection,
      }),
    );
    const [decision, ...unexpected] = yield* contextAccess
      .legalEntities({
        legalEntityIds: [candidate.legalEntityId],
        principalId: input.principalId,
        tenantId: input.tenantId,
      })
      .pipe(observeGatewayPhase('legal-entity-spicedb'));
    if (unexpected.length > 0 || decision === undefined || decision.decision === 'unavailable') {
      return yield* new LegalEntitySelectionUnavailableErrorValue();
    }
    if (decision.key !== candidate.legalEntityId || decision.decision !== 'allowed') {
      return yield* new LegalEntitySelectionForbiddenErrorValue();
    }
    return candidate;
  },
);
