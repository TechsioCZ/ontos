/**
 * Composition-root wiring of the optional external identity provider. Deployment data (JSON in
 * `ONTOS_COMMERCE_EXTERNAL_IDENTITY_DEPLOYMENT`) names the namespace, attester and grants; the module
 * that declares that namespace in the active composition supplies the rest. Both layers need the Shell's installed
 * module catalog, which the composition root provides.
 */
import { ContextAccessLive } from '@app/core-runtime';
import type { ContextAccess } from '@app/core-runtime';
import type {
  AuthenticationNamespaceRegistry,
  TrustedAuthenticationAdmissionService,
  TrustedExternalSubjectAdmissionService,
} from '@app/core-runtime/auth/external-identity-admission';
import { Config, ConfigProvider, Effect, Layer, Option, Schema } from 'effect';
import { FetchHttpClient } from 'effect/http';

import type { ShellInstalledModuleCatalog } from '../modules/installed-module-catalog.ts';
import { StaffAuthenticationNamespaceRegistryLive } from './authentication-namespace-registry.ts';
import { loadConfigurationProvider } from './configuration-provider.ts';
import {
  decodeExternalIdentityProviderConfiguration,
  ExternalIdentityProviderConfigurationService,
} from './external-identity-provider.ts';
import {
  ExternalIdentityProviderAdmissionLive,
  ExternalIdentityProviderNamespaceRegistryLive,
} from './external-identity/provider-admission.ts';
import { InstalledExternalIdentityProviderResolverLive } from './external-identity/provider-resolver.ts';
import type { ExternalIdentityHttpConfigurationService } from './external-identity/configuration.ts';
import { ProviderAdmissionObservationLive } from './external-identity/provider-admission-observation.ts';
import { ExternalIdentityVerificationClientLive } from './external-identity/provider-verification-client.ts';
import { ExternalIdentityNotInstalledLive } from './external-identity-runtime.ts';

/* oxlint-disable effect-native/no-layer-provide-in-library -- This deployment factory is the composition seam that binds validated provider data to its owner layers before the application root provides the installed module catalog. */
const providerBaseLive = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- The provider configuration decode is the trusted boundary.
  input: unknown,
) => {
  const configurationLive = Layer.effect(
    ExternalIdentityProviderConfigurationService,
    decodeExternalIdentityProviderConfiguration(input).pipe(Effect.orDie),
  );
  return Layer.merge(
    configurationLive,
    InstalledExternalIdentityProviderResolverLive.pipe(Layer.provide(configurationLive)),
  );
};

const providerContextAccessLive = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- The provider configuration decode is the trusted boundary.
  input: unknown,
) =>
  Layer.mergeAll(
    ContextAccessLive,
    StaffAuthenticationNamespaceRegistryLive,
    ExternalIdentityProviderNamespaceRegistryLive.pipe(Layer.provide(providerBaseLive(input))),
  );

const providerDeploymentLive = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- The provider configuration decode is the trusted boundary.
  input: unknown,
) => {
  const base = providerBaseLive(input);
  const client = ExternalIdentityVerificationClientLive.pipe(Layer.provide(Layer.merge(base, FetchHttpClient.layer)));
  return Layer.mergeAll(
    ExternalIdentityProviderAdmissionLive,
    ProviderAdmissionObservationLive.pipe(Layer.provide(client)),
  ).pipe(Layer.provide(base));
};
/* oxlint-enable effect-native/no-layer-provide-in-library */

const staffContextAccessLive = Layer.mergeAll(ContextAccessLive, StaffAuthenticationNamespaceRegistryLive);

export interface ExternalIdentityProviderDeployment {
  /**
   * ContextAccess plus the merged staff/provider registry. Passed as the runtime's contextAccessLayer so Actions and
   * Reads observe the same registry as the HTTP handlers.
   */
  readonly contextAccessLayer: Layer.Layer<
    ContextAccess | AuthenticationNamespaceRegistry,
    Layer.Error<typeof staffContextAccessLive>,
    ShellInstalledModuleCatalog
  >;
  /** Provider client, fresh workload assertions, and admission services. */
  readonly externalIdentityDeploymentLayer: Layer.Layer<
    | ExternalIdentityHttpConfigurationService
    | TrustedAuthenticationAdmissionService
    | TrustedExternalSubjectAdmissionService,
    never,
    ShellInstalledModuleCatalog
  >;
}

/**
 * Builds the optional provider deployment from trusted deployment data. Without data the Shell keeps the staff-only
 * context and unavailable external identity services.
 */
export const makeExternalIdentityProviderDeployment = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- The composition boundary validates optional deployment data.
  input?: unknown,
): ExternalIdentityProviderDeployment =>
  input === undefined
    ? {
        contextAccessLayer: staffContextAccessLive,
        externalIdentityDeploymentLayer: ExternalIdentityNotInstalledLive,
      }
    : {
        contextAccessLayer: providerContextAccessLive(input),
        externalIdentityDeploymentLayer: providerDeploymentLive(input),
      };

const EXTERNAL_IDENTITY_PROVIDER_DEPLOYMENT_ENV_KEY = 'ONTOS_COMMERCE_EXTERNAL_IDENTITY_DEPLOYMENT';
type ExternalIdentityProviderDeploymentEnvironment = Readonly<
  Partial<Record<typeof EXTERNAL_IDENTITY_PROVIDER_DEPLOYMENT_ENV_KEY, string>>
>;

export class ExternalIdentityProviderDeploymentConfigError extends Schema.TaggedError<ExternalIdentityProviderDeploymentConfigError>()(
  'ExternalIdentityProviderDeploymentConfigError',
  { reason: Schema.String },
) {}

const malformedConfiguration = () =>
  new ExternalIdentityProviderDeploymentConfigError({
    reason: 'External identity provider deployment configuration is missing or malformed',
  });

const unableToLoadEnvironment = () =>
  new ExternalIdentityProviderDeploymentConfigError({
    reason: 'Unable to load the external identity provider deployment environment',
  });

/**
 * Unset in every deployment without an external identity provider, so the runtime keeps the staff-only defaults. A
 * present but malformed value fails. Only the JSON envelope is parsed here; the trusted-boundary decode happens once in
 * `makeExternalIdentityProviderDeployment`.
 */
const deploymentInputConfig = Config.option(
  Config.schema(Schema.fromJsonString(Schema.Json), EXTERNAL_IDENTITY_PROVIDER_DEPLOYMENT_ENV_KEY),
);

const parseDeploymentInputFromProvider = Effect.fn('ExternalIdentityProviderDeployment.parseInput')(
  function* parseConfiguration(provider: ConfigProvider.ConfigProvider) {
    const input = yield* deploymentInputConfig
      .parse(provider)
      .pipe(Effect.catchTag('ConfigError', () => Effect.fail(malformedConfiguration())));
    return Option.getOrUndefined(input);
  },
);

/** Parses the deployment input from an explicit environment record, bypassing the dotenv-file fallback. */
export const parseExternalIdentityProviderDeploymentInput = (
  environment: ExternalIdentityProviderDeploymentEnvironment,
): Effect.Effect<unknown, ExternalIdentityProviderDeploymentConfigError> =>
  parseDeploymentInputFromProvider(ConfigProvider.fromEnvRecord(environment));

const loadDeploymentInput = (): Effect.Effect<unknown, ExternalIdentityProviderDeploymentConfigError> =>
  loadConfigurationProvider({}, unableToLoadEnvironment).pipe(Effect.flatMap(parseDeploymentInputFromProvider));

/** Production composition root: the merged staff/provider registry Actions and Reads observe. */
export const ExternalIdentityProviderContextAccessLive: ExternalIdentityProviderDeployment['contextAccessLayer'] =
  Layer.unwrap(
    loadDeploymentInput().pipe(
      Effect.orDie,
      Effect.map((input) => makeExternalIdentityProviderDeployment(input).contextAccessLayer),
    ),
  );

/** Production composition root: the provider client, workload assertions, and admission services. */
export const ExternalIdentityProviderDeploymentLive: ExternalIdentityProviderDeployment['externalIdentityDeploymentLayer'] =
  Layer.unwrap(
    loadDeploymentInput().pipe(
      Effect.orDie,
      Effect.map((input) => makeExternalIdentityProviderDeployment(input).externalIdentityDeploymentLayer),
    ),
  );
