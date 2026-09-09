import { Config, ConfigProvider, Context, Effect, Layer, Option, Redacted, Schema } from 'effect';
import { loadConfigurationProvider } from './configuration-provider.ts';

const nonEmptyString = Schema.String.check(Schema.isMinLength(1));
const legalEntityIdSchema = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand('LegalEntityId'),
);
const principalIdSchema = Schema.String.check(Schema.isUUID()).pipe(Schema.brand('PrincipalId'));
const providerKeyIdSchema = nonEmptyString.pipe(Schema.brand('ProviderKeyId'));
const tenantIdSchema = Schema.String.check(Schema.isUUID()).pipe(Schema.brand('TenantId'));
const trustedStorefrontIdSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(300),
).pipe(Schema.brand('TrustedStorefrontId'));

/**
 * A capability binding is deployment-owned configuration.  In particular, it is keyed by the
 * provider key id returned after Shell has verified the presented secret; no request payload or
 * caller-supplied Storefront value participates in this lookup.
 */
const GatewayApiKeyBindingSchema = Schema.Struct({
  audience: nonEmptyString,
  legalEntityId: legalEntityIdSchema,
  principalId: principalIdSchema,
  providerKeyId: providerKeyIdSchema,
  tenantId: tenantIdSchema,
  trustedStorefrontId: trustedStorefrontIdSchema,
});

const GatewayApiKeyBindingsSchema = Schema.Array(GatewayApiKeyBindingSchema).check(
  Schema.makeFilter((bindings) => {
    const keys = bindings.map(({ audience, providerKeyId }) => `${audience}\u0000${providerKeyId}`);
    return new Set(keys).size === keys.length
      ? undefined
      : 'Each gateway API-key binding must have a unique audience and provider key id';
  }),
);

export type GatewayApiKeyBinding = Schema.Schema.Type<typeof GatewayApiKeyBindingSchema>;

export interface GatewayApiKeyBindingLookup {
  readonly audience: string;
  readonly legalEntityId: string;
  readonly principalId: string;
  readonly providerKeyId: string;
  readonly tenantId: string;
}

export interface GatewayApiKeyBindingResolverService {
  readonly resolve: (
    input: GatewayApiKeyBindingLookup,
  ) => Effect.Effect<Option.Option<GatewayApiKeyBinding>>;
}

export class GatewayApiKeyBindingResolver extends Context.Service<
  GatewayApiKeyBindingResolver,
  GatewayApiKeyBindingResolverService
>()('@app/shell-super-app/api/auth/gateway-api-key-binding/GatewayApiKeyBindingResolver') {}

export const makeGatewayApiKeyBindingResolver = (
  bindings: readonly GatewayApiKeyBinding[],
): GatewayApiKeyBindingResolverService =>
  Object.freeze({
    resolve: (input: GatewayApiKeyBindingLookup) =>
      Effect.succeed(
        Option.fromUndefinedOr(
          bindings.find(
            (binding) =>
              binding.audience === input.audience &&
              binding.legalEntityId === input.legalEntityId &&
              binding.principalId === input.principalId &&
              binding.providerKeyId === input.providerKeyId &&
              binding.tenantId === input.tenantId,
          ),
        ),
      ),
  });

const bindingConfigurationSource = Config.redacted('ONTOS_GATEWAY_API_KEY_CONTEXT_BINDINGS').pipe(
  Config.withDefault(Redacted.make('')),
);

const GatewayApiKeyBindingConfigurationErrorValue = Schema.TaggedError<unknown>()(
  'GatewayApiKeyBindingConfigurationError',
  { message: Schema.String },
);
type GatewayApiKeyBindingConfigurationError = InstanceType<
  typeof GatewayApiKeyBindingConfigurationErrorValue
>;

const malformedConfiguration = (cause: unknown) => {
  const failure = new GatewayApiKeyBindingConfigurationErrorValue({
    message: 'Gateway API-key context binding configuration is malformed',
  });
  Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  return failure;
};

const parseGatewayApiKeyBindingsFromProvider = (
  provider: ConfigProvider.ConfigProvider,
): Effect.Effect<readonly GatewayApiKeyBinding[], GatewayApiKeyBindingConfigurationError> =>
  bindingConfigurationSource.parse(provider).pipe(
    Effect.map(Redacted.value),
    Effect.catchTag('ConfigError', () => Effect.succeed('')),
    Effect.flatMap((encoded) =>
      encoded.trim().length === 0
        ? Effect.succeed<readonly GatewayApiKeyBinding[]>([])
        : Schema.decodeUnknownEffect(Schema.fromJsonString(GatewayApiKeyBindingsSchema))(
            encoded,
          ).pipe(
            Effect.catchTag('SchemaError', (cause) => Effect.fail(malformedConfiguration(cause))),
          ),
    ),
  );

export const parseGatewayApiKeyBindings = (
  environment: Readonly<Partial<Record<'ONTOS_GATEWAY_API_KEY_CONTEXT_BINDINGS', string>>>,
): Effect.Effect<readonly GatewayApiKeyBinding[], GatewayApiKeyBindingConfigurationError> =>
  parseGatewayApiKeyBindingsFromProvider(ConfigProvider.fromEnvRecord(environment));

const loadGatewayApiKeyBindings = () =>
  loadConfigurationProvider({}, () => malformedConfiguration('environment')).pipe(
    Effect.mapError(malformedConfiguration),
    Effect.flatMap(parseGatewayApiKeyBindingsFromProvider),
  );

/**
 * Missing or malformed deployment configuration intentionally becomes an empty resolver.  The
 * API-key endpoint can still issue ordinary audience assertions, but the Commerce FX audience
 * cannot receive a trusted Storefront claim until its binding is explicitly configured.
 */
export const gatewayApiKeyBindingResolverLive = Layer.effect(
  GatewayApiKeyBindingResolver,
  loadGatewayApiKeyBindings().pipe(
    Effect.map(makeGatewayApiKeyBindingResolver),
    Effect.orElseSucceed(() => makeGatewayApiKeyBindingResolver([])),
  ),
);
