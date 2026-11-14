import type { AccessFieldGroup, AnyReadRegistration, LegalEntityScope, OperationalScope } from '@app/core-runtime';
import { AccessDecisionGate } from '@app/core-runtime/access/enforcement';
import type { GateCarrier } from '@app/core-runtime/access/enforcement';
import { ListAccessConditionSchema, evaluateListAccessPredicate } from '@app/core-runtime/access/decision/list-access';
import type { ListAccessCondition, ListAccessPredicate } from '@app/core-runtime/access/decision/list-access';
import { RecordKeySchema } from '@app/core-runtime/access/ids';
import { DateTime, Effect, Match, Option, Schema } from 'effect';

import { searchUnavailable } from '../../shared/domain/search-projection-error.ts';

/** Retains the opaque original registration while exposing only the metadata this owner needs. */
export interface ParentContractRead extends AnyReadRegistration {
  readonly descriptor: AnyReadRegistration['descriptor'] &
    GateCarrier & {
      readonly accessFieldGroups?: readonly AccessFieldGroup[];
      readonly legalEntityScope: LegalEntityScope;
    };
}

export const SearchListPredicateSchema = Schema.Struct({
  groups: Schema.Array(
    Schema.Struct({
      clauses: Schema.NonEmptyArray(Schema.Struct({ conditions: Schema.NonEmptyArray(ListAccessConditionSchema) })),
    }),
  ),
});

const supportedSearchCondition = (condition: ListAccessCondition): boolean =>
  Match.value(condition).pipe(
    Match.tag('AllInScope', 'RecordKeyIn', () => true),
    Match.orElse(() => false),
  );

/**
 * Legal's approved search evidence contains record identity, not assignees, teams, amounts or
 * entrustment. An unsupported dimension is unavailable rather than silently widened or filtered
 * using invented owner facts. Every supported clause retains the canonical AND/OR semantics.
 */
export const requireSearchPredicate = Effect.fn('AgreementsSearch.requirePredicate')(function* requirePredicate(
  predicate: ListAccessPredicate | undefined,
) {
  const decoded = yield* Schema.decodeUnknownEffect(SearchListPredicateSchema, {
    onExcessProperty: 'error',
  })(predicate).pipe(Effect.mapError(searchUnavailable));
  const supported = decoded.groups.every((group) =>
    group.clauses.every((clause) => clause.conditions.every(supportedSearchCondition)),
  );
  return supported ? decoded : yield* searchUnavailable();
});

export const requireSearchFields = Effect.fn('AgreementsSearch.requireFields')(function* requireFields(
  deniedFieldPaths: readonly (readonly string[])[] | undefined,
) {
  const paths = yield* Schema.decodeUnknownEffect(Schema.Array(Schema.Array(Schema.String)))(deniedFieldPaths).pipe(
    Effect.mapError(searchUnavailable),
  );
  // No denied private field may participate in current title/text matching or relevance.
  if (paths.length !== 0) {
    return yield* searchUnavailable();
  }
  return yield* Effect.void;
});

export const searchRecordVisible = (predicate: ListAccessPredicate, recordKey: string): boolean =>
  evaluateListAccessPredicate(predicate, { recordKey: RecordKeySchema.make(recordKey), teamIds: [] });

const parentResolutionSchema = Schema.Struct({
  decision: Schema.Struct({ outcome: Schema.Literals(['ALLOWED', 'DENIED', 'NEEDS_APPROVAL', 'UNAVAILABLE']) }),
  predicate: Schema.optionalKey(SearchListPredicateSchema),
});

/**
 * The exact original published contract search Read, not a copy or a document capability.
 * Called after owner snapshot commit, so canonical authority/evidence IO holds no owner connection.
 */
export const loadParentContractPredicate = Effect.fn('AgreementsSearch.parentContracts')(function* parentContracts(
  scope: OperationalScope,
  parentRead: ParentContractRead,
) {
  const { accessDeclaration, accessFieldGroups, entrypoint, legalEntityScope } = parentRead.descriptor;
  if (
    entrypoint.authorization.kind !== 'protected' ||
    accessDeclaration === undefined ||
    accessDeclaration.kind !== 'read' ||
    accessDeclaration.selectors.length === 0 ||
    (accessFieldGroups !== undefined && accessFieldGroups.length !== 0)
  ) {
    return yield* searchUnavailable();
  }
  const gate = yield* AccessDecisionGate;
  const answer = yield* gate.list({
    carrier: { accessDeclaration },
    legalEntityScope,
    now: yield* DateTime.nowAsDate,
    scope,
  });
  const resolution = yield* Schema.decodeUnknownEffect(parentResolutionSchema)(answer).pipe(
    Effect.mapError(searchUnavailable),
  );
  return yield* Match.value(resolution.decision.outcome).pipe(
    Match.when('ALLOWED', () => requireSearchPredicate(answer.predicate).pipe(Effect.map(Option.some))),
    Match.when('DENIED', () => Effect.succeed(Option.none<ListAccessPredicate>())),
    Match.when('NEEDS_APPROVAL', () => Effect.succeed(Option.none<ListAccessPredicate>())),
    Match.when('UNAVAILABLE', () => Effect.fail(searchUnavailable())),
    Match.exhaustive,
  );
});
