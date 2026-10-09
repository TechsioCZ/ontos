import {
  externalIdentityFailure,
  TrustedAuthenticationAdmissionService,
  TrustedExternalSubjectAdmissionService,
} from '@app/core-runtime/auth/external-identity-admission';
import { Effect, Layer } from 'effect';

import { ExternalIdentityHttpConfigurationService } from './external-identity/configuration.ts';

/** An installation without an external provider grants no external identity operations. */
export const ExternalIdentityNotInstalledLive = Layer.mergeAll(
  Layer.succeed(ExternalIdentityHttpConfigurationService, {
    grants: [],
    providerEndpointAudience: 'shell-super-app',
  }),
  Layer.succeed(TrustedAuthenticationAdmissionService, {
    verify: () =>
      Effect.fail(externalIdentityFailure('identity_unavailable', 'External authentication is not installed')),
  }),
  Layer.succeed(TrustedExternalSubjectAdmissionService, {
    admit: () =>
      Effect.fail(externalIdentityFailure('identity_unavailable', 'External subject admission is not installed')),
  }),
);

export type ExternalIdentityDeploymentLayer = Layer.Layer<
  | ExternalIdentityHttpConfigurationService
  | TrustedAuthenticationAdmissionService
  | TrustedExternalSubjectAdmissionService
>;
