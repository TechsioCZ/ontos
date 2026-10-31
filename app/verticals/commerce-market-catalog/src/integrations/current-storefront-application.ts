import type { OperationalScope } from '@app/core-runtime';
import { CurrentStorefrontApplicationResponseSchema } from '@app/storefront-registry-contracts';
import type {
  CurrentStorefrontApplicationRequest,
  CurrentStorefrontApplicationResponse,
} from '@app/storefront-registry-contracts';
import { executeCurrentStorefrontApplicationWithAuthorization } from '@app/storefront-registry-contracts/current-storefront-application/client';
import { Effect, Redacted, Schema } from 'effect';
import type { Crypto } from 'effect';

import { acquireOwnerGatewayContext } from './server-owner-gateway.ts';

import { StorefrontApplicationEvidenceStale } from '../actions/storefront-application-evidence-stale.ts';
import { StorefrontApplicationNotCurrent } from '../actions/storefront-application-not-current.ts';
import { StorefrontApplicationValidationUnavailable } from '../actions/storefront-application-validation-unavailable.ts';

export { StorefrontApplicationEvidenceStale } from '../actions/storefront-application-evidence-stale.ts';
export { StorefrontApplicationNotCurrent } from '../actions/storefront-application-not-current.ts';
export { StorefrontApplicationValidationUnavailable } from '../actions/storefront-application-validation-unavailable.ts';

export type StorefrontApplicationValidationFailure =
  | StorefrontApplicationEvidenceStale
  | StorefrontApplicationNotCurrent
  | StorefrontApplicationValidationUnavailable;

type CurrentResponse = Extract<CurrentStorefrontApplicationResponse, { readonly outcome: 'CURRENT' }>;

export type CurrentStorefrontApplicationEvidence = Pick<
  CurrentResponse,
  'nextApplicabilityBoundary' | 'observedAt' | 'ownerRevision'
>;

export interface CurrentStorefrontApplicationAuthority {
  readonly validateCurrent: (
    input: CurrentStorefrontApplicationRequest,
    requestCorrelation: string,
  ) => Effect.Effect<CurrentStorefrontApplicationEvidence, StorefrontApplicationValidationFailure>;
}

type ExecuteCurrentStorefrontApplication = (
  input: CurrentStorefrontApplicationRequest,
  requestCorrelation: string,
) => Effect.Effect<
  CurrentStorefrontApplicationResponse,
  | Effect.Error<ReturnType<typeof executeCurrentStorefrontApplicationWithAuthorization>>
  | StorefrontApplicationValidationUnavailable
>;

const unavailable = (reason: string, cause?: unknown): StorefrontApplicationValidationUnavailable => {
  const failure = new StorefrontApplicationValidationUnavailable({
    code: 'storefront_application_validation_unavailable',
    reason,
  });
  if (cause !== undefined) {
    Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  }
  return failure;
};

const stale = (reason: string): StorefrontApplicationEvidenceStale =>
  new StorefrontApplicationEvidenceStale({ code: 'storefront_application_evidence_stale', reason });

const notCurrent = (reason: string): StorefrontApplicationNotCurrent =>
  new StorefrontApplicationNotCurrent({ code: 'storefront_application_not_current', reason });

const identityMatches = (
  request: CurrentStorefrontApplicationRequest,
  response: CurrentStorefrontApplicationResponse,
): boolean =>
  response.tenantId === request.tenantId &&
  response.storefrontAppId === request.storefrontAppId &&
  response.requestedChannel === request.requestedChannel &&
  response.effectiveAt === request.effectiveAt;

const validateResponse = (
  request: CurrentStorefrontApplicationRequest,
  response: CurrentStorefrontApplicationResponse,
): Effect.Effect<CurrentStorefrontApplicationEvidence, StorefrontApplicationValidationFailure> => {
  if (!identityMatches(request, response)) {
    return Effect.fail(stale('Storefront owner evidence does not match the exact requested scope'));
  }
  if (response.outcome === 'STALE') {
    return Effect.fail(stale(response.reason));
  }
  if (response.outcome === 'UNAVAILABLE' || response.outcome === 'UNVERIFIABLE') {
    return Effect.fail(unavailable(response.reason));
  }
  if (response.outcome !== 'CURRENT') {
    return Effect.fail(notCurrent(response.reason));
  }
  if (
    response.ownerRevision.length === 0 ||
    response.observedAt > request.effectiveAt ||
    response.effectiveInterval.effectiveFrom > request.effectiveAt ||
    (response.effectiveInterval.effectiveTo !== undefined &&
      response.effectiveInterval.effectiveTo <= request.effectiveAt) ||
    (response.nextApplicabilityBoundary !== undefined && response.nextApplicabilityBoundary <= request.effectiveAt) ||
    !response.allowedChannels.includes(request.requestedChannel)
  ) {
    return Effect.fail(stale('Storefront owner evidence is not Current at the requested instant'));
  }
  return Effect.succeed(
    response.nextApplicabilityBoundary === undefined
      ? {
          observedAt: response.observedAt,
          ownerRevision: response.ownerRevision,
        }
      : {
          nextApplicabilityBoundary: response.nextApplicabilityBoundary,
          observedAt: response.observedAt,
          ownerRevision: response.ownerRevision,
        },
  );
};

export const makeCurrentStorefrontApplicationAuthority = (
  execute: ExecuteCurrentStorefrontApplication,
): CurrentStorefrontApplicationAuthority => ({
  validateCurrent: (input, requestCorrelation) =>
    execute(input, requestCorrelation).pipe(
      Effect.mapError((cause) =>
        unavailable('The Storefront Registry Current application authority is unavailable', cause),
      ),
      Effect.flatMap((response) =>
        Schema.decodeEffect(CurrentStorefrontApplicationResponseSchema)(response).pipe(
          Effect.mapError((cause) =>
            unavailable('The Storefront Registry Current application authority returned invalid evidence', cause),
          ),
        ),
      ),
      Effect.flatMap((response) => validateResponse(input, response)),
      Effect.withSpan('CurrentStorefrontApplicationAuthority.validateCurrent'),
    ),
});

export const makeServerCurrentStorefrontApplicationAuthority = ({
  compositionRevision,
  crypto,
  scope,
}: {
  readonly compositionRevision: string;
  readonly crypto: Crypto.Crypto;
  readonly scope: OperationalScope;
}): CurrentStorefrontApplicationAuthority =>
  makeCurrentStorefrontApplicationAuthority(
    Effect.fn('CurrentStorefrontApplicationAuthority.executeStorefrontOwnerRead')(
      function* executeStorefrontOwnerRead(payload: CurrentStorefrontApplicationRequest, requestCorrelation: string) {
        if (
          payload.tenantId !== scope.tenantId ||
          scope.legalEntityId === undefined ||
          requestCorrelation !== scope.correlationId
        ) {
          return yield* unavailable(
            'Storefront validation requires the original trusted Tenant and Legal Entity scope',
          );
        }
        const admitted = yield* acquireOwnerGatewayContext(
          scope,
          crypto,
          {
            audience: 'storefront-registry',
            operationKey: 'commerce.storefront-registry.api.current-storefront-application',
          },
          compositionRevision,
        );
        return yield* executeCurrentStorefrontApplicationWithAuthorization(
          payload,
          Redacted.value(admitted.authorization),
          scope.correlationId,
          { baseUrl: admitted.apiUrl, compositionRevision },
        );
      },
      Effect.mapError((cause) =>
        unavailable('The Storefront Registry Current application authority is unavailable', cause),
      ),
    ),
  );
