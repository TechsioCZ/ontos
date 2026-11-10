import {
  RegisteredGatewayRouteScopeSchema,
  RegisteredGatewayWorkloadSchema,
  RegisteredGatewayPrivacyDispatchSchema,
  RegisteredGatewayOrganizationGovernanceReadSchema,
} from '@app/core-runtime/auth/system-principal-context-provenance';
import type {
  RegisteredGatewayRouteScope,
  RegisteredGatewayWorkload,
  RegisteredGatewayPrivacyDispatch,
  RegisteredGatewayOrganizationGovernanceRead,
} from '@app/core-runtime/auth/system-principal-context-provenance';
import { GatewayScopeGrantRegistrar } from '@app/core-runtime';
import { moduleReleaseApiBaseUrl } from '@app/core-runtime/unit-service-fetch';

import {
  DELEGATED_GATEWAY_ASSERTION_VERSION,
  WORKLOAD_GATEWAY_ASSERTION_VERSION,
  PRIVACY_DISPATCH_GATEWAY_ASSERTION_VERSION,
  ORGANIZATION_GOVERNANCE_GATEWAY_ASSERTION_VERSION,
  VERSIONED_PRIVACY_DISPATCH_GATEWAY_ASSERTION_VERSION,
  VERSIONED_ORGANIZATION_GOVERNANCE_GATEWAY_ASSERTION_VERSION,
  EXTERNAL_GATEWAY_ASSERTION_VERSION,
  GATEWAY_ASSERTION_TTL_SECONDS,
  GATEWAY_ASSERTION_VERSION,
  GatewayActorClaimSchema,
  GatewayContextResponseSchema,
  GatewayTrustedPrincipalContextSchema,
  organizationGovernanceReadOperationContract,
  privacyDispatchOperationContract,
} from '@app/shared-contracts';
import type { GatewayActorClaim, GatewayContextResponse, GatewayTrustedPrincipalContext } from '@app/shared-contracts';
import {
  Cache,
  Clock,
  Context,
  Crypto,
  Duration,
  Effect,
  Exit,
  Layer,
  Option,
  PlatformError,
  Predicate,
  Redacted,
  Ref,
  Schema,
  Semaphore,
} from 'effect';
import { Base64Url } from 'effect/encoding';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { SignJWT, importJWK } from 'jose';

import { ShellInstalledModuleCatalog } from '../modules/installed-module-catalog.ts';
import type { InstalledModuleCatalogError } from '../modules/installed-module-catalog.ts';
import { loadGatewayIssuerConfig } from './gateway-issuer-config.ts';
import type { GatewayIssuerConfigError, GatewayIssuerConfigValue } from './gateway-issuer-config.ts';
import { readAdmittedPrivacyDispatch } from './gateway-privacy-dispatch-evidence.ts';
import type { AdmittedPrivacyDispatch } from './gateway-privacy-dispatch-evidence.ts';
import { readAdmittedOrganizationGovernanceRead } from './gateway-organization-governance-evidence.ts';
import type { AdmittedOrganizationGovernanceRead } from './gateway-organization-governance-evidence.ts';
import { takeAdmittedOrganizationProcessingRead } from './gateway-registered-assertion.ts';
import type { AdmittedOrganizationProcessingRead } from './gateway-registered-assertion.ts';

const withOptionalProperty = <Base extends object, Key extends PropertyKey, Value, Trailing extends object>(
  base: Base,
  condition: boolean,
  key: Key,
  value: Value,
  trailing: Trailing,
) => (condition ? { ...base, [key]: value, ...trailing } : { ...base, ...trailing });

const SIGNING_CONFIGURATION_REFRESH = Duration.seconds(30);
export const SYMMY_INGRESS_AUDIENCE = 'symmy-integration';
const symmyIngressIssuance = Symbol('Symmy ingress issuance');
const routeScopedIssuance = Symbol('Verified route scoped issuance');
const privacyDispatchIssuance = Symbol('Verified finite Privacy dispatch issuance');
const organizationGovernanceReadIssuance = Symbol('Verified organization governance Read issuance');
const organizationProcessingReadIssuance = Symbol('Verified organization processing Read issuance');

const GatewayIssuerFailureCauseSchema = Schema.Defect();
type GatewayIssuerFailureCause = Schema.Schema.Type<typeof GatewayIssuerFailureCauseSchema>;

const gatewayIssuerErrorFields = {
  code: Schema.Literals(['gateway_audience_invalid', 'gateway_issuer_unavailable', 'gateway_revision_unsupported']),
  failureCause: Schema.optionalKey(GatewayIssuerFailureCauseSchema),
  reason: Schema.String,
  stage: Schema.Literals(['audience', 'clock', 'configuration', 'principal', 'scope_grant', 'signing']),
};
const GatewayIssuerErrorSchema = Schema.TaggedStruct('GatewayIssuerError', gatewayIssuerErrorFields);
const GatewayIssuerErrorConstructor = Schema.TaggedError<Schema.Schema.Type<typeof GatewayIssuerErrorSchema>>()(
  'GatewayIssuerError',
  gatewayIssuerErrorFields,
);
export { GatewayIssuerErrorConstructor as GatewayIssuerError };
export type GatewayIssuerError = Schema.Schema.Type<typeof GatewayIssuerErrorSchema>;

export interface IssueGatewayAssertionInput<Principal = GatewayTrustedPrincipalContext> {
  /** The calling module of a delegated or privately attested human call. */
  readonly actor?: GatewayActorClaim;
  readonly audience: string;
  readonly compositionRevision: string;
  readonly organizationGovernanceRead?: RegisteredGatewayOrganizationGovernanceRead;
  readonly [organizationGovernanceReadIssuance]?: true;
  readonly [organizationProcessingReadIssuance]?: true;
  readonly principal: Principal;
  readonly privacyDispatch?: RegisteredGatewayPrivacyDispatch;
  readonly [privacyDispatchIssuance]?: true;
  readonly routeScope?: RegisteredGatewayRouteScope;
  readonly [routeScopedIssuance]?: true;
  /** Delegated paths keep the requester's exact signing interval; fresh issuance uses the default window. */
  readonly sourceValidity?: { readonly expiresAt: number; readonly issuedAt: number } | undefined;
  readonly [symmyIngressIssuance]?: true;
  readonly workload?: RegisteredGatewayWorkload;
}

export interface GatewayIssuerLayerOptions {
  readonly currentTimeSeconds: Effect.Effect<number>;
  readonly generateJti: Effect.Effect<string, GatewayIssuerError>;
  readonly loadAdmission: Effect.Effect<
    { readonly audiences: ReadonlyMap<string, string>; readonly revision: string },
    InstalledModuleCatalogError | GatewayIssuerError
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
  stage: 'audience' | 'clock' | 'configuration' | 'principal' | 'scope_grant' | 'signing',
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

const symmyAudienceForbidden = () =>
  new GatewayIssuerErrorConstructor({
    code: 'gateway_audience_invalid',
    reason: 'The Symmy audience requires the dedicated Integration Principal admission',
    stage: 'audience',
  });

const deniesSymmyAudience = <Principal>(
  input: IssueGatewayAssertionInput<Principal>,
  principal: GatewayTrustedPrincipalContext,
): boolean =>
  input.audience === SYMMY_INGRESS_AUDIENCE &&
  input[privacyDispatchIssuance] !== true &&
  input[organizationGovernanceReadIssuance] !== true &&
  input[organizationProcessingReadIssuance] !== true &&
  (input[symmyIngressIssuance] !== true ||
    input.actor !== undefined ||
    input.sourceValidity !== undefined ||
    principal.authMethod !== 'api_key');

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

export const ShellCryptoLive = Layer.succeed(Crypto.Crypto, gatewayCrypto);

/** The calling module of a delegated call, decoded at the signing boundary. */
const decodeDelegatedActor = (actor: GatewayActorClaim) =>
  Schema.decodeUnknownEffect(GatewayActorClaimSchema, { onExcessProperty: 'error' })(actor).pipe(
    Effect.mapError((failureCause) => unavailable('principal', failureCause)),
  );

/** Version 3 is the only version that names a calling module; without one the subject's namespace decides. */
const assertionVersionOf = (
  principal: GatewayTrustedPrincipalContext,
  actor: GatewayActorClaim | undefined,
): number => {
  if (actor !== undefined) {
    return DELEGATED_GATEWAY_ASSERTION_VERSION;
  }
  return principal.authenticationNamespaceId === undefined
    ? GATEWAY_ASSERTION_VERSION
    : EXTERNAL_GATEWAY_ASSERTION_VERSION;
};

/** The route marker can enter signing only through the private route issuance wrapper. */
const decodeRouteScopedIssuance = Effect.fn('GatewayIssuer.decodeRouteScope')(function* decodeRouteScope<Principal>(
  input: IssueGatewayAssertionInput<Principal>,
  principal: GatewayTrustedPrincipalContext,
) {
  if (input.routeScope === undefined) {
    return Option.none<RegisteredGatewayRouteScope>();
  }
  if (
    input[routeScopedIssuance] !== true ||
    input.actor !== undefined ||
    input.workload !== undefined ||
    input.sourceValidity !== undefined
  ) {
    return yield* unavailable('principal');
  }
  const routeScope = yield* Schema.decodeUnknownEffect(RegisteredGatewayRouteScopeSchema, {
    onExcessProperty: 'error',
  })(input.routeScope).pipe(Effect.mapError((cause) => unavailable('principal', cause)));
  if (
    principal.authMethod !== 'api_key' ||
    principal.authenticationNamespaceId === undefined ||
    principal.tenantId !== routeScope.tenantId ||
    principal.principalId !== routeScope.principalId ||
    principal.legalEntityId !== routeScope.legalEntityId
  ) {
    return yield* unavailable('principal');
  }
  return Option.some(routeScope);
});

const decodePrivacyDispatchIssuance = Effect.fn('GatewayIssuer.decodePrivacyDispatch')(
  function* decodePrivacyDispatchIssuance<Principal>(
    input: IssueGatewayAssertionInput<Principal>,
    principal: GatewayTrustedPrincipalContext,
  ) {
    if (input.privacyDispatch === undefined) {
      if (input[privacyDispatchIssuance] === true) {
        return yield* unavailable('principal');
      }
      return Option.none<RegisteredGatewayPrivacyDispatch>();
    }
    const metadata = yield* Schema.decodeUnknownEffect(RegisteredGatewayPrivacyDispatchSchema)(
      input.privacyDispatch,
    ).pipe(Effect.mapError((cause) => unavailable('principal', cause)));
    if (
      input[privacyDispatchIssuance] !== true ||
      input.actor === undefined ||
      input.sourceValidity !== undefined ||
      input.workload !== undefined ||
      input.routeScope !== undefined ||
      input.organizationGovernanceRead !== undefined
    ) {
      return yield* unavailable('principal');
    }
    if (
      (principal.authMethod !== 'session' && principal.authMethod !== 'api_key') ||
      principal.impersonatedByPrincipalId !== undefined ||
      principal.principalId !== metadata.principalId ||
      principal.tenantId !== metadata.tenantId ||
      principal.legalEntityId !== metadata.governanceLegalEntityId ||
      input.audience !== privacyDispatchOperationContract(metadata.operation, metadata.target).appId
    ) {
      return yield* unavailable('principal');
    }
    return Option.some(metadata);
  },
);

const finiteAssertionVersion = (
  principal: GatewayTrustedPrincipalContext,
  actor: GatewayActorClaim | undefined,
  workload: RegisteredGatewayWorkload | undefined,
  privacyDispatch: RegisteredGatewayPrivacyDispatch | undefined,
  organizationGovernanceRead: RegisteredGatewayOrganizationGovernanceRead | undefined,
) => {
  if (organizationGovernanceRead !== undefined) {
    return organizationGovernanceRead.target === undefined
      ? ORGANIZATION_GOVERNANCE_GATEWAY_ASSERTION_VERSION
      : VERSIONED_ORGANIZATION_GOVERNANCE_GATEWAY_ASSERTION_VERSION;
  }
  if (privacyDispatch !== undefined) {
    return privacyDispatch.target === undefined
      ? PRIVACY_DISPATCH_GATEWAY_ASSERTION_VERSION
      : VERSIONED_PRIVACY_DISPATCH_GATEWAY_ASSERTION_VERSION;
  }
  if (workload !== undefined) {
    return WORKLOAD_GATEWAY_ASSERTION_VERSION;
  }
  return assertionVersionOf(principal, actor);
};

const decodeOrganizationGovernanceIssuance = Effect.fn('GatewayIssuer.decodeOrganizationGovernance')(
  function* decodeOrganizationGovernanceIssuance<Principal>(
    input: IssueGatewayAssertionInput<Principal>,
    principal: GatewayTrustedPrincipalContext,
  ) {
    if (input.organizationGovernanceRead === undefined) {
      if (input[organizationGovernanceReadIssuance] === true) {
        return yield* unavailable('principal');
      }
      return Option.none<RegisteredGatewayOrganizationGovernanceRead>();
    }
    const metadata = yield* Schema.decodeUnknownEffect(RegisteredGatewayOrganizationGovernanceReadSchema)(
      input.organizationGovernanceRead,
    ).pipe(Effect.mapError((cause) => unavailable('principal', cause)));
    if (
      input[organizationGovernanceReadIssuance] !== true ||
      input.actor?.appId !== 'privacy' ||
      input.sourceValidity === undefined ||
      input.workload !== undefined ||
      input.routeScope !== undefined ||
      input.privacyDispatch !== undefined
    ) {
      return yield* unavailable('principal');
    }
    if (
      (principal.authMethod !== 'session' && principal.authMethod !== 'api_key') ||
      principal.authenticationNamespaceId === undefined ||
      principal.impersonatedByPrincipalId !== undefined ||
      principal.principalId !== metadata.principalId ||
      principal.tenantId !== metadata.tenantId ||
      principal.legalEntityId !== metadata.governanceLegalEntityId ||
      input.audience !== organizationGovernanceReadOperationContract(metadata.target).appId
    ) {
      return yield* unavailable('principal');
    }
    return Option.some(metadata);
  },
);

const validateProcessingIssuance = Effect.fn('GatewayIssuer.validateProcessingIssuance')(function* validate<Principal>(
  input: IssueGatewayAssertionInput<Principal>,
  workload: RegisteredGatewayWorkload | undefined,
) {
  if (
    (workload?.organizationProcessingRead !== undefined) !== (input[organizationProcessingReadIssuance] === true) ||
    (input[organizationProcessingReadIssuance] === true &&
      (input.audience !== SYMMY_INGRESS_AUDIENCE ||
        input.sourceValidity === undefined ||
        input.actor !== undefined ||
        input.routeScope !== undefined ||
        input.privacyDispatch !== undefined ||
        input.organizationGovernanceRead !== undefined))
  ) {
    return yield* unavailable('principal');
  }
  return yield* Effect.void;
});

const decodeIssuanceIdentity = Effect.fn('GatewayIssuer.decodeIdentity')(function* decodeIdentity<Principal>(
  input: IssueGatewayAssertionInput<Principal>,
) {
  const principal = yield* Schema.decodeUnknownEffect(GatewayTrustedPrincipalContextSchema, {
    onExcessProperty: 'error',
  })(input.principal).pipe(Effect.mapError((failureCause) => unavailable('principal', failureCause)));
  if (deniesSymmyAudience(input, principal)) {
    return yield* symmyAudienceForbidden();
  }
  const routeScope = Option.getOrUndefined(yield* decodeRouteScopedIssuance(input, principal));
  const workload =
    input.workload === undefined
      ? undefined
      : yield* Schema.decodeUnknownEffect(RegisteredGatewayWorkloadSchema)(input.workload).pipe(
          Effect.mapError((cause) => unavailable('principal', cause)),
        );
  yield* validateProcessingIssuance(input, workload);
  const privacyDispatch = Option.getOrUndefined(yield* decodePrivacyDispatchIssuance(input, principal));
  const organizationGovernanceRead = Option.getOrUndefined(
    yield* decodeOrganizationGovernanceIssuance(input, principal),
  );
  if (
    (principal.authMethod === 'system' && workload === undefined) ||
    (workload !== undefined &&
      (principal.authMethod !== 'system' ||
        input.actor !== undefined ||
        (input.sourceValidity !== undefined && input[organizationProcessingReadIssuance] !== true) ||
        principal.authContextRef !== `job:${workload.jobKey}:run:${workload.runReference}`))
  ) {
    return yield* unavailable('principal');
  }
  const actor = input.actor === undefined ? undefined : yield* decodeDelegatedActor(input.actor);
  if (
    actor !== undefined &&
    (actor.principalId === principal.principalId ||
      (privacyDispatch === undefined &&
        organizationGovernanceRead === undefined &&
        principal.authenticationNamespaceId === undefined))
  ) {
    // A version 3 assertion names two different parties, and its subject must carry an explicit namespace.
    return yield* unavailable('principal');
  }
  return { actor, organizationGovernanceRead, principal, privacyDispatch, routeScope, workload };
});

const issuanceWindow = (now: number, validity: IssueGatewayAssertionInput['sourceValidity']) => {
  const issuedAt = validity?.issuedAt ?? now;
  const expiresAt = validity?.expiresAt ?? now + GATEWAY_ASSERTION_TTL_SECONDS;
  return Number.isSafeInteger(now) &&
    now >= 0 &&
    Number.isSafeInteger(issuedAt) &&
    Number.isSafeInteger(expiresAt) &&
    issuedAt <= now &&
    expiresAt > now &&
    expiresAt - issuedAt === GATEWAY_ASSERTION_TTL_SECONDS
    ? Effect.succeed({ expiresAt, issuedAt })
    : Effect.fail(unavailable('clock'));
};

const makeGatewayIssuer = Effect.fn('GatewayIssuer.make')(function* gatewayIssuerService(
  options: GatewayIssuerLayerOptions,
) {
  const scopeGrantRegistrar = yield* GatewayScopeGrantRegistrar;
  const configurationCache = yield* Cache.makeWith(
    (_key: 'configuration') =>
      options.loadConfig.pipe(Effect.mapError((failureCause) => unavailable('configuration', failureCause))),
    {
      capacity: 1,
      timeToLive: (exit, _key) => (Exit.isSuccess(exit) ? SIGNING_CONFIGURATION_REFRESH : '0 seconds'),
    },
  );
  const slot = yield* Ref.make<{
    readonly fingerprint: string;
    readonly key: CryptoKey;
  } | null>(null);
  const gate = yield* Semaphore.make(1);

  const loadSigningKey = (
    privateJwk: GatewayIssuerConfigValue['privateJwk'],
  ): Effect.Effect<CryptoKey, GatewayIssuerError> => {
    // Fingerprint all key material without retaining the private scalar separately.
    const fingerprint = Base64Url.encode(sha256(utf8ToBytes(`${privateJwk.kid}\n${privateJwk.x}\n${privateJwk.d}`)));
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
    const { actor, organizationGovernanceRead, principal, privacyDispatch, routeScope, workload } =
      yield* decodeIssuanceIdentity(input);
    const admission = yield* options.loadAdmission.pipe(
      Effect.mapError((failureCause) => unavailable('audience', failureCause)),
    );
    const targetBuildMarker = admission.audiences.get(input.audience);
    if (targetBuildMarker === undefined) {
      return yield* new GatewayIssuerErrorConstructor({
        code: 'gateway_audience_invalid',
        reason: 'The requested audience and document release are not in the current approved Application Composition',
        stage: 'audience',
      });
    }

    if (input.compositionRevision !== admission.revision) {
      return yield* new GatewayIssuerErrorConstructor({
        code: 'gateway_revision_unsupported',
        reason: 'The document release is no longer admitted. Reload to continue.',
        stage: 'audience',
      });
    }

    const configuration = yield* Cache.get(configurationCache, 'configuration');
    const now = yield* options.currentTimeSeconds;
    const { expiresAt, issuedAt } = yield* issuanceWindow(now, input.sourceValidity);
    const jti = yield* options.generateJti;
    const preparedSigningMaterial: GatewaySigningMaterial = {
      issuer: configuration.issuer,
      key: yield* loadSigningKey(configuration.privateJwk),
      kid: configuration.privateJwk.kid,
    };
    const signer = new SignJWT(
      withOptionalProperty(
        withOptionalProperty(
          withOptionalProperty(
            withOptionalProperty(
              withOptionalProperty(
                { compositionRevision: admission.revision, principal, targetBuildMarker },
                organizationGovernanceRead !== undefined,
                'organizationGovernanceRead',
                organizationGovernanceRead,
                {},
              ),
              privacyDispatch !== undefined,
              'privacyDispatch',
              privacyDispatch,
              {},
            ),
            routeScope !== undefined,
            'routeScope',
            routeScope,
            {},
          ),
          workload !== undefined,
          'workload',
          workload,
          {},
        ),
        actor !== undefined,
        'act',
        actor,
        {
          ver: finiteAssertionVersion(principal, actor, workload, privacyDispatch, organizationGovernanceRead),
        },
      ),
    )
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
    // Every audience goes through the registrar; it registers only audiences enrolled for gateway scope grants.
    // A failed registration fails issuance, so no unregistered assertion leaves the issuer.
    yield* scopeGrantRegistrar
      .register(
        withOptionalProperty(
          {
            assertion: Redacted.make(token),
            audience: input.audience,
          },
          (workload?.legalEntityId ?? principal.legalEntityId) !== undefined,
          'legalEntityId',
          workload?.legalEntityId ?? principal.legalEntityId,
          {
            expiresAtEpochSeconds: expiresAt,
            jti,
            principalId: principal.principalId,
            tenantId: principal.tenantId,
          },
        ),
      )
      .pipe(Effect.mapError((failureCause) => unavailable('scope_grant', failureCause)));

    const response = {
      apiBaseUrl:
        input.audience === 'shell-super-app'
          ? '/shell-super-app-api'
          : moduleReleaseApiBaseUrl(input.audience, targetBuildMarker),
      compositionRevision: admission.revision,
      expiresAt,
      token,
    };
    const machine =
      workload === undefined
        ? response
        : {
            ...response,
            machineContext: {
              authContextRef: principal.authContextRef,
              bindingIncarnation: workload.bindingIncarnation,
              principalId: principal.principalId,
            },
          };
    const result = workload?.recovery === undefined ? machine : { ...machine, recovery: workload.recovery };
    return yield* Schema.decodeUnknownEffect(GatewayContextResponseSchema)(result).pipe(
      Effect.mapError((cause) => unavailable('principal', cause)),
    );
  });

  return {
    issue,
  } satisfies GatewayIssuerService;
});

export const makeGatewayIssuerLayer = (options: GatewayIssuerLayerOptions) =>
  Layer.effect(GatewayIssuer, makeGatewayIssuer(options));

export const GatewayIssuerLive = Layer.unwrap(
  ShellInstalledModuleCatalog.pipe(
    Effect.map((catalog) =>
      makeGatewayIssuerLayer({
        currentTimeSeconds: Clock.currentTimeMillis.pipe(Effect.map((milliseconds) => Math.floor(milliseconds / 1000))),
        generateJti: gatewayCrypto
          .randomUUIDv4()
          .pipe(Effect.mapError((failureCause) => unavailable('signing', failureCause))),
        loadAdmission: catalog.load.pipe(
          Effect.map(({ composition, contracts }) => ({
            audiences: new Map([
              [composition.shell.deployment.appId, composition.shell.deployment.buildMarker],
              ...contracts.map(({ deployment }) => [deployment.appId, deployment.buildMarker] as const),
            ]),
            revision: composition.revision,
          })),
        ),
        loadConfig: loadGatewayIssuerConfig(),
      }),
    ),
  ),
);

export const issueGatewayContextAssertion = Effect.fn('GatewayIssuer.issueGatewayContextAssertion')(
  function* issueGatewayContextAssertionEffect<Principal>(input: IssueGatewayAssertionInput<Principal>) {
    const gatewayIssuer = yield* GatewayIssuer;
    return yield* gatewayIssuer.issue(input);
  },
);

/** Shell-private: only the native evidence module's opaque witness may request finite human issuance. */
export const issuePrivacyDispatchGatewayContextAssertion: (
  witness: AdmittedPrivacyDispatch,
  input: { readonly actor: GatewayActorClaim; readonly audience: string; readonly compositionRevision: string },
) => Effect.Effect<GatewayContextResponse, GatewayIssuerError, GatewayIssuer> = Effect.fn(
  'GatewayIssuer.issuePrivacyDispatch',
)(function* issuePrivacyDispatchGatewayContextAssertion(
  witness: AdmittedPrivacyDispatch,
  input: { readonly actor: GatewayActorClaim; readonly audience: string; readonly compositionRevision: string },
) {
  const admitted = readAdmittedPrivacyDispatch(witness);
  if (admitted === undefined) {
    return yield* unavailable('principal');
  }
  return yield* (yield* GatewayIssuer).issue({
    ...input,
    principal: admitted.principal,
    privacyDispatch: admitted.privacyDispatch,
    [privacyDispatchIssuance]: true,
  });
});

/** Shell-private: identity and validity come only from the complete current-human Read witness. */
export const issueOrganizationGovernanceReadGatewayContextAssertion: (
  witness: AdmittedOrganizationGovernanceRead,
  input: { readonly actor: GatewayActorClaim; readonly audience: string; readonly compositionRevision: string },
) => Effect.Effect<GatewayContextResponse, GatewayIssuerError, GatewayIssuer> = Effect.fn(
  'GatewayIssuer.issueOrganizationGovernanceRead',
)(function* issueOrganizationGovernanceReadGatewayContextAssertion(
  witness: AdmittedOrganizationGovernanceRead,
  input: { readonly actor: GatewayActorClaim; readonly audience: string; readonly compositionRevision: string },
) {
  const admitted = readAdmittedOrganizationGovernanceRead(witness);
  if (admitted === undefined) {
    return yield* unavailable('principal');
  }
  return yield* (yield* GatewayIssuer).issue({
    ...input,
    organizationGovernanceRead: admitted.organizationGovernanceRead,
    [organizationGovernanceReadIssuance]: true,
    principal: admitted.principal,
    sourceValidity: admitted.sourceValidity,
  });
});

/** Shell-private: the one-use witness is minted only after the exact native V4 conditional admission. */
export const issueOrganizationProcessingReadGatewayContextAssertion: (
  witness: AdmittedOrganizationProcessingRead,
) => Effect.Effect<GatewayContextResponse, GatewayIssuerError, GatewayIssuer> = Effect.fn(
  'GatewayIssuer.issueOrganizationProcessingRead',
)(function* issueOrganizationProcessingReadGatewayContextAssertion(witness: AdmittedOrganizationProcessingRead) {
  const admitted = takeAdmittedOrganizationProcessingRead(witness);
  if (admitted === undefined) {
    return yield* unavailable('principal');
  }
  return yield* (yield* GatewayIssuer).issue({
    audience: SYMMY_INGRESS_AUDIENCE,
    compositionRevision: admitted.compositionRevision,
    [organizationProcessingReadIssuance]: true,
    principal: admitted.principal,
    sourceValidity: admitted.sourceValidity,
    workload: admitted.workload,
  });
});

export const issueSymmyGatewayContextAssertion = Effect.fn('GatewayIssuer.issueSymmyGatewayContextAssertion')(
  function* issueSymmyGatewayContextAssertionEffect<Principal>({
    compositionRevision,
    principal,
    principalKind,
  }: Pick<IssueGatewayAssertionInput<Principal>, 'compositionRevision' | 'principal'> & {
    readonly principalKind: string;
  }) {
    if (principalKind !== 'integration') {
      return yield* symmyAudienceForbidden();
    }
    const gatewayIssuer = yield* GatewayIssuer;
    return yield* gatewayIssuer.issue({
      audience: SYMMY_INGRESS_AUDIENCE,
      compositionRevision,
      principal,
      [symmyIngressIssuance]: true,
    });
  },
);

/** Shell-private route scope issuance: the proof owner supplies only its actual protected Read result. */
export const issueRouteScopedGatewayContextAssertion = Effect.fn('GatewayIssuer.issueRouteScoped')(
  function* issueRouteScoped(input: {
    readonly audience: string;
    readonly compositionRevision: string;
    readonly principal: GatewayTrustedPrincipalContext;
    readonly routeScope: RegisteredGatewayRouteScope;
  }) {
    const gatewayIssuer = yield* GatewayIssuer;
    return yield* gatewayIssuer.issue({ ...input, [routeScopedIssuance]: true, [symmyIngressIssuance]: true });
  },
);
