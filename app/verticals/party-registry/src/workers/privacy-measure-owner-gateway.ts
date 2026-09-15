import { issueApiKeyGatewayContext } from '@app/shared-contracts/server/gateway-context-api-key';
import { executeRecordOwnerExecutionOutcomeWithAuthorization } from '@app/privacy/api/client';
import type { OwnerExecutionOutcome, PrivacyMeasureHandoff } from '@app/privacy/domain/privacy-measure-handoff';
import type { Option, Redacted } from 'effect';
import { Config, Context, Effect, Layer, Schema } from 'effect';

import { executeExecutePrivacyMeasureWithAuthorization } from '../api/execute-privacy-measure-action-client.ts';
import { executePrivacyMeasureExecutionWithAuthorization } from '../api/privacy-measure-execution-client.ts';
import type { PrivacyMeasureExecutionReceipt } from '../services/privacy-measure-execution.service.ts';
import { ExecutePrivacyMeasureWorkerRejected } from './execute-privacy-measure-worker-rejected.ts';

export { ExecutePrivacyMeasureWorkerRejected } from './execute-privacy-measure-worker-rejected.ts';

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
  apiKey: Config.redacted('ONTOS_PRIVACY_MEASURE_WORKER_API_KEY'),
  ownerBaseUrl: Config.schema(httpUrl, 'ONTOS_PARTY_REGISTRY_API_BASE_URL'),
  privacyBaseUrl: Config.schema(httpUrl, 'ONTOS_PRIVACY_API_BASE_URL'),
  shellBaseUrl: Config.schema(httpUrl, 'ONTOS_SHELL_GATEWAY_BASE_URL'),
});

export interface PrivacyMeasureOwnerGatewayService {
  readonly execute: (
    handoff: PrivacyMeasureHandoff,
    legalEntityId: string,
    requestCorrelation: string,
  ) => Effect.Effect<OwnerExecutionOutcome, ExecutePrivacyMeasureWorkerRejected>;
  readonly load: (
    handoff: PrivacyMeasureHandoff,
    legalEntityId: string,
    requestCorrelation: string,
  ) => Effect.Effect<Option.Option<PrivacyMeasureExecutionReceipt>, ExecutePrivacyMeasureWorkerRejected>;
  readonly report: (
    outcome: OwnerExecutionOutcome,
    legalEntityId: string,
    requestCorrelation: string,
  ) => Effect.Effect<void, ExecutePrivacyMeasureWorkerRejected>;
}

export class PrivacyMeasureOwnerGateway extends Context.Service<
  PrivacyMeasureOwnerGateway,
  PrivacyMeasureOwnerGatewayService
>()('@app/party-registry/workers/privacy-measure-owner-gateway/PrivacyMeasureOwnerGateway') {}

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

const makeGateway = (configured: {
  readonly apiKey: Redacted.Redacted;
  readonly ownerBaseUrl: URL;
  readonly privacyBaseUrl: URL;
  readonly shellBaseUrl: URL;
}): PrivacyMeasureOwnerGatewayService => {
  const credential = (audience: 'party-registry' | 'privacy', legalEntityId: string, correlation: string) =>
    issueApiKeyGatewayContext(
      { audience, legalEntityId },
      { apiKey: configured.apiKey, baseUrl: configured.shellBaseUrl, requestCorrelation: correlation },
    ).pipe(
      Effect.map(({ token }) => `Bearer ${token}`),
      Effect.mapError((cause) => workerFailure(cause, 'Credential issuance')),
    );
  return {
    execute: (handoff, legalEntityId, correlation) =>
      credential('party-registry', legalEntityId, correlation).pipe(
        Effect.flatMap((authorization) =>
          executeExecutePrivacyMeasureWithAuthorization({ handoff }, authorization, correlation, {
            baseUrl: configured.ownerBaseUrl,
            idempotencyKey: handoff.idempotencyKey,
          }),
        ),
        Effect.mapError((cause) => workerFailure(cause, 'Party Registry Privacy Measure Action')),
      ),
    load: (handoff, legalEntityId, correlation) =>
      credential('party-registry', legalEntityId, correlation).pipe(
        Effect.flatMap((authorization) =>
          executePrivacyMeasureExecutionWithAuthorization(
            { idempotencyKey: handoff.idempotencyKey },
            authorization,
            correlation,
            { baseUrl: configured.ownerBaseUrl },
          ),
        ),
        Effect.mapError((cause) => workerFailure(cause, 'Party Registry receipt read')),
      ),
    report: (outcome, legalEntityId, correlation) =>
      credential('privacy', legalEntityId, correlation).pipe(
        Effect.flatMap((authorization) =>
          executeRecordOwnerExecutionOutcomeWithAuthorization(
            { request: { attempt: outcome.attempt, measureId: outcome.measureId, taskId: outcome.taskId } },
            authorization,
            correlation,
            {
              baseUrl: configured.privacyBaseUrl,
              idempotencyKey: reportIdempotencyKey(outcome),
            },
          ),
        ),
        Effect.asVoid,
        Effect.catchIf(isAlreadyRecorded, () => Effect.void),
        // oxlint-disable-next-line promise/prefer-await-to-callbacks -- Effect.mapError transforms the typed Effect failure channel; this is not Promise callback control flow.
        Effect.mapError((error) => workerFailure(error, 'Privacy owner-outcome recording')),
      ),
  };
};

const unavailableGateway = (cause: unknown): PrivacyMeasureOwnerGatewayService => {
  const fail = (operation: string) => Effect.fail(workerFailure(cause, operation));
  return {
    execute: () => fail('Party Registry Privacy Measure Action'),
    load: () => fail('Party Registry receipt read'),
    report: () => fail('Privacy owner-outcome recording'),
  };
};

export const PrivacyMeasureOwnerGatewayLive = Layer.effect(
  PrivacyMeasureOwnerGateway,
  configuration.pipe(Effect.match({ onFailure: unavailableGateway, onSuccess: makeGateway })),
);
