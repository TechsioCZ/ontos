import type { ScopedRoutineInvocationError, ScopedRoutineInvoker } from '@app/core-runtime';
import { ReserveMarketRetirementPayloadSchema } from '@app/customer-market-retirement-contracts/reserve-market-retirement';
import type { ReserveMarketRetirementPayload } from '@app/customer-market-retirement-contracts/reserve-market-retirement';
import { DateTime, Effect, Schema } from 'effect';
import type { Option } from 'effect';

import {
  MarketRetirementFailureReasonSchema,
  MarketRetirementIntentIdSchema,
  MarketRetirementLegalEntityIdSchema,
  MarketRetirementStageSchema,
} from '../../shared/domain/market-retirement-intent.ts';
import type {
  MarketRetirementFailureReason,
  MarketRetirementPendingStage,
} from '../../shared/domain/market-retirement-intent.ts';
import { MarketRetirementImpactAssessmentSchema } from '../../shared/domain/market-retirement-impact.ts';
import type {
  MarketRetirementImpactAssessment,
  ReservedMarketRetirementImpactAssessment,
} from '../../shared/domain/market-retirement-impact.ts';
import { MarketAdministrationPersistenceUnavailable } from './market-administration-persistence-unavailable.ts';
import {
  advanceMarketRetirementIntentRoutine,
  readMarketRetirementIntentRoutine,
  requestMarketRetirementRoutine,
} from './scoped-routine.ts';

const UuidSchema = Schema.String.check(Schema.isUUID());
const ActingPrincipalIdSchema = UuidSchema.pipe(
  Schema.brand('CommerceMarketRetirementPrincipalId'),
  Schema.decodeTo(UuidSchema),
);
const ActionInvocationIdSchema = UuidSchema.pipe(
  Schema.brand('CommerceMarketRetirementActionInvocationId'),
  Schema.decodeTo(UuidSchema),
);
const DefinitionRevisionIdSchema = UuidSchema.pipe(
  Schema.brand('CommerceMarketRetirementDefinitionRevisionId'),
  Schema.decodeTo(UuidSchema),
);
const MarketIdSchema = UuidSchema.pipe(Schema.brand('CommerceMarketRetirementMarketId'), Schema.decodeTo(UuidSchema));
const TenantIdSchema = UuidSchema.pipe(Schema.brand('CommerceMarketRetirementTenantId'), Schema.decodeTo(UuidSchema));
const PositiveRevisionSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

/** Owner-private snapshot of one durable retirement intent, exactly as the owner routines return it. */
export const MarketRetirementIntentSnapshotSchema = Schema.Struct({
  actingPrincipalId: ActingPrincipalIdSchema,
  actionInvocationId: ActionInvocationIdSchema,
  effectiveAt: Schema.DateTimeUtcFromString,
  expectedDefinitionRevisionId: DefinitionRevisionIdSchema,
  expectedRevision: PositiveRevisionSchema,
  failureReason: Schema.optionalKey(MarketRetirementFailureReasonSchema),
  intentId: MarketRetirementIntentIdSchema,
  legalEntityId: MarketRetirementLegalEntityIdSchema,
  marketId: MarketIdSchema,
  reason: Schema.String,
  /** The exact RESERVE request; replays with the stable idempotency key are byte-identical. */
  reservationRequest: Schema.optionalKey(ReserveMarketRetirementPayloadSchema),
  retiredDefinitionRevisionId: Schema.optionalKey(DefinitionRevisionIdSchema),
  retiredRevision: Schema.optionalKey(PositiveRevisionSchema),
  retirementImpactAssessment: Schema.optionalKey(MarketRetirementImpactAssessmentSchema),
  stage: MarketRetirementStageSchema,
  tenantId: TenantIdSchema,
  transitionChanged: Schema.optionalKey(Schema.Boolean),
});
export type MarketRetirementIntentSnapshot = typeof MarketRetirementIntentSnapshotSchema.Type;

export const MarketRetirementRequestOutcomeSchema = Schema.Union([
  Schema.TaggedStruct('requested', { intent: MarketRetirementIntentSnapshotSchema }),
  Schema.TaggedStruct('already_retired', {
    definitionRevisionId: DefinitionRevisionIdSchema,
    revision: PositiveRevisionSchema,
  }),
  Schema.TaggedStruct('retirement_in_progress', { intentId: MarketRetirementIntentIdSchema }),
  Schema.TaggedStruct('revision_conflict', { actualRevision: PositiveRevisionSchema }),
  Schema.TaggedStruct('invalid_lifecycle_transition', {}),
  Schema.TaggedStruct('not_found', {}),
  Schema.TaggedStruct('cross_tenant_reference', {}),
]);
export type MarketRetirementRequestOutcome = typeof MarketRetirementRequestOutcomeSchema.Type;

const AdvanceOutcomeSchema = Schema.Union([
  Schema.TaggedStruct('advanced', { intent: MarketRetirementIntentSnapshotSchema }),
  /** The stage already moved on (duplicate or stale attempt); nothing was written. */
  Schema.TaggedStruct('unchanged', { intent: MarketRetirementIntentSnapshotSchema }),
  Schema.TaggedStruct('invalid_transition', { intent: MarketRetirementIntentSnapshotSchema }),
  Schema.TaggedStruct('not_found', {}),
]);
export type MarketRetirementAdvanceOutcome = typeof AdvanceOutcomeSchema.Type;

export interface MarketRetirementRequestCommand {
  readonly actionInvocationId: string;
  readonly effectiveAt: DateTime.Utc;
  readonly expectedCurrentDefinitionRevisionId: string;
  readonly expectedRevision: number;
  readonly marketId: string;
  readonly principalId: string;
  readonly reason: string;
  readonly recordedAt: DateTime.Utc;
}

type ReserveRequest = Extract<ReserveMarketRetirementPayload, { readonly operation: 'RESERVE' }>;

/** One compare-and-set stage change. `expectedStage` is the stage the caller observed. */
export type MarketRetirementStageChange =
  | Readonly<{ expectedStage: 'COMMIT_PENDING'; operation: 'RECORD_COMPLETED' }>
  | Readonly<{
      expectedStage: Extract<MarketRetirementPendingStage, 'RELEASE_PENDING' | 'RESERVATION_REQUESTED' | 'REQUESTED'>;
      failureReason: MarketRetirementFailureReason;
      operation: 'RECORD_FAILED';
    }>
  | Readonly<{
      expectedStage: Extract<MarketRetirementPendingStage, 'RESERVATION_REQUESTED' | 'RESERVED'>;
      failureReason: MarketRetirementFailureReason;
      operation: 'RECORD_RELEASE_REQUIRED';
      retirementImpactAssessment: ReservedMarketRetirementImpactAssessment;
    }>
  | Readonly<{
      expectedStage: 'REQUESTED';
      operation: 'RECORD_RESERVATION_REQUEST';
      reservationRequest: ReserveRequest;
      retirementImpactAssessment: MarketRetirementImpactAssessment;
    }>
  | Readonly<{
      expectedStage: 'RESERVATION_REQUESTED';
      operation: 'RECORD_RESERVATION';
      retirementImpactAssessment: ReservedMarketRetirementImpactAssessment;
    }>
  | Readonly<{ expectedStage: 'RESERVED'; operation: 'TRANSITION' }>;

export type MarketRetirementAdvanceCommand = Readonly<{ intentId: string; recordedAt: DateTime.Utc }> &
  MarketRetirementStageChange;

export interface MarketRetirementIntentPersistence {
  readonly advance: (
    command: MarketRetirementAdvanceCommand,
  ) => Effect.Effect<MarketRetirementAdvanceOutcome, MarketAdministrationPersistenceUnavailable>;
  readonly read: (input: {
    readonly intentId: string;
    readonly marketId: string;
  }) => Effect.Effect<Option.Option<MarketRetirementIntentSnapshot>, MarketAdministrationPersistenceUnavailable>;
  readonly request: (
    command: MarketRetirementRequestCommand,
  ) => Effect.Effect<MarketRetirementRequestOutcome, MarketAdministrationPersistenceUnavailable>;
}

const unavailable = (cause: unknown): MarketAdministrationPersistenceUnavailable => {
  const failure = new MarketAdministrationPersistenceUnavailable({
    code: 'market_administration_persistence_unavailable',
    reason: 'Market retirement intent persistence is temporarily unavailable',
  });
  Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  return failure;
};

const payloads = (rows: readonly { readonly payload: unknown }[]) => rows.map(({ payload }) => payload);

const decodeOne = <A>(
  routineKey: string,
  rows: readonly unknown[],
  schema: Schema.Decoder<A>,
): Effect.Effect<A, MarketAdministrationPersistenceUnavailable> => {
  const [row] = rows;
  return row === undefined
    ? Effect.fail(unavailable({ reason: `The ${routineKey} routine returned no outcome` }))
    : Schema.decodeUnknownEffect(schema)(row).pipe(Effect.mapError(unavailable));
};

/** Encodes the owner-routine document: instants as canonical UTC strings, the RESERVE request by its contract. */
const encodeAdvance = Effect.fnUntraced(function* encodeAdvance(command: MarketRetirementAdvanceCommand) {
  const recorded = DateTime.formatIso(command.recordedAt);
  if (command.operation !== 'RECORD_RESERVATION_REQUEST') {
    return { ...command, recordedAt: recorded };
  }
  const reservationRequest = yield* Schema.encodeEffect(ReserveMarketRetirementPayloadSchema)(
    command.reservationRequest,
  ).pipe(Effect.mapError(unavailable));
  return { ...command, recordedAt: recorded, reservationRequest };
});

const invocationFailure = (cause: ScopedRoutineInvocationError) => unavailable(cause);

/** Owner routines over one verified Tenant/Legal Entity invoker: the Action transaction or a worker scope. */
export const marketRetirementIntentPersistenceForInvoker = (
  invoker: ScopedRoutineInvoker,
): MarketRetirementIntentPersistence => ({
  advance: (command) =>
    encodeAdvance(command).pipe(
      Effect.flatMap((document) =>
        invoker.invoke(advanceMarketRetirementIntentRoutine, [document]).pipe(Effect.mapError(invocationFailure)),
      ),
      Effect.flatMap((rows) =>
        decodeOne(advanceMarketRetirementIntentRoutine.routineKey, payloads(rows), AdvanceOutcomeSchema),
      ),
    ),
  read: (input) =>
    invoker.invoke(readMarketRetirementIntentRoutine, [input]).pipe(
      Effect.mapError(invocationFailure),
      Effect.flatMap((rows) =>
        rows.length === 0
          ? Effect.succeedNone
          : decodeOne(
              readMarketRetirementIntentRoutine.routineKey,
              payloads(rows),
              MarketRetirementIntentSnapshotSchema,
            ).pipe(Effect.asSome),
      ),
    ),
  request: (command) =>
    invoker
      .invoke(requestMarketRetirementRoutine, [
        {
          ...command,
          effectiveAt: DateTime.formatIso(command.effectiveAt),
          recordedAt: DateTime.formatIso(command.recordedAt),
        },
      ])
      .pipe(
        Effect.mapError(invocationFailure),
        Effect.flatMap((rows) =>
          decodeOne(requestMarketRetirementRoutine.routineKey, payloads(rows), MarketRetirementRequestOutcomeSchema),
        ),
      ),
});
