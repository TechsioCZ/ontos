import { Effect, Layer } from '@modern-js/bff-effect/effect-edge';
import { HttpApiError } from 'effect/unstable/httpapi';
import type { HttpServerResponse } from 'effect/unstable/http';

import {
  CommercePortalAuthStepUpForbiddenProblemSchema,
  CommercePortalAuthStepUpInvalidProblemSchema,
  CommercePortalAuthStepUpRejectedProblemSchema,
  CommercePortalAuthStepUpSchemaErrorMiddleware,
  CommercePortalAuthStepUpUnavailableProblemSchema,
} from '../../../../shared/portal-auth/step-up-api.ts';

const problemStatus = {
  forbidden: 403,
  invalid: 400,
  rejected: 401,
  unavailable: 503,
} as const;

export const commercePortalAuthStepUpInvalidProblem = CommercePortalAuthStepUpInvalidProblemSchema.make({
  code: 'invalid_request',
  detail: 'The step-up request is invalid.',
  status: problemStatus.invalid,
  title: 'Invalid step-up request',
  type: 'https://ontos.dev/problems/commerce-portal-auth-step-up-invalid',
});

export const commercePortalAuthStepUpRejectedProblem = CommercePortalAuthStepUpRejectedProblemSchema.make({
  code: 'step_up_rejected',
  detail: 'Step-up verification was rejected.',
  status: problemStatus.rejected,
  title: 'Step-up rejected',
  type: 'https://ontos.dev/problems/commerce-portal-auth-step-up-rejected',
});

export const commercePortalAuthStepUpForbiddenProblem = CommercePortalAuthStepUpForbiddenProblemSchema.make({
  code: 'origin_not_trusted',
  detail: 'The request origin is not trusted for commerce portal step-up.',
  status: problemStatus.forbidden,
  title: 'Step-up origin not trusted',
  type: 'https://ontos.dev/problems/commerce-portal-auth-step-up-forbidden',
});

export const commercePortalAuthStepUpUnavailableProblem = CommercePortalAuthStepUpUnavailableProblemSchema.make({
  detail: 'Commerce portal step-up is temporarily unavailable.',
  retryable: true,
  status: problemStatus.unavailable,
  title: 'Step-up unavailable',
  type: 'https://ontos.dev/problems/commerce-portal-auth-step-up-unavailable',
});

/**
 * `HttpApiBuilder`'s payload decoder answers a *raw* 415 `HttpServerResponse` on content-type
 * mismatch (`decodePayload` in `HttpApiBuilder.ts`) — a success value, not an `HttpApiSchemaError` —
 * so `layerSchemaErrorTransform`'s `Effect.catch` alone never sees it; this rewrites it to the same
 * Invalid problem.
 */
const rewriteUnsupportedContentType = (response: HttpServerResponse.HttpServerResponse) =>
  response.status === 415 ? Effect.fail(commercePortalAuthStepUpInvalidProblem) : Effect.succeed(response);

/**
 * Built directly on `Layer.succeed` — the same primitive `HttpApiMiddleware.layerSchemaErrorTransform`
 * is built on — rather than on that helper, because it must also apply
 * `rewriteUnsupportedContentType` to the response channel, not only map `HttpApiSchemaError` (every
 * other schema failure: excess properties, malformed JSON, bad params) on the error channel.
 */
export const commercePortalAuthStepUpSchemaErrorLive = Layer.succeed(
  CommercePortalAuthStepUpSchemaErrorMiddleware,
  (httpEffect, _options) =>
    httpEffect.pipe(
      Effect.flatMap(rewriteUnsupportedContentType),
      Effect.catchIf(
        (error) => HttpApiError.HttpApiSchemaError.is(error),
        () => Effect.fail(commercePortalAuthStepUpInvalidProblem),
      ),
    ),
);
