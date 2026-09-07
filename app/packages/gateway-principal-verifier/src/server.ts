import type { GatewayAssertionRedemption } from '@app/core-runtime';
import { TrustedPrincipalContextSchema } from '@app/core-runtime/actions/principal-context';
import type { TrustedPrincipalContext } from '@app/core-runtime/actions/principal-context';
import {
  GATEWAY_ASSERTION_CLOCK_SKEW_SECONDS,
  GATEWAY_ASSERTION_VERSION,
  GatewayAudienceSchema,
  decodeGatewayContextClaims,
  decodeGatewayContextProtectedHeader,
} from '@app/shared-contracts';
import {
  Clock,
  Config,
  ConfigProvider,
  Context,
  DateTime,
  Duration,
  Effect,
  Layer,
  Option,
  Redacted,
  Schema,
} from 'effect';
import { createLocalJWKSet, decodeProtectedHeader, importJWK, jwtVerify } from 'jose';
import type { LocalJWKSet } from 'jose';

export const ACTION_PRINCIPAL_BEARER_CHALLENGE = 'Bearer' as const;

const errorFields = { reason: Schema.String };
export const ActionPrincipalMissingErrorSchema = Schema.TaggedStruct(
  'ActionPrincipalMissingError',
  errorFields,
);
export type ActionPrincipalMissingError = typeof ActionPrincipalMissingErrorSchema.Type;
export const ActionPrincipalInvalidErrorSchema = Schema.TaggedStruct(
  'ActionPrincipalInvalidError',
  errorFields,
);
export type ActionPrincipalInvalidError = typeof ActionPrincipalInvalidErrorSchema.Type;
export const ActionPrincipalExpiredErrorSchema = Schema.TaggedStruct(
  'ActionPrincipalExpiredError',
  errorFields,
);
export type ActionPrincipalExpiredError = typeof ActionPrincipalExpiredErrorSchema.Type;
export const ActionPrincipalScopeErrorSchema = Schema.TaggedStruct(
  'ActionPrincipalScopeError',
  errorFields,
);
export type ActionPrincipalScopeError = typeof ActionPrincipalScopeErrorSchema.Type;
export const ActionPrincipalConfigurationErrorSchema = Schema.TaggedStruct(
  'ActionPrincipalConfigurationError',
  errorFields,
);
export type ActionPrincipalConfigurationError = typeof ActionPrincipalConfigurationErrorSchema.Type;
export const ActionPrincipalUnavailableErrorSchema = Schema.TaggedStruct(
  'ActionPrincipalUnavailableError',
  errorFields,
);
export type ActionPrincipalUnavailableError = typeof ActionPrincipalUnavailableErrorSchema.Type;

export type ActionPrincipalError =
  | ActionPrincipalMissingError
  | ActionPrincipalInvalidError
  | ActionPrincipalExpiredError
  | ActionPrincipalScopeError
  | ActionPrincipalConfigurationError
  | ActionPrincipalUnavailableError;

export interface GatewayPrincipalVerificationOptions {
  readonly currentTimeSeconds?: Effect.Effect<number>;
  readonly environment?: GatewayPrincipalVerificationEnvironment;
}

export interface GatewayPrincipalVerificationWithRedemptionOptions extends GatewayPrincipalVerificationOptions {
  readonly redemption: GatewayAssertionRedemption;
}

type GatewayPrincipalVerificationEnvironmentOptions = GatewayPrincipalVerificationOptions & {
  readonly environment: GatewayPrincipalVerificationEnvironment;
};
type GatewayPrincipalVerificationEnvironmentWithRedemptionOptions =
  GatewayPrincipalVerificationWithRedemptionOptions & {
    readonly environment: GatewayPrincipalVerificationEnvironment;
  };

export interface GatewayPrincipalVerificationEnvironment {
  readonly ONTOS_GATEWAY_ISSUER?: string;
  readonly ONTOS_GATEWAY_PUBLIC_JWKS?: string;
}

const configurationError = (): ActionPrincipalConfigurationError =>
  ActionPrincipalConfigurationErrorSchema.make({
    reason: 'Action identity verification is misconfigured',
  });
const invalidError = (): ActionPrincipalInvalidError =>
  ActionPrincipalInvalidErrorSchema.make({ reason: 'The Bearer assertion is invalid' });
const unavailableError = (): ActionPrincipalUnavailableError =>
  ActionPrincipalUnavailableErrorSchema.make({
    reason: 'Action identity verification is unavailable',
  });
const mapRedemptionUnavailable = () => Effect.fail(unavailableError());
const mapRedemptionReplay = () => Effect.fail(invalidError());

const PublicVerificationKeySchema = Schema.Struct({
  alg: Schema.Literal('EdDSA'),
  crv: Schema.Literal('Ed25519'),
  d: Schema.optionalKey(Schema.Never),
  key_ops: Schema.optionalKey(Schema.Array(Schema.Literal('verify')).check(Schema.isMinLength(1))),
  kid: Schema.String.check(Schema.isMinLength(1)),
  kty: Schema.Literal('OKP'),
  use: Schema.Literal('sig'),
  x: Schema.String.check(Schema.isMinLength(1)),
});
const PublicVerificationKeysSchema = Schema.Struct({
  keys: Schema.Array(PublicVerificationKeySchema).check(
    Schema.isMinLength(1),
    Schema.makeFilter((keys) =>
      new Set(keys.map(({ kid }) => kid)).size === keys.length
        ? undefined
        : 'Verification key identifiers must be unique',
    ),
  ),
});
const VerificationEnvironmentSchema = Schema.Struct({
  ONTOS_GATEWAY_ISSUER: Schema.String.check(
    Schema.isPattern(/^https?:\/\//u),
    Schema.makeFilter((value) =>
      URL.canParse(value) ? undefined : 'An absolute HTTP issuer is required',
    ),
  ),
  ONTOS_GATEWAY_PUBLIC_JWKS: Schema.fromJsonString(PublicVerificationKeysSchema),
});

const gatewayVerificationEnvironment = Config.all({
  ONTOS_GATEWAY_ISSUER: Config.string('ONTOS_GATEWAY_ISSUER'),
  ONTOS_GATEWAY_PUBLIC_JWKS: Config.string('ONTOS_GATEWAY_PUBLIC_JWKS'),
});
const VERIFY_ASSERTION_TIMEOUT = Duration.seconds(2);

interface VerificationConfiguration {
  readonly issuer: string;
  readonly keySet: LocalJWKSet;
}

interface GatewayPrincipalVerifierService {
  readonly configuration: Effect.Effect<
    VerificationConfiguration,
    ActionPrincipalConfigurationError
  >;
}

export class GatewayPrincipalVerifierConfiguration extends Context.Service<
  GatewayPrincipalVerifierConfiguration,
  GatewayPrincipalVerifierService
>()('@app/gateway-principal-verifier/server/GatewayPrincipalVerifierConfiguration') {}

const loadGatewayPrincipalVerificationConfiguration = (
  provider?: ConfigProvider.ConfigProvider,
): Effect.Effect<VerificationConfiguration, ActionPrincipalConfigurationError> => {
  const configuration =
    provider === undefined
      ? gatewayVerificationEnvironment
      : gatewayVerificationEnvironment.parse(provider);
  return configuration.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(VerificationEnvironmentSchema)),
    Effect.flatMap(({ ONTOS_GATEWAY_ISSUER: issuer, ONTOS_GATEWAY_PUBLIC_JWKS: jwks }) => {
      const keys = jwks.keys.map(({ alg, crv, kid, kty, use, x }) => ({
        alg,
        crv,
        kid,
        kty,
        use,
        x,
      }));
      return Effect.tryPromise({
        // oxlint-disable-next-line effect-native/no-failure-discarding-error-callback -- Configuration failures are deliberately sanitized at the trust boundary; remove-when: the rule supports security-boundary sanitizers.
        catch: () => configurationError(),
        // oxlint-disable-next-line typescript/promise-function-async -- Effect.tryPromise owns the Promise boundary; remove-when: the lint rule recognizes Effect.tryPromise callbacks.
        try: () => Promise.all(keys.map((key) => importJWK(key, 'EdDSA'))),
      }).pipe(
        Effect.timeoutOrElse({
          duration: VERIFY_ASSERTION_TIMEOUT,
          orElse: () => Effect.fail(configurationError()),
        }),
        Effect.map((): VerificationConfiguration => ({
          issuer,
          keySet: createLocalJWKSet({ keys }),
        })),
      );
    }),
    // oxlint-disable-next-line effect-native/no-failure-discarding-error-callback -- Configuration failures are deliberately sanitized at the trust boundary; remove-when: the rule supports security-boundary sanitizers.
    Effect.mapError(() => configurationError()),
  );
};

export const makeGatewayPrincipalVerifierLayer = (
  provider?: ConfigProvider.ConfigProvider,
): Layer.Layer<GatewayPrincipalVerifierConfiguration> =>
  Layer.effect(
    GatewayPrincipalVerifierConfiguration,
    Effect.cached(loadGatewayPrincipalVerificationConfiguration(provider)).pipe(
      Effect.map((configuration): GatewayPrincipalVerifierService => ({ configuration })),
    ),
  );

export const GatewayPrincipalVerifierLive = makeGatewayPrincipalVerifierLayer();

const VerificationFailureSchema = Schema.Struct({
  claim: Schema.optionalKey(Schema.String),
  code: Schema.optionalKey(Schema.String),
  name: Schema.optionalKey(Schema.String),
});
type VerificationFailure = typeof VerificationFailureSchema.Type;
const decodeVerificationFailure = Schema.decodeUnknownOption(VerificationFailureSchema);

const classifyVerificationFailure = (error: VerificationFailure): ActionPrincipalError => {
  if (error.name === 'JWTExpired') {
    return ActionPrincipalExpiredErrorSchema.make({
      reason: 'The Bearer assertion has expired',
    });
  }
  if (error.name === 'JWTClaimValidationFailed') {
    return error.claim === 'iss' || error.claim === 'aud'
      ? ActionPrincipalScopeErrorSchema.make({
          reason: 'The Bearer assertion has invalid scope',
        })
      : invalidError();
  }
  if (
    error.name === 'SchemaError' ||
    /^(?:JWS|JWT|JOSE)/u.test(error.name ?? '') ||
    /^ERR_(?:JOSE|JWK|JWKS|JWS|JWT)_/u.test(error.code ?? '')
  ) {
    return invalidError();
  }
  return unavailableError();
};

const readBearer = (
  authorization: Redacted.Redacted<string | undefined>,
): Effect.Effect<string, ActionPrincipalError> => {
  const authorizationValue = Redacted.value(authorization);
  if (authorizationValue === undefined) {
    return Effect.fail(
      ActionPrincipalMissingErrorSchema.make({ reason: 'A Bearer assertion is required' }),
    );
  }
  const token = /^Bearer (?<token>[^\s]+)$/iu.exec(authorizationValue)?.groups?.['token'];
  return token === undefined ? Effect.fail(invalidError()) : Effect.succeed(token);
};

interface VerifiedGatewayPrincipal {
  readonly expiresAtEpochSeconds: number;
  readonly issuer: string;
  readonly jti: string;
  readonly principal: TrustedPrincipalContext;
}

const verifyAuthenticatedToken = Effect.fn('GatewayPrincipalVerifier.verifyAuthenticatedToken')(
  function* verifyAuthenticatedTokenEffect(
    expectedAudience: string,
    token: string,
    options: GatewayPrincipalVerificationOptions,
  ): Effect.fn.Return<
    VerifiedGatewayPrincipal,
    ActionPrincipalError,
    GatewayPrincipalVerifierConfiguration
  > {
    const audience = yield* Schema.decodeUnknownEffect(GatewayAudienceSchema)(
      expectedAudience,
    ).pipe(
      // oxlint-disable-next-line effect-native/no-failure-discarding-error-callback -- Schema diagnostics are deliberately sanitized at the trust boundary; remove-when: the rule supports security-boundary sanitizers.
      Effect.mapError(() => configurationError()),
    );
    const verifier = yield* GatewayPrincipalVerifierConfiguration;
    const configuration = yield* verifier.configuration;
    const now = yield* (
      options.currentTimeSeconds ??
        Clock.currentTimeMillis.pipe(Effect.map((milliseconds) => Math.floor(milliseconds / 1000)))
    );
    if (!Number.isSafeInteger(now) || now < 0) {
      return yield* Effect.fail(configurationError());
    }
    const unverifiedHeader = yield* Effect.try({
      // oxlint-disable-next-line effect-native/no-failure-discarding-error-callback -- Token parser diagnostics are deliberately sanitized at the trust boundary; remove-when: the rule supports security-boundary sanitizers.
      catch: () => invalidError(),
      try: () => decodeProtectedHeader(token),
    });
    yield* decodeGatewayContextProtectedHeader(unverifiedHeader).pipe(
      // oxlint-disable-next-line effect-native/no-failure-discarding-error-callback -- Header diagnostics are deliberately sanitized at the trust boundary; remove-when: the rule supports security-boundary sanitizers.
      Effect.mapError(() => invalidError()),
    );
    const verified = yield* Effect.tryPromise({
      catch: (cause) =>
        Option.match(decodeVerificationFailure(cause), {
          onNone: unavailableError,
          onSome: classifyVerificationFailure,
        }),
      // oxlint-disable-next-line typescript/promise-function-async -- Effect.tryPromise owns the Promise boundary; remove-when: the lint rule recognizes Effect.tryPromise callbacks.
      try: () =>
        jwtVerify(token, configuration.keySet, {
          algorithms: ['EdDSA'],
          audience,
          clockTolerance: GATEWAY_ASSERTION_CLOCK_SKEW_SECONDS,
          currentDate: DateTime.toDateUtc(DateTime.makeUnsafe(now * 1000)),
          issuer: configuration.issuer,
        }),
    }).pipe(
      Effect.timeoutOrElse({
        duration: VERIFY_ASSERTION_TIMEOUT,
        orElse: () => Effect.fail(unavailableError()),
      }),
    );
    const claims = yield* decodeGatewayContextClaims(verified.payload).pipe(
      // oxlint-disable-next-line effect-native/no-failure-discarding-error-callback -- Claim diagnostics are deliberately sanitized at the trust boundary; remove-when: the rule supports security-boundary sanitizers.
      Effect.mapError(() => invalidError()),
    );
    if (
      claims.ver !== GATEWAY_ASSERTION_VERSION ||
      claims.iat > now + GATEWAY_ASSERTION_CLOCK_SKEW_SECONDS
    ) {
      return yield* Effect.fail(invalidError());
    }
    const principal = yield* Schema.decodeUnknownEffect(TrustedPrincipalContextSchema, {
      onExcessProperty: 'error',
    })(claims.principal).pipe(
      // oxlint-disable-next-line effect-native/no-failure-discarding-error-callback -- Principal decode diagnostics are deliberately sanitized at the trust boundary; remove-when: the rule supports security-boundary sanitizers.
      Effect.mapError(() => invalidError()),
    );
    return {
      expiresAtEpochSeconds: claims.exp,
      issuer: claims.iss,
      jti: claims.jti,
      principal,
    };
  },
);

export const bindGatewayPrincipalVerifier = <const Audience extends string>(
  expectedAudience: Audience,
) => {
  function verifyPrincipal(
    authorization: Redacted.Redacted<string | undefined>,
    options: GatewayPrincipalVerificationEnvironmentOptions,
  ): Effect.Effect<VerifiedGatewayPrincipal, ActionPrincipalError>;
  function verifyPrincipal(
    authorization: Redacted.Redacted<string | undefined>,
    options?: GatewayPrincipalVerificationOptions,
  ): Effect.Effect<
    VerifiedGatewayPrincipal,
    ActionPrincipalError,
    GatewayPrincipalVerifierConfiguration
  >;
  function verifyPrincipal(
    authorization: Redacted.Redacted<string | undefined>,
    options: GatewayPrincipalVerificationOptions = {},
  ): Effect.Effect<
    VerifiedGatewayPrincipal,
    ActionPrincipalError,
    GatewayPrincipalVerifierConfiguration
  > {
    const verification = readBearer(authorization).pipe(
      Effect.flatMap((token) => verifyAuthenticatedToken(expectedAudience, token, options)),
    );
    return options.environment === undefined
      ? verification
      : verification.pipe(
          // oxlint-disable-next-line effect-native/no-effect-provide-in-library -- Compatibility input for generated owner bindings; remove-when: callers inject ConfigProvider at runtime roots.
          Effect.provideService(GatewayPrincipalVerifierConfiguration, {
            configuration: loadGatewayPrincipalVerificationConfiguration(
              ConfigProvider.fromUnknown(options.environment),
            ),
          }),
        );
  }

  function verify(
    authorization: Redacted.Redacted<string | undefined>,
    options: GatewayPrincipalVerificationEnvironmentOptions,
  ): Effect.Effect<TrustedPrincipalContext, ActionPrincipalError>;
  function verify(
    authorization: Redacted.Redacted<string | undefined>,
    options?: GatewayPrincipalVerificationOptions,
  ): Effect.Effect<
    TrustedPrincipalContext,
    ActionPrincipalError,
    GatewayPrincipalVerifierConfiguration
  >;
  function verify(
    authorization: Redacted.Redacted<string | undefined>,
    options: GatewayPrincipalVerificationOptions = {},
  ): Effect.Effect<
    TrustedPrincipalContext,
    ActionPrincipalError,
    GatewayPrincipalVerifierConfiguration
  > {
    return verifyPrincipal(authorization, options).pipe(Effect.map(({ principal }) => principal));
  }

  function verifyAndRedeem(
    authorization: Redacted.Redacted<string | undefined>,
    options: GatewayPrincipalVerificationEnvironmentWithRedemptionOptions,
  ): Effect.Effect<TrustedPrincipalContext, ActionPrincipalError>;
  function verifyAndRedeem(
    authorization: Redacted.Redacted<string | undefined>,
    options: GatewayPrincipalVerificationWithRedemptionOptions,
  ): Effect.Effect<
    TrustedPrincipalContext,
    ActionPrincipalError,
    GatewayPrincipalVerifierConfiguration
  >;
  function verifyAndRedeem(
    authorization: Redacted.Redacted<string | undefined>,
    options: GatewayPrincipalVerificationWithRedemptionOptions,
  ): Effect.Effect<
    TrustedPrincipalContext,
    ActionPrincipalError,
    GatewayPrincipalVerifierConfiguration
  > {
    return verifyPrincipal(authorization, options).pipe(
      Effect.tap(({ expiresAtEpochSeconds, issuer, jti }) =>
        options.redemption
          .consume({ audience: expectedAudience, expiresAtEpochSeconds, issuer, jti })
          .pipe(
            Effect.catchTags({
              GatewayAssertionRedemptionUnavailableError: mapRedemptionUnavailable,
              GatewayAssertionReplayError: mapRedemptionReplay,
            }),
          ),
      ),
      Effect.map(({ principal }) => principal),
    );
  }

  return {
    expectedAudience,
    verify,
    verifyAndRedeem,
  } as const;
};
