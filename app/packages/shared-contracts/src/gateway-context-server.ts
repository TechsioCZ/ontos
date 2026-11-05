import { TrustedPrincipalContextSchema } from '@app/core-runtime/actions/principal-context';
import type { TrustedPrincipalContext } from '@app/core-runtime/actions/principal-context';
import {
  readVerifiedGatewayCompositionRevision,
  readVerifiedGatewayScopeAssertion,
} from '@app/core-runtime/auth/system-principal-context-provenance';
import type { Crypto } from 'effect';
import { Config, Effect, Match, Redacted, Schema } from 'effect';

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

/** Requests a fresh module-to-module context authenticated by this deployment's own module credential. */
export const acquireDelegatedGatewayContext = Effect.fn('GatewayDelegation.acquire')(function* acquire(
  request: GatewayDelegationRequest,
  crypto: Crypto.Crypto,
) {
  const configuration = yield* Config.all({
    apiKey: Config.Redacted('ONTOS_GATEWAY_MODULE_API_KEY'),
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
  }).pipe(
    Effect.mapError(
      (cause) => new GatewayDelegationSourceError({ cause, reason: 'Gateway delegation transport is unavailable' }),
    ),
  );
  const source = yield* subjectWireOf(request.subject);
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
    apiKey: configuration.apiKey,
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
