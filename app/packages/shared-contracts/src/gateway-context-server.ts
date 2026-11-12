import { TrustedPrincipalContextSchema } from '@app/core-runtime/actions/principal-context';
import { MODULE_CREDENTIAL_VARIABLE } from '@app/core-runtime/auth/hosted-module-credentials';
import { moduleCredentialConfigProvider } from '@app/core-runtime/auth/owner-module-credential';
import type { TrustedPrincipalContext } from '@app/core-runtime/actions/principal-context';
import {
  readVerifiedGatewayCompositionRevision,
  readVerifiedGatewayScopeAssertion,
} from '@app/core-runtime/auth/system-principal-context-provenance';
import type { Crypto } from 'effect';
import { Config, ConfigProvider, Effect, Match, Redacted, Schema } from 'effect';

import { issueDelegatedGatewayContext } from './gateway-context-api-key.ts';
import type { GatewayDelegatedContextRequest } from './gateway-context.ts';

export class GatewayDelegationSourceError extends Schema.TaggedError<GatewayDelegationSourceError>()(
  'GatewayDelegationSourceError',
  {
    cause: Schema.optionalKey(Schema.Defect()),
    reason: Schema.String,
  },
) {}

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

/** Why a delegated call failed before any request: the calling module holds no module credential at all. */
export const MISSING_MODULE_CREDENTIAL_REASON = 'The calling module holds no module credential';

/** Requests a fresh module-to-module context authenticated by this deployment's own module credential. */
export const acquireDelegatedGatewayContext = Effect.fn('GatewayDelegation.acquire')(function* acquire(
  request: GatewayDelegationRequest,
  crypto: Crypto.Crypto,
) {
  // Every delegated call reads its caller's own key through the per-owner view, whichever runtime, worker or
  // background fiber it runs in; nothing else in a process reads a module credential.
  const owner = moduleCredentialConfigProvider(yield* ConfigProvider.ConfigProvider, request.callingAppId);
  const [apiKey, configuration, source] = yield* Effect.all(
    [
      // A module that holds no credential of its own fails here, before any request, and says so.
      Config.Redacted(MODULE_CREDENTIAL_VARIABLE)
        .parse(owner)
        .pipe(
          Effect.mapError(
            (cause) => new GatewayDelegationSourceError({ cause, reason: MISSING_MODULE_CREDENTIAL_REASON }),
          ),
        ),
      Config.all({
        baseUrl: Config.schema(
          Schema.URLFromString.check(
            Schema.makeFilter((url) =>
              (url.protocol === 'http:' || url.protocol === 'https:') &&
              url.username === '' &&
              url.password === '' &&
              url.hash === ''
                ? undefined
                : 'Gateway transport requires an HTTP URL without credentials or fragment',
            ),
          ),
          'ONTOS_SHELL_GATEWAY_BASE_URL',
        ),
      })
        .parse(owner)
        .pipe(
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
    apiKey,
    baseUrl: configuration.baseUrl,
    requestCorrelation: request.requestCorrelation,
  });
  if (response.compositionRevision !== source.compositionRevision) {
    return yield* new GatewayDelegationSourceError({ reason: 'Gateway delegation changed the admitted release' });
  }
  const authorization: `Bearer ${string}` = `Bearer ${response.token}`;
  return {
    apiBaseUrl: new URL(response.apiBaseUrl, configuration.baseUrl).toString(),
    authorization,
    compositionRevision: response.compositionRevision,
    expiresAt: response.expiresAt,
  };
});
