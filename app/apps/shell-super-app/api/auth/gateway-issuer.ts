import {
  GATEWAY_ASSERTION_TTL_SECONDS,
  GATEWAY_ASSERTION_VERSION,
  GatewayTrustedPrincipalContextSchema,
} from '@app/shared-contracts';
import type { GatewayContextResponse, GatewayTrustedPrincipalContext } from '@app/shared-contracts';
import { createHash } from 'node:crypto';
import {
  Cache,
  Clock,
  Context,
  Crypto,
  Duration,
  Effect,
  Exit,
  Layer,
  PlatformError,
  Predicate,
  Ref,
  Schema,
  Semaphore,
} from 'effect';
import { SignJWT, importJWK } from 'jose';
import { installedVerticalIds } from '../verticals/installed-verticals.ts';
import type { InstalledVerticalTopologyError } from '../verticals/installed-verticals.ts';
import { loadGatewayIssuerConfig } from './gateway-issuer-config.ts';
import type {
  GatewayIssuerConfigError,
  GatewayIssuerConfigValue,
} from './gateway-issuer-config.ts';

const SIGNING_CONFIGURATION_REFRESH = Duration.seconds(30);

const GatewayIssuerFailureCauseSchema = Schema.Defect();
type GatewayIssuerFailureCause = Schema.Schema.Type<typeof GatewayIssuerFailureCauseSchema>;

const gatewayIssuerErrorFields = {
  code: Schema.Literals(['gateway_audience_invalid', 'gateway_issuer_unavailable']),
  failureCause: Schema.optionalKey(GatewayIssuerFailureCauseSchema),
  reason: Schema.String,
  stage: Schema.Literals(['audience', 'clock', 'configuration', 'principal', 'signing']),
};
const GatewayIssuerErrorSchema = Schema.TaggedStruct(
  'GatewayIssuerError',
  gatewayIssuerErrorFields,
);
const GatewayIssuerErrorConstructor = Schema.TaggedError<
  Schema.Schema.Type<typeof GatewayIssuerErrorSchema>
>()('GatewayIssuerError', gatewayIssuerErrorFields);
export { GatewayIssuerErrorConstructor as GatewayIssuerError };
export type GatewayIssuerError = Schema.Schema.Type<typeof GatewayIssuerErrorSchema>;

export interface IssueGatewayAssertionInput<Principal = GatewayTrustedPrincipalContext> {
  readonly audience: string;
  readonly principal: Principal;
}

export interface GatewayIssuerLayerOptions {
  readonly currentTimeSeconds: Effect.Effect<number>;
  readonly generateJti: Effect.Effect<string, GatewayIssuerError>;
  readonly loadAudiences: Effect.Effect<
    ReadonlySet<string>,
    InstalledVerticalTopologyError | GatewayIssuerError
  >;
  readonly loadConfig: Effect.Effect<GatewayIssuerConfigValue, GatewayIssuerConfigError>;
}

interface GatewaySigningMaterial {
  readonly issuer: string;
  readonly key: CryptoKey;
  readonly kid: string;
}

interface GatewayIssuerService {
  readonly issue: <Principal>(
    input: IssueGatewayAssertionInput<Principal>,
  ) => Effect.Effect<GatewayContextResponse, GatewayIssuerError>;
}

export class GatewayIssuer extends Context.Service<GatewayIssuer, GatewayIssuerService>()(
  '@app/shell-super-app/api/auth/gateway-issuer/GatewayIssuer',
) {}

const unavailable = (
  stage: 'audience' | 'clock' | 'configuration' | 'principal' | 'signing',
  failureCause?: GatewayIssuerFailureCause,
) =>
  new GatewayIssuerErrorConstructor(
    failureCause === undefined
      ? {
          code: 'gateway_issuer_unavailable',
          reason: 'The gateway assertion issuer is unavailable',
          stage,
        }
      : {
          code: 'gateway_issuer_unavailable',
          failureCause,
          reason: 'The gateway assertion issuer is unavailable',
          stage,
        },
  );

const fromPromise = <Success, Failure>(
  operation: () => PromiseLike<Success>,
  onFailure: (failureCause: GatewayIssuerFailureCause) => Failure,
  onTimeout: () => Failure,
): Effect.Effect<Success, Failure> =>
  Effect.tryPromise({ catch: onFailure, try: operation }).pipe(
    Effect.timeoutOrElse({
      duration: '5 seconds',
      orElse: () => Effect.fail(onTimeout()),
    }),
  );

const gatewayCrypto = Crypto.make({
  digest: (algorithm, data) => {
    const digestInput = new Uint8Array(data.byteLength);
    digestInput.set(data);
    const webCrypto = globalThis.crypto.subtle;
    return fromPromise(
      webCrypto.digest.bind(webCrypto, algorithm, digestInput),
      (failureCause) =>
        PlatformError.systemError({
          _tag: 'Unknown',
          cause: failureCause,
          method: 'digest',
          module: 'WebCrypto',
        }),
      () =>
        PlatformError.systemError({
          _tag: 'TimedOut',
          method: 'digest',
          module: 'WebCrypto',
        }),
    ).pipe(Effect.map((digest) => new Uint8Array(digest)));
  },
  randomBytes: (size) => globalThis.crypto.getRandomValues(new Uint8Array(size)),
});

const gatewayIssuerLiveOptions: GatewayIssuerLayerOptions = {
  currentTimeSeconds: Clock.currentTimeMillis.pipe(
    Effect.map((milliseconds) => Math.floor(milliseconds / 1000)),
  ),
  generateJti: gatewayCrypto.randomUUIDv4.pipe(
    Effect.mapError((failureCause) => unavailable('signing', failureCause)),
  ),
  loadAudiences: installedVerticalIds,
  loadConfig: loadGatewayIssuerConfig(),
};

const makeGatewayIssuer = Effect.fn('GatewayIssuer.make')(function* gatewayIssuerService(
  options: GatewayIssuerLayerOptions,
) {
  const configurationCache = yield* Cache.makeWith(
    (_key: 'configuration') =>
      options.loadConfig.pipe(
        Effect.mapError((failureCause) => unavailable('configuration', failureCause)),
      ),
    {
      capacity: 1,
      timeToLive: (exit, _key) =>
        Exit.isSuccess(exit) ? SIGNING_CONFIGURATION_REFRESH : '0 seconds',
    },
  );
  const slot = yield* Ref.make<{ readonly fingerprint: string; readonly key: CryptoKey } | null>(
    null,
  );
  const gate = yield* Semaphore.make(1);

  const loadSigningKey = (
    privateJwk: GatewayIssuerConfigValue['privateJwk'],
  ): Effect.Effect<CryptoKey, GatewayIssuerError> => {
    // Fingerprint all key material without retaining the private scalar separately.
    const fingerprint = createHash('sha256')
      .update(`${privateJwk.kid}\n${privateJwk.x}\n${privateJwk.d}`)
      .digest('base64url');
    return Semaphore.withPermits(
      gate,
      1,
    )(
      Effect.gen(function* loadSigningKeySlot() {
        const cached = yield* Ref.get(slot);
        if (cached?.fingerprint === fingerprint) {
          return cached.key;
        }
        const key = yield* fromPromise(
          importJWK.bind(undefined, privateJwk, 'EdDSA'),
          (failureCause) => unavailable('signing', failureCause),
          () => unavailable('signing', 'Private key import timed out'),
        );
        if (Predicate.isUint8Array(key)) {
          return yield* unavailable('signing', 'Private key import returned a symmetric key');
        }
        yield* Ref.set(slot, { fingerprint, key });
        return key;
      }),
    );
  };

  const issue = Effect.fn('GatewayIssuer.issue')(function* issueGatewayAssertion<Principal>(
    input: IssueGatewayAssertionInput<Principal>,
  ) {
    const principal = yield* Schema.decodeUnknownEffect(GatewayTrustedPrincipalContextSchema, {
      onExcessProperty: 'error',
    })(input.principal).pipe(
      Effect.mapError((failureCause) => unavailable('principal', failureCause)),
    );
    const audiences = yield* options.loadAudiences.pipe(
      Effect.mapError((failureCause) => unavailable('audience', failureCause)),
    );
    if (!audiences.has(input.audience)) {
      return yield* new GatewayIssuerErrorConstructor({
        code: 'gateway_audience_invalid',
        reason: 'The requested gateway audience is not a generated MicroVertical',
        stage: 'audience',
      });
    }

    const configuration = yield* Cache.get(configurationCache, 'configuration');
    const issuedAt = yield* options.currentTimeSeconds;
    if (!Number.isSafeInteger(issuedAt) || issuedAt < 0) {
      return yield* unavailable('clock');
    }
    const expiresAt = issuedAt + GATEWAY_ASSERTION_TTL_SECONDS;
    const jti = yield* options.generateJti;
    const preparedSigningMaterial: GatewaySigningMaterial = {
      issuer: configuration.issuer,
      key: yield* loadSigningKey(configuration.privateJwk),
      kid: configuration.privateJwk.kid,
    };
    const signer = new SignJWT({
      principal,
      ver: GATEWAY_ASSERTION_VERSION,
    })
      .setProtectedHeader({
        alg: 'EdDSA',
        kid: preparedSigningMaterial.kid,
        typ: 'JWT',
      })
      .setIssuer(preparedSigningMaterial.issuer)
      .setAudience(input.audience)
      .setSubject(principal.principalId)
      .setIssuedAt(issuedAt)
      .setExpirationTime(expiresAt)
      .setJti(jti);

    const token = yield* fromPromise(
      signer.sign.bind(signer, preparedSigningMaterial.key, undefined),
      (failureCause) => unavailable('signing', failureCause),
      () => unavailable('signing', 'Assertion signing timed out'),
    );

    return { expiresAt, token };
  });

  return {
    issue,
  } satisfies GatewayIssuerService;
});

export const makeGatewayIssuerLayer = (options: GatewayIssuerLayerOptions) =>
  Layer.effect(GatewayIssuer, makeGatewayIssuer(options));

export const GatewayIssuerLive = makeGatewayIssuerLayer(gatewayIssuerLiveOptions);

export const issueGatewayContextAssertion = Effect.fn('GatewayIssuer.issueGatewayContextAssertion')(
  function* issueGatewayContextAssertionEffect<Principal>(
    input: IssueGatewayAssertionInput<Principal>,
  ) {
    const gatewayIssuer = yield* GatewayIssuer;
    return yield* gatewayIssuer.issue(input);
  },
);
