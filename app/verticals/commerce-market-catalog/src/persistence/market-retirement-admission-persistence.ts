import type { ActionServiceFactory } from '@app/core-runtime';
import { OperationContextUnavailable } from '@app/core-runtime';
import { and, eq } from 'drizzle-orm';
import { Crypto, Effect, Schema } from 'effect';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { marketRetirementAdmissions } from '../database/schema.ts';
import { ManageMarketRetirementAdmissionResultSchema } from '../../shared/market-retirement-admission.ts';
import type {
  ManageMarketRetirementAdmissionPayload,
  MarketRetirementAdmissionEvidence,
  MarketRetirementCommittedResult,
  MarketRetirementStoredBasis,
  MarketRetirementEffectRecoveryResultSchema,
} from '../../shared/market-retirement-admission.ts';
import type { ReservedMarketRetirementImpactAssessment } from '../../shared/domain/market-retirement-impact.ts';
import { MarketRetirementImpactAssessmentUnavailable } from '../actions/market-retirement-impact-assessment-unavailable.ts';

export const retirementGuardHash = (proof: string) => bytesToHex(sha256(new TextEncoder().encode(proof)));
export const retirementPayloadMatches = (
  left: ManageMarketRetirementAdmissionPayload['retirement'],
  right: ManageMarketRetirementAdmissionPayload['retirement'],
) =>
  left.effectiveAt === right.effectiveAt &&
  left.expectedRevision === right.expectedRevision &&
  left.reason === right.reason &&
  left.marketRef.moduleId === right.marketRef.moduleId &&
  left.marketRef.resourceId === right.marketRef.resourceId &&
  left.marketRef.resourceType === right.marketRef.resourceType &&
  left.marketRef.tenantId === right.marketRef.tenantId &&
  left.expectedCurrentDefinitionRevisionRef.resourceId === right.expectedCurrentDefinitionRevisionRef.resourceId &&
  left.expectedCurrentDefinitionRevisionRef.tenantId === right.expectedCurrentDefinitionRevisionRef.tenantId &&
  left.expectedCurrentDefinitionRevisionRef.moduleId === right.expectedCurrentDefinitionRevisionRef.moduleId &&
  left.expectedCurrentDefinitionRevisionRef.resourceType === right.expectedCurrentDefinitionRevisionRef.resourceType;
const unavailable = (cause?: unknown) => {
  const failure = new MarketRetirementImpactAssessmentUnavailable({
    code: 'market_retirement_impact_assessment_unavailable',
    reason: 'The exact Market retirement admission could not be established',
  });
  if (cause !== undefined) {
    Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  }
  return failure;
};
type Row = typeof marketRetirementAdmissions.$inferSelect;
export const projectMarketRetirementAdmission = (row: Row, revealAbortProof = false) => {
  const identity = {
    basis: row.basis,
    compositionRevision: row.compositionRevision,
    marketRef: row.retirementPayload.marketRef,
    outcome: row.status,
    releaseGuardHash: row.releaseGuardHash,
    retirement: row.retirementPayload,
    sourceActionInvocationId: row.sourceActionInvocationId,
  };
  const value = { ...identity };
  if (row.status === 'COMMITTED') {
    Object.assign(value, { assessment: row.retirementAssessment, result: row.committedResult });
  }
  if (row.status === 'ABORTED' && revealAbortProof) {
    Object.assign(value, { abortProof: row.abortProof });
  }
  return Schema.decodeUnknownEffect(ManageMarketRetirementAdmissionResultSchema)(value).pipe(
    Effect.mapError(unavailable),
  );
};

export const marketRetirementAdmissionPersistence: ActionServiceFactory<
  {
    readonly commit: (input: {
      readonly assessment: ReservedMarketRetirementImpactAssessment;
      readonly result: MarketRetirementCommittedResult;
      readonly sourceActionInvocationId: string;
    }) => Effect.Effect<void, MarketRetirementImpactAssessmentUnavailable>;
    readonly lockPending: (
      input: Omit<ManageMarketRetirementAdmissionPayload, 'operation'>,
    ) => Effect.Effect<void, MarketRetirementImpactAssessmentUnavailable>;
    readonly manage: (
      input: ManageMarketRetirementAdmissionPayload,
      basis?: MarketRetirementStoredBasis,
    ) => Effect.Effect<MarketRetirementAdmissionEvidence, MarketRetirementImpactAssessmentUnavailable>;
    readonly recover: (input: {
      readonly marketRef: ManageMarketRetirementAdmissionPayload['retirement']['marketRef'];
      readonly sourceActionInvocationId: string;
    }) => Effect.Effect<
      typeof MarketRetirementEffectRecoveryResultSchema.Type,
      MarketRetirementImpactAssessmentUnavailable
    >;
  },
  Crypto.Crypto
> = Effect.fn('MarketRetirementAdmission.services')(
  function* admissionServices(transaction, scope, compositionRevision) {
    const crypto = yield* Crypto.Crypto;
    if (scope.legalEntityId === undefined) {
      return yield* new OperationContextUnavailable({
        code: 'operation_context_unavailable',
        reason: 'Market retirement requires a trusted Legal Entity',
      });
    }
    const { legalEntityId } = scope;
    const predicate = (sourceActionInvocationId: string, marketId: string) =>
      and(
        eq(marketRetirementAdmissions.sourceActionInvocationId, sourceActionInvocationId),
        eq(marketRetirementAdmissions.tenantId, scope.tenantId),
        eq(marketRetirementAdmissions.marketId, marketId),
        eq(marketRetirementAdmissions.sellingLegalEntityId, legalEntityId),
        eq(marketRetirementAdmissions.principalId, scope.principalId),
      );
    const lock = (input: Omit<ManageMarketRetirementAdmissionPayload, 'operation'>) =>
      transaction
        .select()
        .from(marketRetirementAdmissions)
        .where(predicate(input.sourceActionInvocationId, input.retirement.marketRef.resourceId))
        .for('update')
        .pipe(
          Effect.mapError(unavailable),
          Effect.flatMap(([row]) =>
            row !== undefined && retirementPayloadMatches(row.retirementPayload, input.retirement)
              ? Effect.succeed(row)
              : Effect.fail(unavailable()),
          ),
        );
    return {
      commit: (input) =>
        transaction
          .update(marketRetirementAdmissions)
          .set({ committedResult: input.result, retirementAssessment: input.assessment, status: 'COMMITTED' })
          .where(
            and(
              eq(marketRetirementAdmissions.sourceActionInvocationId, input.sourceActionInvocationId),
              eq(marketRetirementAdmissions.tenantId, scope.tenantId),
              eq(marketRetirementAdmissions.principalId, scope.principalId),
              eq(marketRetirementAdmissions.sellingLegalEntityId, legalEntityId),
              eq(marketRetirementAdmissions.status, 'PENDING'),
            ),
          )
          .returning({ sourceActionInvocationId: marketRetirementAdmissions.sourceActionInvocationId })
          .pipe(
            Effect.mapError(unavailable),
            Effect.flatMap((rows) => (rows.length === 1 ? Effect.void : Effect.fail(unavailable()))),
          ),
      lockPending: (input) =>
        lock(input).pipe(
          Effect.flatMap((row) =>
            row.status === 'PENDING' && row.compositionRevision === compositionRevision
              ? Effect.void
              : Effect.fail(unavailable()),
          ),
        ),
      manage: Effect.fn('MarketRetirementAdmission.manage')(function* manageAdmission(input, basis) {
        if (input.retirement.marketRef.tenantId !== scope.tenantId) {
          return yield* unavailable();
        }
        if (input.operation === 'PREPARE') {
          if (basis === undefined) {
            const existing = yield* lock(input);
            return yield* projectMarketRetirementAdmission(existing);
          }
          const proof = yield* crypto.randomUUIDv4().pipe(Effect.mapError(unavailable));
          yield* transaction
            .insert(marketRetirementAdmissions)
            .values({
              abortProof: proof,
              basis,
              compositionRevision,
              marketId: input.retirement.marketRef.resourceId,
              principalId: scope.principalId,
              releaseGuardHash: retirementGuardHash(proof),
              retirementPayload: input.retirement,
              sellingLegalEntityId: legalEntityId,
              sourceActionInvocationId: input.sourceActionInvocationId,
              status: 'PENDING',
              tenantId: scope.tenantId,
            })
            .onConflictDoNothing()
            .pipe(Effect.mapError(unavailable));
        }
        const row = yield* lock(input);
        if (input.operation === 'ABORT' && row.status === 'PENDING') {
          yield* transaction
            .update(marketRetirementAdmissions)
            .set({ status: 'ABORTED' })
            .where(predicate(input.sourceActionInvocationId, input.retirement.marketRef.resourceId))
            .pipe(Effect.mapError(unavailable));
          return yield* projectMarketRetirementAdmission({ ...row, status: 'ABORTED' }, true);
        }
        return yield* projectMarketRetirementAdmission(row, input.operation === 'ABORT');
      }),
      recover: Effect.fn('MarketRetirementAdmission.recover')(function* recoverAdmission(input) {
        const [row] = yield* transaction
          .select()
          .from(marketRetirementAdmissions)
          .where(predicate(input.sourceActionInvocationId, input.marketRef.resourceId))
          .pipe(Effect.mapError(unavailable));
        if (row === undefined) {
          return { outcome: 'NOT_FOUND' as const };
        }
        return yield* projectMarketRetirementAdmission(row, true);
      }),
    };
  },
);
export type MarketRetirementAdmissionPersistence = Effect.Success<
  ReturnType<typeof marketRetirementAdmissionPersistence>
>;
