// oxlint-disable-next-line eslint/max-classes-per-file -- One owner-local Action error union keeps its tagged errors together; remove-when: tagged-error union is split into generated error modules.
import type { ActionHandlerContext } from '@app/core-runtime';
import { DateTime, Effect, Match, Schema } from 'effect';
import { GtinPersistenceUnavailable, gtinPersistenceForScope } from '../persistence/gtin-persistence.ts';
import type { GtinPersistenceOutcome } from '../persistence/gtin-persistence.ts';

export const gtinServicesForScope = (...args: Parameters<typeof gtinPersistenceForScope>) =>
  Effect.succeed(gtinPersistenceForScope(...args));
export type GtinServices = ReturnType<typeof gtinPersistenceForScope>;

class GtinActionConflict extends Schema.TaggedError<GtinActionConflict>()('GtinActionConflict', {
  code: Schema.Literal('gtin_action_conflict'),
  reason: Schema.String,
}) {}
export class GtinActionStale extends Schema.TaggedError<GtinActionStale>()('GtinActionStale', {
  actualRevision: Schema.Int,
  code: Schema.Literal('gtin_action_stale'),
}) {}
export class GtinActionInvalid extends Schema.TaggedError<GtinActionInvalid>()('GtinActionInvalid', {
  code: Schema.Literal('gtin_action_invalid'),
  reason: Schema.String,
}) {}
class GtinActionNotFound extends Schema.TaggedError<GtinActionNotFound>()('GtinActionNotFound', {
  code: Schema.Literal('gtin_action_not_found'),
  reason: Schema.String,
}) {}
export const GtinActionErrorSchema = Schema.Union([
  GtinActionConflict,
  GtinActionStale,
  GtinActionInvalid,
  GtinActionNotFound,
  GtinPersistenceUnavailable,
]);

export const gtinEffectiveAt = (value: string): Date => DateTime.toDateUtc(DateTime.makeUnsafe(value));

export const completeGtinChange = Effect.fn('GtinAction.completeChange')(function* completeGtinChange(
  outcome: GtinPersistenceOutcome,
  payload: { readonly attributionEvidenceRef: string; readonly code: string; readonly reason: string },
  context: ActionHandlerContext<Readonly<Record<string, never>>, GtinServices>,
) {
  const result = yield* Match.value(outcome).pipe(
    Match.tag('confirmed', ({ revision }) => Effect.succeed({ revision })),
    Match.tag('corrected', ({ revision }) => Effect.succeed({ revision })),
    Match.tag('retired', ({ revision }) => Effect.succeed({ revision })),
    Match.tag('unresolved', ({ revision }) => Effect.succeed({ revision })),
    Match.tag('invalid', ({ reason }) => Effect.fail(new GtinActionInvalid({ code: 'gtin_action_invalid', reason }))),
    Match.tag('not_found', () =>
      Effect.fail(
        new GtinActionNotFound({ code: 'gtin_action_not_found', reason: 'Exact GTIN attribution was not found' }),
      ),
    ),
    Match.tag('stale', ({ actualRevision }) =>
      Effect.fail(new GtinActionStale({ actualRevision, code: 'gtin_action_stale' })),
    ),
    Match.exhaustive,
  );
  yield* context.recordAuditEvidence({ evidenceRefs: [payload.attributionEvidenceRef], reason: payload.reason });
  yield* context.recordDataAccess({
    accessKind: 'read',
    queryHash: `catalog-gtin:${payload.code}`,
    resultCount: 1,
    servingModuleKey: 'commerce.catalog',
    targetModuleKey: 'commerce.catalog',
    targetResourceId: payload.code,
    targetResourceType: 'commerce.catalog.gtin',
  });
  return result;
});
