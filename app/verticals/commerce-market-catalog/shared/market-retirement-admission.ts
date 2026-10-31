import { MarketAffectedUseVerifiedSchema } from '@app/customer-market-retirement-contracts/market-affected-use-assessment';
import { Schema } from 'effect';
import { makeProblemDetailsSchema } from '@app/shared-contracts/problem-details';
import { MarketLifecycleResultSchema, RetireMarketPayloadSchema, MarketCommandRejected } from './action-contracts.ts';
import {
  ReservedMarketRetirementImpactAssessmentSchema,
  MarketRetirementImpactAssessmentSchema,
  MarketRetirementSourceInvocationIdSchema,
  MarketRetirementAbortedSettlementSchema,
  MarketRetirementImpactAssessmentStale,
} from './domain/market-retirement-impact.ts';
import { MarketRetirementImpactAssessmentRejected } from './domain/market-retirement-impact-assessment-rejected.ts';
import { MarketRefSchema } from './resources/market.ts';

export type MarketRetirementCommittedResult = typeof MarketLifecycleResultSchema.Type;

const uuid = Schema.String.check(Schema.isUUID());
export const MarketRetirementAbortProofSchema = uuid.pipe(
  Schema.brand('MarketRetirementAbortProof'),
  Schema.decodeTo(uuid),
);
export const MarketRetirementGuardHashSchema = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
export const MarketRetirementEncodedPayloadSchema = Schema.toEncoded(RetireMarketPayloadSchema);
export const MarketRetirementAdmissionRequestSchema = Schema.Struct({
  marketRef: MarketRefSchema,
  sourceActionInvocationId: MarketRetirementSourceInvocationIdSchema,
});
export const ManageMarketRetirementAdmissionPayloadSchema = Schema.Struct({
  operation: Schema.Literals(['PREPARE', 'ABORT']),
  retirement: MarketRetirementEncodedPayloadSchema,
  sourceActionInvocationId: MarketRetirementSourceInvocationIdSchema,
});
export type ManageMarketRetirementAdmissionPayload = typeof ManageMarketRetirementAdmissionPayloadSchema.Type;
export const MarketRetirementReserveBasisSchema = Schema.Struct({
  assessmentDigest: MarketAffectedUseVerifiedSchema.fields.assessmentDigest,
  evaluatedAt: MarketAffectedUseVerifiedSchema.fields.evaluatedAt,
  sourceEvidence: MarketAffectedUseVerifiedSchema.fields.sourceEvidence,
});
export const MarketRetirementStoredBasisSchema = Schema.Struct({
  assessment: MarketRetirementImpactAssessmentSchema.check(
    Schema.makeFilter((assessment) =>
      assessment.reservation === undefined ? undefined : 'A prepared basis precedes every reservation effect',
    ),
  ),
  reserve: Schema.toEncoded(MarketRetirementReserveBasisSchema),
});
export type MarketRetirementStoredBasis = typeof MarketRetirementStoredBasisSchema.Type;
const identity = {
  basis: MarketRetirementStoredBasisSchema,
  compositionRevision: MarketRetirementGuardHashSchema,
  marketRef: MarketRefSchema,
  releaseGuardHash: MarketRetirementGuardHashSchema,
  retirement: MarketRetirementEncodedPayloadSchema,
  sourceActionInvocationId: MarketRetirementSourceInvocationIdSchema,
};
export const ManageMarketRetirementAdmissionResultSchema = Schema.Union([
  Schema.Struct({ ...identity, outcome: Schema.Literal('PENDING') }),
  Schema.Struct({
    ...identity,
    abortProof: Schema.optionalKey(MarketRetirementAbortProofSchema),
    outcome: Schema.Literal('ABORTED'),
  }),
  Schema.Struct({
    ...identity,
    assessment: ReservedMarketRetirementImpactAssessmentSchema,
    outcome: Schema.Literal('COMMITTED'),
    result: MarketLifecycleResultSchema,
  }),
]);
export type MarketRetirementAdmissionEvidence = typeof ManageMarketRetirementAdmissionResultSchema.Type;
export const MarketRetirementEffectRecoveryResultSchema = Schema.Union([
  Schema.Struct({ outcome: Schema.Literal('NOT_FOUND') }),
  ManageMarketRetirementAdmissionResultSchema,
]);
export type MarketRetirementEffectRecoveryResult = typeof MarketRetirementEffectRecoveryResultSchema.Type;

export class MarketRetirementSettlementPending extends Schema.TaggedError<MarketRetirementSettlementPending>()(
  'MarketRetirementSettlementPending',
  {
    code: Schema.Literal('market_retirement_settlement_unavailable'),
    committedResult: MarketLifecycleResultSchema,
    reason: Schema.String,
    sourceActionInvocationId: MarketRetirementSourceInvocationIdSchema,
  },
) {}

export const RetireMarketActionSettlementPendingProblemSchema = makeProblemDetailsSchema(
  'RetireMarketActionSettlementPendingProblem',
  503,
  {
    code: MarketRetirementSettlementPending.fields.code,
    committedResult: MarketRetirementSettlementPending.fields.committedResult,
    pendingSettlement: Schema.Literal(true),
    resolution: Schema.Literal('RECOVER_ORIGINAL_EFFECT'),
    retryCommand: Schema.Literal(false),
    sourceActionInvocationId: MarketRetirementSettlementPending.fields.sourceActionInvocationId,
  },
);
/** Pure wire projection; receipt recovery remains independently governed. */
export const mapMarketRetirementSettlementPendingProblem = (failure: MarketRetirementSettlementPending) =>
  RetireMarketActionSettlementPendingProblemSchema.make({
    code: failure.code,
    committedResult: failure.committedResult,
    detail: failure.reason,
    pendingSettlement: true,
    resolution: 'RECOVER_ORIGINAL_EFFECT',
    retryCommand: false,
    sourceActionInvocationId: failure.sourceActionInvocationId,
    status: RetireMarketActionSettlementPendingProblemSchema.fields.status.literal,
    title: 'Market retirement settlement pending',
    type: 'https://ontos.dev/problems/market-retirement-settlement-pending',
  });

const abortedSettlementFields = { retirementSettlement: Schema.optionalKey(MarketRetirementAbortedSettlementSchema) };
const terminalConflictProblem = makeProblemDetailsSchema('RetireMarketActionTerminalConflictProblem', 409, {
  ...abortedSettlementFields,
  code: MarketCommandRejected.fields.code,
});
const terminalIneligibleProblem = makeProblemDetailsSchema('RetireMarketActionTerminalIneligibleProblem', 422, {
  ...abortedSettlementFields,
  code: MarketCommandRejected.fields.code,
});
export const MarketRetirementCommandRejectedProblemSchema = Schema.Union([
  terminalConflictProblem,
  terminalIneligibleProblem,
]);
const terminalConflictCodes = new Set<MarketCommandRejected['code']>([
  'invalid_lifecycle_transition',
  'market_code_conflict',
  'overlapping_association',
  'revision_conflict',
]);
export const mapMarketRetirementCommandRejectedProblem = (failure: MarketCommandRejected) => {
  const fields = {
    code: failure.code,
    detail: failure.reason,
    title: 'Market command rejected',
    type: 'https://ontos.dev/problems/market-command-rejected',
  };
  if (failure.retirementSettlement !== undefined) {
    Object.assign(fields, { retirementSettlement: failure.retirementSettlement });
  }
  return terminalConflictCodes.has(failure.code)
    ? terminalConflictProblem.make({ ...fields, status: terminalConflictProblem.fields.status.literal })
    : terminalIneligibleProblem.make({ ...fields, status: terminalIneligibleProblem.fields.status.literal });
};
export const MarketRetirementImpactRejectedProblemSchema = makeProblemDetailsSchema(
  'RetireMarketActionImpactRejectedProblem',
  422,
  { ...abortedSettlementFields, code: MarketRetirementImpactAssessmentRejected.fields.code },
);
export const mapMarketRetirementImpactRejectedProblem = (failure: MarketRetirementImpactAssessmentRejected) => {
  const fields = {
    code: failure.code,
    detail: failure.reason,
    status: MarketRetirementImpactRejectedProblemSchema.fields.status.literal,
    title: 'Market impact rejected',
    type: 'https://ontos.dev/problems/market-impact-rejected',
  };
  if (failure.retirementSettlement !== undefined) {
    Object.assign(fields, { retirementSettlement: failure.retirementSettlement });
  }
  return MarketRetirementImpactRejectedProblemSchema.make(fields);
};
export const MarketRetirementImpactStaleProblemSchema = makeProblemDetailsSchema(
  'RetireMarketActionImpactStaleProblem',
  409,
  { ...abortedSettlementFields, code: MarketRetirementImpactAssessmentStale.fields.code },
);
export const mapMarketRetirementImpactStaleProblem = (failure: MarketRetirementImpactAssessmentStale) => {
  const fields = {
    code: failure.code,
    detail: failure.reason,
    status: MarketRetirementImpactStaleProblemSchema.fields.status.literal,
    title: 'Market impact stale',
    type: 'https://ontos.dev/problems/market-impact-stale',
  };
  if (failure.retirementSettlement !== undefined) {
    Object.assign(fields, { retirementSettlement: failure.retirementSettlement });
  }
  return MarketRetirementImpactStaleProblemSchema.make(fields);
};
