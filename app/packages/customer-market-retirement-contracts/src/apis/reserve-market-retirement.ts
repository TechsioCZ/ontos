import { makeProblemDetailsSchema, makeRetryableProblemDetailsSchema } from '@app/shared-contracts';
import { Schema } from 'effect';
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from 'effect/unstable/httpapi';

import { MarketRefSchema } from '../market-reference.ts';

import {
  MarketAffectedUseSourceEvidenceSchema,
  MarketRetirementInstantSchema,
  MarketRevisionSchema,
} from './market-affected-use-assessment.ts';

const strict = { parseOptions: { onExcessProperty: 'error' as const } };
const boundedReason = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500), Schema.isTrimmed());
const sha256Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const checkedUuid = Schema.String.check(Schema.isUUID());
export const MarketRetirementReservationTokenSchema = checkedUuid.pipe(
  Schema.brand('MarketRetirementReservationToken'),
  Schema.decodeTo(checkedUuid),
);
export const MarketRetirementReservationVersionSchema = Schema.Finite.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(1),
);
export const MarketRetirementReservationOperationSchema = Schema.Literals(['RESERVE', 'COMMIT', 'RELEASE']);
export type MarketRetirementReservationOperation = typeof MarketRetirementReservationOperationSchema.Type;

const reservationIdentity = {
  marketRef: MarketRefSchema,
  marketRevision: MarketRevisionSchema,
  tenantId: MarketRefSchema.fields.tenantId,
} as const;

const reserve = Schema.Struct({
  ...reservationIdentity,
  assessmentDigest: sha256Digest,
  evaluatedAt: MarketRetirementInstantSchema,
  operation: Schema.Literal('RESERVE'),
  reason: boundedReason,
  sourceEvidence: Schema.Array(MarketAffectedUseSourceEvidenceSchema).check(Schema.isMinLength(1)),
}).annotate(strict);

const finish = <Operation extends 'COMMIT' | 'RELEASE'>(operation: Operation) =>
  Schema.Struct({
    ...reservationIdentity,
    operation: Schema.Literal(operation),
    reason: boundedReason,
    reservationToken: MarketRetirementReservationTokenSchema,
    reservationVersion: MarketRetirementReservationVersionSchema,
  }).annotate(strict);

export const ReserveMarketRetirementPayloadSchema = Schema.Union([reserve, finish('COMMIT'), finish('RELEASE')]).check(
  Schema.makeFilter(({ marketRef, tenantId }) =>
    marketRef.tenantId === tenantId ? undefined : 'Market and reservation must belong to the same Tenant',
  ),
);
export type ReserveMarketRetirementPayload = typeof ReserveMarketRetirementPayloadSchema.Type;

export const ReserveMarketRetirementResultSchema = Schema.Struct({
  ...reservationIdentity,
  assessmentDigest: sha256Digest,
  lifecycle: Schema.Literals(['RESERVED', 'COMMITTED', 'RELEASED']),
  reservationToken: MarketRetirementReservationTokenSchema,
  reservationVersion: MarketRetirementReservationVersionSchema,
}).annotate(strict);
export type ReserveMarketRetirementResult = typeof ReserveMarketRetirementResultSchema.Type;

export const ReserveMarketRetirementAuthenticationProblemSchema = makeProblemDetailsSchema(
  'ReserveMarketRetirementActionAuthenticationProblem',
  401,
);
export const ReserveMarketRetirementInvalidProblemSchema = makeProblemDetailsSchema(
  'ReserveMarketRetirementActionInvalidProblem',
  400,
);
export const ReserveMarketRetirementForbiddenProblemSchema = makeProblemDetailsSchema(
  'ReserveMarketRetirementActionForbiddenProblem',
  403,
  {
    code: Schema.Literals([
      'action_permission_denied',
      'module_state_denied',
      'operation_context_denied',
      'operation_context_invalid',
      'SCOPE_MISMATCH',
    ]),
  },
);
export const ReserveMarketRetirementNotFoundProblemSchema = makeProblemDetailsSchema(
  'ReserveMarketRetirementActionNotFoundProblem',
  404,
  { code: Schema.Literals(['action_invocation_not_found', 'RETIREMENT_RESERVATION_NOT_FOUND']) },
);
export const ReserveMarketRetirementConflictProblemSchema = makeProblemDetailsSchema(
  'ReserveMarketRetirementActionConflictProblem',
  409,
  {
    code: Schema.Literals([
      'action_request_hash_conflict',
      'action_invocation_state_invalid',
      'ASSESSMENT_STALE',
      'LIVE_REFERENCE_CONFLICT',
      'RESERVATION_STATE_CONFLICT',
      'RETIREMENT_RESERVATION_CONFLICT',
    ]),
  },
);
export const ReserveMarketRetirementIneligibleProblemSchema = makeProblemDetailsSchema(
  'ReserveMarketRetirementActionIneligibleProblem',
  422,
  { code: Schema.Literals(['action_policy_denied', 'INVALID_REQUEST']) },
);
export const ReserveMarketRetirementPreconditionProblemSchema = makeProblemDetailsSchema(
  'ReserveMarketRetirementActionPreconditionProblem',
  428,
);
export const ReserveMarketRetirementUnavailableProblemSchema = makeRetryableProblemDetailsSchema(
  'ReserveMarketRetirementActionUnavailableProblem',
  503,
  {
    code: Schema.Literals([
      'action_invocation_persistence_failed',
      'action_permission_check_failed',
      'action_policy_evaluation_failed',
      'action_transaction_failed',
      'module_state_check_unavailable',
      'operation_context_unavailable',
      'ASSESSMENT_UNAVAILABLE',
      'PERSISTENCE_UNAVAILABLE',
    ]),
  },
);
export const ReserveMarketRetirementAlreadyCommittedProblemSchema = makeProblemDetailsSchema(
  'ReserveMarketRetirementActionAlreadyCommittedProblem',
  409,
  {
    code: Schema.Literal('action_already_committed'),
    invocationId: Schema.String,
    resolution: Schema.Literal('REFRESH_GOVERNED_READS'),
    retryCommand: Schema.Literal(false),
  },
);
export const ReserveMarketRetirementCommitIndeterminateProblemSchema = makeProblemDetailsSchema(
  'ReserveMarketRetirementActionCommitIndeterminateProblem',
  503,
  {
    invocationId: Schema.String,
    resolution: Schema.Literal('RESOLVE_COMMIT'),
    retryCommand: Schema.Literal(false),
  },
);
export const ReserveMarketRetirementInternalProblemSchema = makeProblemDetailsSchema(
  'ReserveMarketRetirementActionInternalProblem',
  500,
);

const ReserveMarketRetirementHeadersSchema = Schema.Struct({
  'idempotency-key': Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200))),
});

export const ReserveMarketRetirementApi = HttpApi.make('ReserveMarketRetirementApi').add(
  HttpApiGroup.make('reserveMarketRetirement').add(
    HttpApiEndpoint.post('execute', '/commerce-customer-context/actions/reserve-market-retirement', {
      error: [
        ReserveMarketRetirementInvalidProblemSchema,
        ReserveMarketRetirementAuthenticationProblemSchema,
        ReserveMarketRetirementForbiddenProblemSchema,
        ReserveMarketRetirementNotFoundProblemSchema,
        ReserveMarketRetirementConflictProblemSchema,
        ReserveMarketRetirementIneligibleProblemSchema,
        ReserveMarketRetirementPreconditionProblemSchema,
        ReserveMarketRetirementUnavailableProblemSchema,
        ReserveMarketRetirementAlreadyCommittedProblemSchema,
        ReserveMarketRetirementCommitIndeterminateProblemSchema,
        ReserveMarketRetirementInternalProblemSchema,
      ],
      headers: ReserveMarketRetirementHeadersSchema,
      params: {},
      payload: Schema.toEncoded(ReserveMarketRetirementPayloadSchema),
      query: {},
      success: ReserveMarketRetirementResultSchema,
    }),
  ),
);
