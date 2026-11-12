import { TrustedPrincipalContextSchema } from '@app/core-runtime/actions/principal-context';
import { ownModuleCredential, ownWorkloadCredential } from '@app/core-runtime/auth/owner-module-credential';
import type { TrustedPrincipalContext } from '@app/core-runtime/actions/principal-context';
import {
  readVerifiedGatewayCompositionRevision,
  readVerifiedGatewayScopeAssertion,
} from '@app/core-runtime/auth/system-principal-context-provenance';
import type { Crypto } from 'effect';
import { Config, ConfigProvider, Effect, Match, Option, Redacted, Schema } from 'effect';

import { issueApiKeyGatewayContext, issueDelegatedGatewayContext } from './gateway-context-api-key.ts';
import type {
  GatewayContextClientError,
  GatewayContextProblem,
  GatewayDelegatedContextRequest,
} from './gateway-context.ts';

export class GatewayDelegationSourceError extends Schema.TaggedError<GatewayDelegationSourceError>()(
  'GatewayDelegationSourceError',
  {
    cause: Schema.optionalKey(Schema.Defect()),
    reason: Schema.String,
  },
) {}

/** Every way getting a gateway context can fail at the caller. */
export type GatewayContextFailure = GatewayContextClientError | GatewayDelegationSourceError;

const describeShellRefusal = (problem: GatewayContextProblem): string =>
  Match.value(problem).pipe(
    Match.tag(
      'GatewayAuthenticationRequiredProblem',
      'GatewayForbiddenProblem',
      'GatewayReloadRequiredProblem',
      'GatewayUnavailableProblem',
      (refusal) =>
        refusal.reason === undefined
          ? `Shell refused (${refusal._tag})`
          : `Shell refused (${refusal._tag}, reason ${refusal.reason})`,
    ),
    Match.orElse((refusal) => `Shell refused (${refusal._tag})`),
  );

/**
 * What went wrong getting a gateway context, in words an operator can act on and nothing secret: the caller's own
 * reason, the Shell's problem with its refusal code, or the transport failure. Never a key, token or subject.
 */
export const describeGatewayContextFailure = (failure: GatewayContextFailure): string =>
  Match.value(failure).pipe(
    Match.tag('GatewayDelegationSourceError', ({ reason }) => reason),
    Match.tag('SchemaError', () => 'the Shell response could not be decoded'),
    Match.tag('HttpClientError', ({ reason }) => `transport failure (${reason._tag})`),
    Match.orElse(describeShellRefusal),
  );

/** The one warning a caller writes when its gateway context was not issued. */
const logGatewayContextFailure = (
  failure: GatewayContextFailure,
  request: { readonly audience: string; readonly callingAppId: string; readonly subjectTenant: string },
) =>
  Effect.logWarning('gateway context not issued').pipe(
    Effect.annotateLogs({
      audience: request.audience,
      callingAppId: request.callingAppId,
      reason: describeGatewayContextFailure(failure),
      subjectTenant: request.subjectTenant,
    }),
  );

const VerifiedScopeSchema = Schema.declare<TrustedPrincipalContext>((value): value is TrustedPrincipalContext =>
  Schema.is(TrustedPrincipalContextSchema)(value),
);
const uuidString = Schema.String.check(Schema.isUUID());
const revisionString = Schema.String.check(Schema.isPattern(/^[\da-f]{64}$/u));

/**
 * Whom the call is done for. `Assertion` takes the receiving module's verified scope; `Originator`
 * names the action invocation of asynchronous work, the release that work was admitted under and, for work
 * started in the tenant context, the one company it belongs to.
 */
export const GatewayDelegationSubjectSchema = Schema.Union([
  Schema.TaggedStruct('Assertion', { scope: VerifiedScopeSchema }),
  Schema.TaggedStruct('Originator', {
    actionInvocationId: uuidString.pipe(Schema.brand('ActionInvocationId')),
    compositionRevision: revisionString,
    legalEntityId: Schema.optionalKey(uuidString.pipe(Schema.brand('LegalEntityId'))),
    tenantId: uuidString.pipe(Schema.brand('TenantId')),
  }),
]);
export type GatewayDelegationSubject = typeof GatewayDelegationSubjectSchema.Encoded;

export interface GatewayDelegationRequest {
  readonly audience: string;
  /**
   * The module making the call. Its own module credential authenticates the call: in a process that hosts several
   * owners, the one the host handed this module, never another owner's and never the shared environment's.
   */
  readonly callingAppId: string;
  readonly legalEntityScope: 'subject' | 'tenant';
  readonly requestCorrelation: string;
  readonly subject: GatewayDelegationSubject;
}

type WireSubject = GatewayDelegatedContextRequest['subject'];
interface WireSubjectRevision {
  readonly compositionRevision: string;
  readonly subject: WireSubject;
}

/** Subject evidence is read from Core-verified provenance only; Shell revalidates it independently. */
const assertionWire = ({
  scope,
}: {
  readonly scope: TrustedPrincipalContext;
}): Effect.Effect<WireSubjectRevision, GatewayDelegationSourceError> => {
  const assertion = readVerifiedGatewayScopeAssertion(scope);
  const compositionRevision = readVerifiedGatewayCompositionRevision(scope);
  if (assertion === undefined || compositionRevision === undefined) {
    return Effect.fail(
      new GatewayDelegationSourceError({ reason: 'Verified gateway scope is required to act for the requester' }),
    );
  }
  return Effect.succeed({
    compositionRevision,
    subject: { _tag: 'Assertion', sourceAssertion: Redacted.value(assertion.assertion) },
  });
};

const subjectWireOf = (
  subject: GatewayDelegationSubject,
): Effect.Effect<WireSubjectRevision, GatewayDelegationSourceError> =>
  Match.value(subject).pipe(
    Match.tag('Originator', (originator) =>
      Effect.succeed({
        compositionRevision: originator.compositionRevision,
        subject:
          originator.legalEntityId === undefined
            ? { _tag: 'Originator', actionInvocationId: originator.actionInvocationId, tenantId: originator.tenantId }
            : {
                _tag: 'Originator',
                actionInvocationId: originator.actionInvocationId,
                legalEntityId: originator.legalEntityId,
                tenantId: originator.tenantId,
              },
      } satisfies WireSubjectRevision),
    ),
    Match.tag('Assertion', assertionWire),
    Match.exhaustive,
  );

/** Hosts a module may reach the Shell on over plain HTTP: the same machine (the app host's loopback relay, a dev box). */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Where a module's keys are presented: HTTPS, or plain HTTP to the same machine only. */
const ShellGatewayBaseUrl = Config.schema(
  Schema.URLFromString.check(
    Schema.makeFilter((url) =>
      (url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname))) &&
      url.username === '' &&
      url.password === '' &&
      url.hash === ''
        ? undefined
        : 'Gateway transport requires HTTPS (plain HTTP only to a loopback host) without credentials or fragment',
    ),
  ),
  'ONTOS_SHELL_GATEWAY_BASE_URL',
);

/** Requests a fresh module-to-module context authenticated by this deployment's own module credential. */
export const acquireDelegatedGatewayContext = Effect.fn('GatewayDelegation.acquire')(
  function* acquire(request: GatewayDelegationRequest, crypto: Crypto.Crypto) {
    // Every delegated call reads its caller's own key from the slot the host claimed for that module, whichever
    // runtime, worker or background fiber it runs in; nothing else in a process reads a module credential.
    const apiKey = yield* ownModuleCredential(request.callingAppId);
    if (Option.isNone(apiKey)) {
      // Owners turn this into a generic unavailable problem; the warning below keeps the reason visible to the operator.
      return yield* new GatewayDelegationSourceError({
        reason: `No module credential of ${request.callingAppId} in this process: the host has not handed one over`,
      });
    }
    const [baseUrl, source] = yield* Effect.all(
      [
        ShellGatewayBaseUrl.parse(yield* ConfigProvider.ConfigProvider).pipe(
          Effect.mapError(
            (cause) =>
              new GatewayDelegationSourceError({ cause, reason: 'Gateway delegation transport is unavailable' }),
          ),
        ),
        subjectWireOf(request.subject),
      ],
      { concurrency: 1 },
    );
    const exchangeId = yield* crypto
      .randomUUIDv4()
      .pipe(
        Effect.mapError(
          (cause) =>
            new GatewayDelegationSourceError({ cause, reason: 'Gateway delegation attempt identity is unavailable' }),
        ),
      );
    const payload = {
      audience: request.audience,
      compositionRevision: source.compositionRevision,
      exchangeId,
      legalEntityScope: request.legalEntityScope,
      subject: source.subject,
    };
    const response = yield* issueDelegatedGatewayContext(payload, {
      apiKey: apiKey.value,
      baseUrl,
      requestCorrelation: request.requestCorrelation,
    });
    if (response.compositionRevision !== source.compositionRevision) {
      return yield* new GatewayDelegationSourceError({ reason: 'Gateway delegation changed the admitted release' });
    }
    const authorization: `Bearer ${string}` = `Bearer ${response.token}`;
    return {
      apiBaseUrl: new URL(response.apiBaseUrl, baseUrl).toString(),
      authorization,
      compositionRevision: response.compositionRevision,
      expiresAt: response.expiresAt,
    };
  },
  (effect, request) =>
    effect.pipe(
      Effect.tapError((failure) =>
        logGatewayContextFailure(failure, {
          audience: request.audience,
          callingAppId: request.callingAppId,
          subjectTenant: Match.value(request.subject).pipe(
            Match.tag('Originator', ({ tenantId }) => tenantId),
            Match.tag('Assertion', ({ scope }) => scope.tenantId),
            Match.exhaustive,
          ),
        }),
      ),
    ),
);

/** One internal workload context request: the calling module, its own workload and the tenant and company. */
export interface WorkloadGatewayRequest {
  readonly audience: string;
  /** The module whose own internal workload acts; it holds that workload's key for the tenant. */
  readonly callingAppId: string;
  readonly compositionRevision: string;
  readonly legalEntityId: string;
  readonly requestCorrelation: string;
  readonly tenantId: string;
  readonly workloadKey: string;
}

/**
 * Requests a gateway context AS a module's internal workload (O73): the principal the operator registered for that
 * workload in the tenant, authenticated by its own key, which the platform issued and the host handed to this module
 * (never an environment variable). The Shell admits it exactly as any API key of that principal: through the
 * workload's binding and the carriers that declare it. Without a key for that tenant it fails closed.
 */
export const acquireWorkloadGatewayContext = Effect.fn('GatewayWorkload.acquire')(
  function* acquireWorkload(request: WorkloadGatewayRequest) {
    const key = yield* ownWorkloadCredential({
      appId: request.callingAppId,
      tenantId: request.tenantId,
      workloadKey: request.workloadKey,
    });
    if (Option.isNone(key)) {
      return yield* new GatewayDelegationSourceError({
        reason: `No credential of ${request.workloadKey} for this tenant: the workload is not registered, or not provisioned yet`,
      });
    }
    const baseUrl = yield* ShellGatewayBaseUrl.parse(yield* ConfigProvider.ConfigProvider).pipe(
      Effect.mapError(
        (cause) => new GatewayDelegationSourceError({ cause, reason: 'Gateway workload transport is unavailable' }),
      ),
    );
    const response = yield* issueApiKeyGatewayContext(
      {
        audience: request.audience,
        compositionRevision: request.compositionRevision,
        legalEntityId: request.legalEntityId,
      },
      { apiKey: key.value, baseUrl, requestCorrelation: request.requestCorrelation },
    ).pipe(
      Effect.mapError(
        (cause) =>
          new GatewayDelegationSourceError({
            cause,
            reason: `The workload gateway context was not issued: ${describeGatewayContextFailure(cause)}`,
          }),
      ),
    );
    const authorization: `Bearer ${string}` = `Bearer ${response.token}`;
    return {
      apiBaseUrl: new URL(response.apiBaseUrl, baseUrl).toString(),
      authorization,
      compositionRevision: response.compositionRevision,
      expiresAt: response.expiresAt,
    };
  },
  (effect, request) =>
    effect.pipe(
      Effect.tapError((failure) =>
        logGatewayContextFailure(failure, {
          audience: request.audience,
          callingAppId: request.callingAppId,
          subjectTenant: request.tenantId,
        }),
      ),
    ),
);
