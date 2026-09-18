/* eslint-disable oxc/no-barrel-file, sonarjs/no-wildcard-import -- Generated owner client root publishes the exact generated Action clients from one stable package entrypoint. expires: 2027-03-31. */
import { Effect, makeEffectHttpApiClient } from '@modern-js/bff-effect/effect-client';
import type {
  HttpClientError,
  HttpApi,
  HttpApiClient,
  HttpApiGroup,
  Schema,
} from '@modern-js/bff-effect/effect-client';

import { privacyApiContract, privacyApi, privacyOperationContexts } from '../../shared/api.ts';
import type { OperationContext, PrivacyReadiness } from '../../shared/api.ts';

// oxlint-disable-next-line effect-native/no-scattered-browser-effect-run -- Generated public compatibility surface for Action clients.
export { Effect, runEffectRequest } from '@modern-js/bff-effect/effect-client';
// <generated-action-http-client-exports>
export * from './add-processing-purpose-version-action-client.ts';
export * from './assign-dsr-resolver-action-client.ts';
export * from './assign-legal-basis-action-client.ts';
export * from './assign-privacy-responsibility-action-client.ts';
export * from './consent-self-service-action-client.ts';
export * from './create-dsr-case-action-client.ts';
export * from './create-notice-version-action-client.ts';
export * from './create-privacy-subject-action-client.ts';
export * from './create-processing-activity-action-client.ts';
export * from './create-processing-purpose-action-client.ts';
export * from './dispatch-privacy-measure-action-client.ts';
export * from './enqueue-retention-evaluation-action-client.ts';
export * from './evaluate-processing-eligibility-action-client.ts';
export * from './issue-dsr-delivery-access-action-client.ts';
export * from './record-anti-resurrection-protection-action-client.ts';
export * from './record-applicability-policy-action-client.ts';
export * from './record-consent-decision-action-client.ts';
export * from './record-disposition-decision-action-client.ts';
export * from './record-dsr-deadline-action-client.ts';
export * from './record-dsr-delivery-evidence-action-client.ts';
export * from './record-dsr-response-action-client.ts';
export * from './record-dsr-substantive-decision-action-client.ts';
export * from './record-dsr-verification-action-client.ts';
export * from './record-external-obligation-action-client.ts';
export * from './record-legal-hold-action-client.ts';
export * from './record-notice-provision-action-client.ts';
export * from './record-owner-contribution-action-client.ts';
export * from './record-owner-execution-outcome-action-client.ts';
export * from './record-privacy-applicability-action-client.ts';
export * from './record-privacy-representation-action-client.ts';
export * from './record-processing-intervention-action-client.ts';
export * from './record-retention-exception-action-client.ts';
export * from './transition-processing-activity-action-client.ts';
export * from './update-dsr-case-action-client.ts';
export * from './upsert-dsr-owner-task-action-client.ts';
export * from './upsert-retention-rule-action-client.ts';
export * from './upsert-temporary-dsr-export-action-client.ts';
// </generated-action-http-client-exports>

type PrivacyApiGroups = typeof privacyApi extends HttpApi.HttpApi<infer _ApiId, infer Groups> ? Groups : never;

export type PrivacyClient = HttpApiClient.Client<Extract<PrivacyApiGroups, HttpApiGroup.Constraint>>;

export type PrivacyClientError = HttpClientError.HttpClientError | Schema.SchemaError;

export type PrivacyClientEffect<Success> = Effect.Effect<Success, PrivacyClientError>;

export interface PrivacyClientOptions {
  baseUrl?: string | URL;
  locale?: string;
  operationContext?: OperationContext;
  // eslint-disable-next-line effect-native/no-threaded-correlation-parameter -- Standard W3C request transport metadata accepted by the owner BFF, not ambient application state. expires: 2027-03-31.
  traceparent?: string;
}

/* jscpd:ignore-start -- Generated client initialization intentionally follows the stable owner-client request-context protocol. */
export const createPrivacyClient = (options: PrivacyClientOptions = {}): PrivacyClientEffect<PrivacyClient> => {
  /* oxlint-disable anti-slop/no-known-value-widening, effect-native/no-threaded-correlation-parameter -- This request fragment preserves optional public wire metadata, including the caller-supplied W3C trace header. expires: 2027-03-31. */
  const requestContext: {
    locale?: string;
    operationContext?: OperationContext;
    traceparent?: string;
  } = {};
  /* oxlint-enable anti-slop/no-known-value-widening, effect-native/no-threaded-correlation-parameter */
  if (options.locale !== undefined) {
    Object.assign(requestContext, { locale: options.locale });
  }
  if (options.operationContext !== undefined) {
    Object.assign(requestContext, { operationContext: options.operationContext });
  }
  if (options.traceparent !== undefined) {
    Object.assign(requestContext, { traceparent: options.traceparent });
  }
  // eslint-disable-next-line effect-native/no-per-operation-http-api-client -- Public factory supports caller-specific base URLs and metadata without retaining cross-request mutable state. expires: 2027-03-31.
  return makeEffectHttpApiClient(privacyApi, {
    baseUrl: options.baseUrl ?? privacyApiContract.apiPrefix,
    requestContext,
  });
};
/* jscpd:ignore-end */

export const getPrivacyReadiness = (options: PrivacyClientOptions = {}): PrivacyClientEffect<PrivacyReadiness> =>
  // oxlint-disable-next-line effect-native/no-per-operation-http-api-client -- Generated wrapper delegates caller-specific transport configuration to the public client factory. expires: 2027-03-31.
  createPrivacyClient({
    ...options,
    operationContext: options.operationContext ?? privacyOperationContexts.readiness,
  }).pipe(Effect.flatMap((client) => client.foundation.readiness({})));
