/* eslint-disable max-classes-per-file -- The selection boundary exposes two distinct typed failure channels. */
import type {
  ContextAccessService,
  LegalEntityContextError,
  LegalEntityContextService,
  SafeLegalEntity,
} from '@app/core-runtime';
import { Effect, Schema } from 'effect';

export class LegalEntitySelectionUnavailableError extends Schema.TaggedError<LegalEntitySelectionUnavailableError>()(
  'LegalEntitySelectionUnavailableError',
  {},
) {}

export class LegalEntitySelectionForbiddenError extends Schema.TaggedError<LegalEntitySelectionForbiddenError>()(
  'LegalEntitySelectionForbiddenError',
  {},
) {}

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

const contextFailure = (_error: LegalEntityContextError): LegalEntitySelectionUnavailableError =>
  new LegalEntitySelectionUnavailableError();

export const resolveAuthorizedLegalEntities = (
  legalEntityContext: LegalEntityContextService,
  contextAccess: ContextAccessService,
  input: {
    readonly principalId: string;
    readonly savedLegalEntityId?: string;
    readonly tenantId: string;
  },
): Effect.Effect<LegalEntitySelectionResolution, LegalEntitySelectionUnavailableError> =>
  Effect.gen(function* resolveAuthorizedLegalEntitiesEffect() {
    const candidates = yield* legalEntityContext
      .listActiveForTenant(input.tenantId)
      .pipe(Effect.mapError(contextFailure));
    const decisions = yield* contextAccess.legalEntities({
      legalEntityIds: candidates.map(({ legalEntityId }) => legalEntityId),
      principalId: input.principalId,
      tenantId: input.tenantId,
    });
    if (
      decisions.length !== candidates.length ||
      decisions.some(({ decision }) => decision === 'unavailable')
    ) {
      return yield* new LegalEntitySelectionUnavailableError();
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
    const only = available.length === 1 ? available[0] : undefined;
    return only === undefined
      ? ({ available, state: 'selection_required' } as const)
      : ({ available, selected: only, state: 'selected' } as const);
  });

export const validateAuthorizedLegalEntity = (
  legalEntityContext: LegalEntityContextService,
  contextAccess: ContextAccessService,
  input: {
    readonly legalEntityId: string;
    readonly principalId: string;
    readonly tenantId: string;
  },
): Effect.Effect<
  SafeLegalEntity,
  LegalEntitySelectionForbiddenError | LegalEntitySelectionUnavailableError
> =>
  Effect.gen(function* validateAuthorizedLegalEntityEffect() {
    const candidate = yield* legalEntityContext
      .validateSelection(input.tenantId, input.legalEntityId)
      .pipe(
        Effect.mapError((error) =>
          error._tag === 'LegalEntityContextUnavailableError'
            ? new LegalEntitySelectionUnavailableError()
            : new LegalEntitySelectionForbiddenError(),
        ),
      );
    const [decision, ...unexpected] = yield* contextAccess.legalEntities({
      legalEntityIds: [candidate.legalEntityId],
      principalId: input.principalId,
      tenantId: input.tenantId,
    });
    if (unexpected.length > 0 || decision === undefined || decision.decision === 'unavailable') {
      return yield* new LegalEntitySelectionUnavailableError();
    }
    if (decision.key !== candidate.legalEntityId || decision.decision !== 'allowed') {
      return yield* new LegalEntitySelectionForbiddenError();
    }
    return candidate;
  });
