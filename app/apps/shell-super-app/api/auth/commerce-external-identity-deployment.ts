import { ContextAccessLive } from '@app/core-runtime';
import type { ContextAccess } from '@app/core-runtime';
import { AuthenticationNamespaceRegistry } from '@app/core-runtime/auth/external-identity-admission';
import type { AuthenticationNamespaceRegistryService } from '@app/core-runtime/auth/external-identity-admission';
import { Config, ConfigProvider, Context, Effect, Layer, Option, Schema } from 'effect';

import {
  commerceAuthenticationNamespaceRegistryLive,
  commerceExternalIdentityDeploymentLayer,
} from './commerce-external-identity.ts';
import { loadConfigurationProvider } from './configuration-provider.ts';
import type { ExternalIdentityDeploymentLayer } from './external-identity-runtime.ts';
import { ExternalIdentityNotInstalledLive } from './external-identity-runtime.ts';
import { StaffAuthenticationNamespaceRegistryLive } from './authentication-namespace-registry.ts';

/**
 * Falls back to the Commerce registry only when the staff registry has no
 * registration for the namespace, keeping staff registrations authoritative.
 * Takes the Commerce lookup function (not the registry service) so the merge
 * stays a plain data transform rather than a hidden collaborator parameter.
 */
const fallbackToCommerceLookup: (
  commerceLookup: AuthenticationNamespaceRegistryService['lookup'],
  authenticationNamespaceId: Parameters<AuthenticationNamespaceRegistryService['lookup']>[0],
) => (
  registration: Effect.Success<ReturnType<AuthenticationNamespaceRegistryService['lookup']>>,
) => ReturnType<AuthenticationNamespaceRegistryService['lookup']> =
  (commerceLookup, authenticationNamespaceId) => (registration) =>
    Option.match(registration, {
      onNone: () => commerceLookup(authenticationNamespaceId),
      onSome: (found) => Effect.succeedSome(found),
    });

/**
 * Builds a merged registry from the two owner layers without allowing one
 * same-key layer to overwrite the other in the composition context.
 */
const mergedAuthenticationNamespaceRegistryLive = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- The public Commerce layer performs the trusted boundary decode.
  input: unknown,
) =>
  Layer.effectContext(
    Effect.gen(function* mergedAuthenticationNamespaceRegistry() {
      const staffContext = yield* Layer.build(StaffAuthenticationNamespaceRegistryLive);
      const commerceContext = yield* Layer.build(commerceAuthenticationNamespaceRegistryLive(input)).pipe(Effect.orDie);
      const staff = Context.get(staffContext, AuthenticationNamespaceRegistry);
      const commerce = Context.get(commerceContext, AuthenticationNamespaceRegistry);
      return Context.make(AuthenticationNamespaceRegistry, {
        lookup: (authenticationNamespaceId) =>
          staff
            .lookup(authenticationNamespaceId)
            .pipe(Effect.flatMap(fallbackToCommerceLookup(commerce.lookup, authenticationNamespaceId))),
      });
    }),
  );

const staffContextAccessLive = Layer.mergeAll(ContextAccessLive, StaffAuthenticationNamespaceRegistryLive);

type CommerceContextAccessLayer = Layer.Layer<
  ContextAccess | AuthenticationNamespaceRegistry,
  Layer.Error<typeof staffContextAccessLive>
>;

export interface CommerceExternalIdentityDeployment {
  /**
   * ContextAccess plus the merged staff/Commerce registry.  This layer is
   * passed to the runtime's contextAccessLayer argument so Actions and Reads
   * observe the same registry as the HTTP handlers.
   */
  readonly contextAccessLayer: CommerceContextAccessLayer;
  /** The provider client, fresh workload assertion, and admission services. */
  readonly externalIdentityDeploymentLayer: ExternalIdentityDeploymentLayer;
}

/**
 * Builds the optional Shell deployment from trusted composition data.  The
 * absent case retains the normal staff-only context and unavailable external
 * identity services; Commerce configuration is required only when supplied.
 */
export const makeCommerceExternalIdentityDeployment = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- The composition boundary validates optional deployment data.
  input?: unknown,
): CommerceExternalIdentityDeployment =>
  input === undefined
    ? {
        contextAccessLayer: staffContextAccessLive,
        externalIdentityDeploymentLayer: ExternalIdentityNotInstalledLive,
      }
    : {
        contextAccessLayer: Layer.mergeAll(
          ContextAccessLive,
          StaffAuthenticationNamespaceRegistryLive,
          mergedAuthenticationNamespaceRegistryLive(input),
        ),
        externalIdentityDeploymentLayer: commerceExternalIdentityDeploymentLayer(input),
      };

const COMMERCE_EXTERNAL_IDENTITY_DEPLOYMENT_ENV_KEY = 'ONTOS_COMMERCE_EXTERNAL_IDENTITY_DEPLOYMENT';
type CommerceExternalIdentityDeploymentEnvironmentKey = typeof COMMERCE_EXTERNAL_IDENTITY_DEPLOYMENT_ENV_KEY;
type CommerceExternalIdentityDeploymentEnvironment = Readonly<
  Partial<Record<CommerceExternalIdentityDeploymentEnvironmentKey, string>>
>;

export class CommerceExternalIdentityDeploymentConfigError extends Schema.TaggedError<CommerceExternalIdentityDeploymentConfigError>()(
  'CommerceExternalIdentityDeploymentConfigError',
  { reason: Schema.String },
) {}

const malformedConfiguration = () =>
  new CommerceExternalIdentityDeploymentConfigError({
    reason: 'Commerce external identity deployment configuration is missing or malformed',
  });

const unableToLoadEnvironment = () =>
  new CommerceExternalIdentityDeploymentConfigError({
    reason: 'Unable to load the Commerce external identity deployment environment',
  });

/**
 * Unset in every deployment that has not onboarded Commerce external
 * identity, so `Config.option` resolves to `Option.none` and the runtime
 * keeps the staff-only, external-identity-unavailable defaults.  A present
 * but syntactically malformed value fails this Config (not silently
 * ignored).  This only parses the JSON envelope — it deliberately does NOT
 * decode against `CommerceExternalIdentityConfigurationSchema`, because
 * `makeCommerceExternalIdentityDeployment` performs that trusted-boundary
 * decode itself; decoding twice would fail the second pass on fields the
 * schema transforms (`providerOrigin` parses to a `URL`, not a string).
 */
const commerceExternalIdentityDeploymentInputConfig = Config.option(
  Config.schema(Schema.fromJsonString(Schema.Json), COMMERCE_EXTERNAL_IDENTITY_DEPLOYMENT_ENV_KEY),
);

const parseCommerceExternalIdentityDeploymentInputFromProvider = Effect.fn(
  'CommerceExternalIdentityDeployment.parseCommerceExternalIdentityDeploymentInputFromProvider',
)(function* parseConfiguration(provider: ConfigProvider.ConfigProvider) {
  const input = yield* commerceExternalIdentityDeploymentInputConfig
    .parse(provider)
    .pipe(Effect.catchTag('ConfigError', () => Effect.fail(malformedConfiguration())));
  return Option.getOrUndefined(input);
});

/** Parses the deployment input from an explicit environment record, bypassing the dotenv-file fallback. */
export const parseCommerceExternalIdentityDeploymentInput = (
  environment: CommerceExternalIdentityDeploymentEnvironment,
): Effect.Effect<unknown, CommerceExternalIdentityDeploymentConfigError> =>
  parseCommerceExternalIdentityDeploymentInputFromProvider(ConfigProvider.fromEnvRecord(environment));

interface LoadCommerceExternalIdentityDeploymentInputOptions {
  readonly environment?: CommerceExternalIdentityDeploymentEnvironment;
  readonly envPath?: string;
}

/**
 * Loads the deployment input the same way the rest of the Shell composition
 * root loads configuration: explicit `environment` (or live `process.env`
 * when omitted) with the dotenv file at `envPath`/`APP_ENV_PATH` as fallback.
 * Mirrors `loadAuthConfig`/`loadGatewayIssuerConfig` in the sibling modules.
 */
const loadCommerceExternalIdentityDeploymentInput = (
  options: LoadCommerceExternalIdentityDeploymentInputOptions = {},
): Effect.Effect<unknown, CommerceExternalIdentityDeploymentConfigError> =>
  loadConfigurationProvider(options, unableToLoadEnvironment).pipe(
    Effect.flatMap(parseCommerceExternalIdentityDeploymentInputFromProvider),
  );

/**
 * Production Shell composition root wiring: the merged staff/Commerce
 * namespace registry Actions and Reads observe.  Pass this instead of
 * `defaultContextAccessLive`/`ContextAccessLive` so a configured Commerce
 * deployment is actually reachable.
 */
export const CommerceExternalIdentityContextAccessLive: CommerceContextAccessLayer = Layer.unwrap(
  loadCommerceExternalIdentityDeploymentInput().pipe(
    Effect.orDie,
    Effect.map((input) => makeCommerceExternalIdentityDeployment(input).contextAccessLayer),
  ),
);

/**
 * Production Shell composition root wiring: the provider client, workload
 * assertion issuance, and admission services for the `externalIdentity`
 * endpoints.  Pass this instead of `ExternalIdentityNotInstalledLive` so a
 * configured Commerce deployment is actually reachable.
 */
export const CommerceExternalIdentityDeploymentLive: ExternalIdentityDeploymentLayer = Layer.unwrap(
  loadCommerceExternalIdentityDeploymentInput().pipe(
    Effect.orDie,
    Effect.map((input) => makeCommerceExternalIdentityDeployment(input).externalIdentityDeploymentLayer),
  ),
);
