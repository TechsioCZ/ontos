// fallow-ignore-file code-duplication -- Owner-local protocol code intentionally mirrors its peer owner while preserving separate deployment and persistence authority.
/* jscpd:ignore-start -- Owner-local protocol code intentionally mirrors its peer owner while preserving separate deployment and persistence authority. */
import { executeRecordOwnerExecutionOutcomeWithAuthorization } from '@app/privacy/api/client';
import type { OwnerExecutionOutcome, PrivacyMeasureHandoff } from '@app/privacy/domain/privacy-measure-handoff';
import { OwnerExecutionOutcomeSchema } from '@app/privacy/domain/privacy-measure-handoff';
import { acquireDelegatedGatewayContext } from '@app/shared-contracts/gateway-context-server';
import type { Option } from 'effect';
import { Config, Context, Crypto, Effect, Layer, Schema } from 'effect';

import { executeExecutePrivacyMeasureWithAuthorization } from '../api/execute-privacy-measure-action-client.ts';
import { ExecutePrivacyMeasureResultSchema } from '../../shared/actions/execute-privacy-measure.ts';
import { executePrivacyMeasureExecutionWithAuthorization } from '../api/privacy-measure-execution-client.ts';
import type { PrivacyMeasureExecutionReceipt } from '../services/privacy-measure-execution.service.ts';
import { ExecutePrivacyMeasureWorkerRejected } from './execute-privacy-measure-worker-rejected.ts';

export { ExecutePrivacyMeasureWorkerRejected } from './execute-privacy-measure-worker-rejected.ts';

/** This module: its own module credential authenticates every delegated call it makes. */
const CALLING_APP_ID = 'commerce-customer-context' as const;

const httpUrl = Schema.URLFromString.check(
  Schema.makeFilter((url) =>
    (url.protocol === 'http:' || url.protocol === 'https:') &&
    url.username.length === 0 &&
    url.password.length === 0 &&
    url.search.length === 0 &&
    url.hash.length === 0
      ? undefined
      : 'Gateway URL must be HTTP(S) without credentials, query, or fragment',
  ),
);
const configuration = Config.all({
  ownerBaseUrl: Config.schema(httpUrl, 'ONTOS_COMMERCE_CUSTOMER_CONTEXT_API_BASE_URL'),
  privacyBaseUrl: Config.schema(httpUrl, 'ONTOS_PRIVACY_API_BASE_URL'),
});

/** The outbox invocation whose work this is: the privacy measure's subject is the principal that invoked it (DESIGN D7). */
export interface PrivacyMeasureOriginator {
  readonly actionInvocationId: string;
  readonly tenantId: string;
}

export interface PrivacyMeasureOwnerGatewayService {
  readonly execute: (
    handoff: PrivacyMeasureHandoff,
    requestCorrelation: string,
    compositionRevision: string,
    originator: PrivacyMeasureOriginator,
  ) => Effect.Effect<OwnerExecutionOutcome, ExecutePrivacyMeasureWorkerRejected>;
  readonly load: (
    handoff: PrivacyMeasureHandoff,
    requestCorrelation: string,
    compositionRevision: string,
    originator: PrivacyMeasureOriginator,
  ) => Effect.Effect<Option.Option<PrivacyMeasureExecutionReceipt>, ExecutePrivacyMeasureWorkerRejected>;
  readonly report: (
    outcome: OwnerExecutionOutcome,
    requestCorrelation: string,
    compositionRevision: string,
    originator: PrivacyMeasureOriginator,
  ) => Effect.Effect<void, ExecutePrivacyMeasureWorkerRejected>;
}

export class PrivacyMeasureOwnerGateway extends Context.Service<
  PrivacyMeasureOwnerGateway,
  PrivacyMeasureOwnerGatewayService
>()('@app/commerce-customer-context/workers/privacy-measure-owner-gateway/PrivacyMeasureOwnerGateway') {}

const OwnerGatewayFailureSchema = Schema.Struct({
  code: Schema.optionalKey(Schema.String),
  resolution: Schema.optionalKey(Schema.String),
});
const AlreadyRecordedFailureSchema = OwnerGatewayFailureSchema.check(
  Schema.makeFilter(({ code }) =>
    code === 'action_already_committed' ? undefined : 'Outcome was not already recorded',
  ),
);
const workerFailure = (cause: unknown, operation: string) => {
  const indeterminate = Schema.is(OwnerGatewayFailureSchema)(cause) && cause.resolution === 'RESOLVE_COMMIT';
  const failure = new ExecutePrivacyMeasureWorkerRejected({
    code: indeterminate ? 'OWNER_COMMIT_INDETERMINATE' : 'OWNER_GATEWAY_UNAVAILABLE',
    reason: indeterminate
      ? `${operation} may have committed; reconcile its durable receipt before retrying`
      : `${operation} is temporarily unavailable`,
    retryable: true,
  });
  Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  return failure;
};
const reportIdempotencyKey = (outcome: OwnerExecutionOutcome) =>
  `owner-outcome:${outcome.measureId}:${outcome.attempt}`.slice(0, 200);
const isAlreadyRecorded = Schema.is(AlreadyRecordedFailureSchema);

const makeGateway = (
  configured: {
    readonly ownerBaseUrl: URL;
    readonly privacyBaseUrl: URL;
  },
  crypto: Crypto.Crypto,
): PrivacyMeasureOwnerGatewayService => {
  const credential = (
    audience: 'commerce-customer-context' | 'privacy',
    correlation: string,
    compositionRevision: string,
    originator: PrivacyMeasureOriginator,
  ) =>
    acquireDelegatedGatewayContext(
      {
        audience,
        callingAppId: CALLING_APP_ID,
        legalEntityScope: 'subject',
        requestCorrelation: correlation,
        subject: {
          _tag: 'Originator',
          actionInvocationId: originator.actionInvocationId,
          compositionRevision,
          tenantId: originator.tenantId,
        },
      },
      crypto,
    ).pipe(
      Effect.map(({ authorization }) => authorization),
      Effect.mapError((cause) => workerFailure(cause, 'Credential issuance')),
    );
  return {
    execute: (handoff, correlation, compositionRevision, originator) =>
      credential(CALLING_APP_ID, correlation, compositionRevision, originator).pipe(
        Effect.flatMap((authorization) =>
          executeExecutePrivacyMeasureWithAuthorization({ handoff }, authorization, correlation, {
            baseUrl: configured.ownerBaseUrl,
            compositionRevision,
            idempotencyKey: handoff.idempotencyKey,
          }),
        ),
        // O85: a parked proposal is a public 202 success body, never an owner execution outcome. This
        // worker requires execution, so the Action's own result schema decides the seam.
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.toType(ExecutePrivacyMeasureResultSchema))),
        Effect.mapError((cause) => workerFailure(cause, 'Commerce Privacy Measure Action')),
      ),
    load: (handoff, correlation, compositionRevision, originator) =>
      credential(CALLING_APP_ID, correlation, compositionRevision, originator).pipe(
        Effect.flatMap((authorization) =>
          executePrivacyMeasureExecutionWithAuthorization(
            { idempotencyKey: handoff.idempotencyKey },
            authorization,
            correlation,
            { baseUrl: configured.ownerBaseUrl, compositionRevision },
          ),
        ),
        Effect.mapError((cause) => workerFailure(cause, 'Commerce receipt read')),
      ),
    report: (outcome, correlation, compositionRevision, originator) =>
      credential('privacy', correlation, compositionRevision, originator).pipe(
        Effect.flatMap((authorization) =>
          executeRecordOwnerExecutionOutcomeWithAuthorization(
            { request: { attempt: outcome.attempt, measureId: outcome.measureId, taskId: outcome.taskId } },
            authorization,
            correlation,
            {
              baseUrl: configured.privacyBaseUrl,
              compositionRevision,
              idempotencyKey: reportIdempotencyKey(outcome),
            },
          ),
        ),
        // A proposal to record the outcome is not a durable report and cannot acknowledge delivery.
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.toType(OwnerExecutionOutcomeSchema))),
        Effect.asVoid,
        Effect.catchIf(isAlreadyRecorded, () => Effect.void),
        Effect.mapError((cause) => workerFailure(cause, 'Privacy owner-outcome recording')),
      ),
  };
};

const unavailableGateway = (cause: unknown): PrivacyMeasureOwnerGatewayService => {
  const fail = (operation: string) => Effect.fail(workerFailure(cause, operation));
  return {
    execute: () => fail('Commerce Privacy Measure Action'),
    load: () => fail('Commerce receipt read'),
    report: () => fail('Privacy owner-outcome recording'),
  };
};

export const PrivacyMeasureOwnerGatewayLive = Layer.effect(
  PrivacyMeasureOwnerGateway,
  Effect.gen(function* privacyMeasureOwnerGatewayLayer() {
    const crypto = yield* Crypto.Crypto;
    return yield* configuration.pipe(
      Effect.match({ onFailure: unavailableGateway, onSuccess: (value) => makeGateway(value, crypto) }),
    );
  }),
);
/* jscpd:ignore-end */
