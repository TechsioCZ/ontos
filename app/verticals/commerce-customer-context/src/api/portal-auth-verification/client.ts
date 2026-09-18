import { makeEffectHttpApiClient } from '@modern-js/bff-effect/effect-client';
import type { HttpApi, HttpApiClient, HttpApiGroup } from '@modern-js/bff-effect/effect-client';
import { Context, Effect, Layer, Schema } from 'effect';
import type { Redacted } from 'effect';
import { CommercePortalAuthVerificationClientUnavailable } from './client-errors.ts';
import { CommercePortalAuthVerificationClientConfigurationService } from './client-configuration.ts';
import { CommercePortalAuthVerificationWorkloadAssertion } from './workload-assertion.ts';
import type { CommercePortalAuthVerificationWorkloadAssertionService } from './workload-assertion.ts';
import {
  CommercePortalAuthVerificationApi,
  CommercePortalAuthVerificationRequestSchema,
} from '../../../shared/portal-auth-verification.ts';
import type { CommercePortalAuthVerificationRequest } from '../../../shared/portal-auth-verification.ts';
import type { VerifyExternalAuthenticationResult } from '../../../shared/portal-auth-contracts.ts';

type CommercePortalAuthVerificationApiGroups =
  typeof CommercePortalAuthVerificationApi extends HttpApi.HttpApi<infer _ApiId, infer Groups> ? Groups : never;

export type CommercePortalAuthVerificationGeneratedClient = HttpApiClient.Client<
  Extract<CommercePortalAuthVerificationApiGroups, HttpApiGroup.Constraint>
>;

export interface CommercePortalAuthVerificationClientRequestOptions {
  readonly requestCorrelation: string;
}

export interface CommercePortalAuthVerificationClientPort {
  readonly verify: (
    request: CommercePortalAuthVerificationRequest,
    options: CommercePortalAuthVerificationClientRequestOptions,
  ) => Effect.Effect<VerifyExternalAuthenticationResult, CommercePortalAuthVerificationClientUnavailable>;
}

export class CommercePortalAuthVerificationClient extends Context.Service<
  CommercePortalAuthVerificationClient,
  CommercePortalAuthVerificationClientPort
>()('@app/commerce-customer-context/api/portal-auth-verification/client/CommercePortalAuthVerificationClient') {}

const mapTransportFailure = (cause: unknown) =>
  Object.defineProperty(
    new CommercePortalAuthVerificationClientUnavailable({
      reason: 'Commerce provider verification transport failed',
    }),
    'cause',
    { configurable: true, value: cause },
  );

export const makeCommercePortalAuthVerificationClient = Effect.fn('CommercePortalAuthVerificationClient.make')(
  function* makeCommercePortalAuthVerificationClient() {
    const configuration = yield* CommercePortalAuthVerificationClientConfigurationService;
    const authorization: CommercePortalAuthVerificationWorkloadAssertionService =
      yield* CommercePortalAuthVerificationWorkloadAssertion;
    const generated: CommercePortalAuthVerificationGeneratedClient = yield* makeEffectHttpApiClient(
      CommercePortalAuthVerificationApi,
      {
        baseUrl: configuration.baseUrl,
      },
    );

    const verify = Effect.fn('CommercePortalAuthVerificationClient.verify')(function* verify(
      request: CommercePortalAuthVerificationRequest,
      options: CommercePortalAuthVerificationClientRequestOptions,
    ): Effect.fn.Return<VerifyExternalAuthenticationResult, CommercePortalAuthVerificationClientUnavailable> {
      const workloadAuthorization: Redacted.Redacted = yield* authorization.acquire({
        request,
        requestCorrelation: options.requestCorrelation,
      });
      return yield* generated.externalAuthenticationVerification
        .verifyExternalAuthentication({
          headers: {
            authorization: workloadAuthorization,
            'x-correlation-id': options.requestCorrelation,
          },
          payload: request,
        })
        .pipe(Effect.mapError(mapTransportFailure));
    });

    return { verify };
  },
);

export const commercePortalAuthVerificationClientLive = Layer.effect(
  CommercePortalAuthVerificationClient,
  makeCommercePortalAuthVerificationClient(),
);

/** Decode at the caller boundary before making a fresh workload request. */
export const verifyCommercePortalAuthentication = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Decode the transport boundary before invoking the typed client.
  request: unknown,
  options: CommercePortalAuthVerificationClientRequestOptions,
): Effect.Effect<
  VerifyExternalAuthenticationResult,
  CommercePortalAuthVerificationClientUnavailable | Schema.SchemaError,
  CommercePortalAuthVerificationClient
> =>
  Schema.decodeUnknownEffect(CommercePortalAuthVerificationRequestSchema)(request).pipe(
    Effect.flatMap((decodedRequest) =>
      Effect.service(CommercePortalAuthVerificationClient).pipe(
        Effect.flatMap((client) => client.verify(decodedRequest, options)),
      ),
    ),
  );

export { CommercePortalAuthVerificationClientUnavailable } from './client-errors.ts';
export { CommercePortalAuthVerificationClientConfigurationService } from './client-configuration.ts';
export type { CommercePortalAuthVerificationClientConfiguration } from './client-configuration.ts';
export { CommercePortalAuthVerificationWorkloadAssertion } from './workload-assertion.ts';
export type {
  CommercePortalAuthVerificationWorkloadAssertionInput,
  CommercePortalAuthVerificationWorkloadAssertionService,
} from './workload-assertion.ts';
