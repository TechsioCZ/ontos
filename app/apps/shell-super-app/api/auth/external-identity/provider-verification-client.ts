/**
 * Calls the verification endpoint an external identity provider module declares in its contract. Every call carries
 * a fresh gateway assertion addressed to the provider endpoint audience, minted for the exact workload operation the
 * request context grants.
 */
import { externalIdentityFailure } from '@app/core-runtime/auth/external-identity-admission';
import type { ExternalIdentityFailure } from '@app/core-runtime/auth/external-identity-admission';
import { ExternalIdentityVerificationResultSchema } from '@app/core-runtime/auth/external-identity-provider';
import type {
  ExternalIdentityVerificationRequest,
  ExternalIdentityVerificationResult,
} from '@app/core-runtime/auth/external-identity-provider';
import { Context, Effect, Layer, Redacted } from 'effect';
import type { Option } from 'effect';
import { HttpClient, HttpClientRequest, HttpClientResponse } from 'effect/unstable/http';

import { ExternalIdentityProviderConfigurationService } from '../external-identity-provider.ts';
import type {
  ExternalIdentityProviderConfiguration,
  InstalledExternalIdentityProvider,
} from '../external-identity-provider.ts';
import { GatewayIssuer } from '../gateway-issuer.ts';
import { ExternalIdentityHttpConfigurationService } from './configuration.ts';
import { ExternalIdentityHttpWorkloadContext } from './request-context.ts';
import { ExternalIdentityWorkloadAuthorization } from './workload-authorization.ts';
import type { ExternalIdentityWorkloadGrantInput } from './workload-authorization.ts';

const providerUnavailable = (reason: string, cause?: unknown): ExternalIdentityFailure =>
  externalIdentityFailure('identity_unavailable', reason, cause);

const requireService = <Service>(
  service: Effect.Effect<Option.Option<Service>>,
  reason: string,
): Effect.Effect<Service, ExternalIdentityFailure> =>
  service.pipe(Effect.flatMap((option) => Effect.fromOption(option, () => providerUnavailable(reason))));

/**
 * The bearer assertion for one verification call. The request is received by the provider endpoint audience, so that
 * is the only audience it may name; a downstream `gateway-context` target is checked against the admission instead.
 */
export const acquireExternalIdentityWorkloadAssertion = Effect.fn('ExternalIdentityWorkloadAssertion.acquire')(
  function* acquire(
    configuration: ExternalIdentityProviderConfiguration,
    request: ExternalIdentityVerificationRequest,
    verificationAudience: string,
  ) {
    const context = yield* requireService(
      Effect.serviceOption(ExternalIdentityHttpWorkloadContext),
      'The external identity request context is unavailable',
    );
    const workloadAuthorization = yield* requireService(
      Effect.serviceOption(ExternalIdentityWorkloadAuthorization),
      'The external identity workload authorization service is unavailable',
    );
    let grantInput: ExternalIdentityWorkloadGrantInput;
    if (context.targetAudience !== undefined) {
      grantInput =
        context.targetAuthenticationNamespaceId === undefined
          ? { operation: context.operation, targetAudience: context.targetAudience }
          : {
              operation: context.operation,
              targetAudience: context.targetAudience,
              targetAuthenticationNamespaceId: context.targetAuthenticationNamespaceId,
            };
    } else if (context.targetAuthenticationNamespaceId === undefined) {
      grantInput = { operation: context.operation };
    } else {
      grantInput = {
        operation: context.operation,
        targetAuthenticationNamespaceId: context.targetAuthenticationNamespaceId,
      };
    }
    yield* workloadAuthorization.authorizePrincipal(context.principal, grantInput).pipe(
      // oxlint-disable-next-line effect-native/no-effect-provide-in-library -- The factory owns this exact validated grant configuration.
      Effect.provideService(ExternalIdentityHttpConfigurationService, {
        grants: configuration.grants,
        providerEndpointAudience: configuration.providerEndpointAudience,
      }),
      Effect.mapError((cause) =>
        providerUnavailable('The Shell workload is not authorized to call provider verification', cause),
      ),
    );
    if (context.operation !== request.authenticationOperation) {
      return yield* providerUnavailable('The provider authentication operation changed during admission');
    }
    if (context.principal.tenantId !== request.tenantId) {
      return yield* providerUnavailable('The external identity workload tenant changed during admission');
    }
    if (request.authenticationNamespaceId !== configuration.authenticationNamespaceId) {
      return yield* providerUnavailable('The external identity authentication namespace changed during admission');
    }
    if (request.audience !== configuration.providerEndpointAudience) {
      return yield* providerUnavailable('The external identity receiving audience changed during admission');
    }
    const issuer = yield* requireService(
      Effect.serviceOption(GatewayIssuer),
      'The gateway assertion issuer is unavailable',
    );
    const response = yield* issuer
      .issue({
        audience: verificationAudience,
        compositionRevision: context.compositionRevision,
        principal: context.principal,
      })
      .pipe(
        Effect.mapError((cause) =>
          providerUnavailable('The Shell workload is not authorized to call provider verification', cause),
        ),
      );
    return Redacted.make(`Bearer ${response.token}`);
  },
);

export interface ExternalIdentityVerificationClientService {
  readonly verify: (
    installed: InstalledExternalIdentityProvider,
    request: ExternalIdentityVerificationRequest,
    options: { readonly requestCorrelation: string },
  ) => Effect.Effect<ExternalIdentityVerificationResult, ExternalIdentityFailure>;
}

export class ExternalIdentityVerificationClient extends Context.Service<
  ExternalIdentityVerificationClient,
  ExternalIdentityVerificationClientService
>()(
  '@app/shell-super-app/api/auth/external-identity/provider-verification-client/ExternalIdentityVerificationClient',
) {}

/**
 * POSTs to `<release origin>/<appId>-api<declared path>` of the module that declares the namespace: the approved
 * release in the active composition, so verification follows every publication without deployment data.
 */
export const ExternalIdentityVerificationClientLive = Layer.effect(
  ExternalIdentityVerificationClient,
  Effect.gen(function* makeExternalIdentityVerificationClient() {
    const configuration = yield* ExternalIdentityProviderConfigurationService;
    const httpClient = yield* HttpClient.HttpClient;
    const verify = Effect.fn('ExternalIdentityVerificationClient.verify')(function* verify(
      installed: InstalledExternalIdentityProvider,
      request: ExternalIdentityVerificationRequest,
      options: { readonly requestCorrelation: string },
    ) {
      const authorization = yield* acquireExternalIdentityWorkloadAssertion(configuration, request, installed.appId);
      const url = new URL(
        `/${installed.appId}-api${installed.declaration.verification.path}`,
        installed.backendBaseUrl,
      );
      return yield* HttpClientRequest.post(url).pipe(
        HttpClientRequest.setHeaders({
          authorization: Redacted.value(authorization),
          'x-correlation-id': options.requestCorrelation,
        }),
        HttpClientRequest.bodyJsonUnsafe(request),
        httpClient.execute,
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap(HttpClientResponse.schemaBodyJson(ExternalIdentityVerificationResultSchema)),
        Effect.mapError((cause) => providerUnavailable('Provider verification transport failed', cause)),
      );
    });
    return { verify };
  }),
);
