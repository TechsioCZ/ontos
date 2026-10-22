/**
 * The Core services of the installed external identity provider: the namespace registry behind the staff registry,
 * and the trusted admission services bounded by the admission deadline the provider module declares.
 */
import {
  AuthenticationNamespaceRegistry,
  makeTrustedAuthenticationAdmissionService,
  makeTrustedExternalSubjectAdmissionService,
  TrustedAuthenticationAdmissionService,
  TrustedExternalSubjectAdmissionService,
} from '@app/core-runtime/auth/external-identity-admission';
import { Context, Effect, Layer, Option } from 'effect';

import { StaffAuthenticationNamespaceRegistryLive } from '../authentication-namespace-registry.ts';
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
    const staff = yield* AuthenticationNamespaceRegistry.pipe(
      // oxlint-disable-next-line effect-native/no-effect-provide-in-library -- The staff registry is the fixed first lookup of this merged registry.
      Effect.provide(StaffAuthenticationNamespaceRegistryLive),
    );
    const configuration = yield* ExternalIdentityProviderConfigurationService;
    const resolver = yield* InstalledExternalIdentityProviderResolver;
    const providerRegistration = resolver.find.pipe(
      Effect.map(Option.map(({ declaration }) => externalIdentityProviderRegistrationOf(configuration, declaration))),
    );
    return {
      lookup: (authenticationNamespaceId) =>
        staff.lookup(authenticationNamespaceId).pipe(
          Effect.flatMap((registration) => {
            if (Option.isSome(registration)) {
              return Effect.succeed(registration);
            }
            return authenticationNamespaceId === configuration.authenticationNamespaceId
              ? providerRegistration
              : Effect.succeedNone;
          }),
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
