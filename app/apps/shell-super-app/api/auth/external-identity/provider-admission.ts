/**
 * The Core services of the installed external identity provider: the namespace registry behind the staff registry,
 * and the trusted admission services bounded by the admission deadline the provider module declares.
 */
import {
  AuthenticationNamespaceRegistry,
  makeAuthenticationNamespaceRegistryEffect,
  makeTrustedAuthenticationAdmissionService,
  makeTrustedExternalSubjectAdmissionService,
  TrustedAuthenticationAdmissionService,
  TrustedExternalSubjectAdmissionService,
} from '@app/core-runtime/auth/external-identity-admission';
import { staffAuthenticationNamespaceRegistration } from '@app/core-runtime/auth/staff-authentication-namespace';
import { Context, Effect, Layer, Option } from 'effect';

import { SHELL_STAFF_AUDIENCES } from '../authentication-namespace-registry.ts';
import {
  ExternalIdentityProviderConfigurationService,
  externalIdentityProviderRegistrationOf,
} from '../external-identity-provider.ts';
import { ExternalIdentityHttpConfigurationService } from './configuration.ts';
import { InstalledExternalIdentityProviderResolver } from './provider-resolver.ts';

/**
 * Staff registrations stay authoritative; the configured namespace is registered only while the active composition
 * installs a module that declares it.
 */
export const ExternalIdentityProviderNamespaceRegistryLive = Layer.effect(
  AuthenticationNamespaceRegistry,
  Effect.gen(function* makeExternalIdentityProviderNamespaceRegistry() {
    // The staff registry is the fixed first lookup of this merged registry.
    const staff = yield* staffAuthenticationNamespaceRegistration(SHELL_STAFF_AUDIENCES).pipe(
      Effect.flatMap((registration) => makeAuthenticationNamespaceRegistryEffect([registration])),
    );
    const configuration = yield* ExternalIdentityProviderConfigurationService;
    const resolver = yield* InstalledExternalIdentityProviderResolver;
    const providerRegistration = resolver.find.pipe(
      Effect.map(Option.map(({ declaration }) => externalIdentityProviderRegistrationOf(configuration, declaration))),
    );
    return {
      lookup: (authenticationNamespaceId) =>
        staff
          .lookup(authenticationNamespaceId)
          .pipe(
            Effect.filterOrElse(Option.isSome, () =>
              authenticationNamespaceId === configuration.authenticationNamespaceId
                ? providerRegistration
                : Effect.succeedNone,
            ),
          ),
    };
  }),
);

/**
 * Core's trusted admission services, bounded by the admission deadline the provider module declares, plus the
 * workload-boundary configuration of the external identity HTTP handlers.
 */
export const ExternalIdentityProviderAdmissionLive = Layer.effectContext(
  Effect.gen(function* makeExternalIdentityProviderAdmission() {
    const configuration = yield* ExternalIdentityProviderConfigurationService;
    const resolver = yield* InstalledExternalIdentityProviderResolver;
    const options = resolver.resolve.pipe(
      Effect.map(({ declaration }) => ({
        attesterPrincipalId: configuration.attesterPrincipalId,
        maxAdmissionWindowMillis: declaration.admissionDeadlineMs,
      })),
    );
    return Context.make(ExternalIdentityHttpConfigurationService, {
      grants: configuration.grants,
      providerEndpointAudience: configuration.providerEndpointAudience,
    }).pipe(
      Context.add(TrustedAuthenticationAdmissionService, {
        verify: (input) =>
          options.pipe(Effect.flatMap((resolved) => makeTrustedAuthenticationAdmissionService(resolved).verify(input))),
      }),
      Context.add(TrustedExternalSubjectAdmissionService, {
        admit: (input) =>
          options.pipe(Effect.flatMap((resolved) => makeTrustedExternalSubjectAdmissionService(resolved).admit(input))),
      }),
    );
  }),
);
