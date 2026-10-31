import { Base64Url } from 'effect/encoding';
import {
  ConsentSelfServiceRequestSchema,
  TrustedOperationConsentAuthorityFactSchema,
  PrivacyNoticeAuthorityFactSchema,
  RecordNoticeProvisionPayloadSchema,
} from '@app/consent-authority-contracts';
import type {
  ConsentSelfServiceRequest,
  TrustedOperationConsentAuthorityFact,
  PrivacyNoticeAuthorityFact,
  RecordNoticeProvisionPayload,
} from '@app/consent-authority-contracts';
import {
  resolveCommerceConsentAuthorityWithAuthorization,
  resolveCommerceConsentNoticeAuthorityWithAuthorization,
} from '@app/consent-authority-contracts/client';
import type { NoticeChannelDeliveryAuthorityService } from './record-notice-provision.action.ts';
import { NoticeProvisionPersistenceError } from '../persistence/notice-provision-repository.ts';
import { ActionPermissionCheckError } from '@app/core-runtime';
import type { ActionAuthorizationPreflightInput, ActionAuthorizationPreflightService } from '@app/core-runtime';
import { ActiveApplicationCompositionService } from '@app/core-runtime/modules/active-application-composition';
import { SupportedGatewayContextClaimsSchema } from '@app/shared-contracts';
import { issueApiKeyGatewayContext } from '@app/shared-contracts/server/gateway-context-api-key';
import type { Scope } from 'effect';
import { Config, Context, DateTime, Effect, Redacted, Schema } from 'effect';
import {
  ConsentSelfServiceAuthorizationError,
  resolveAndAuthorizeConsentSelfService,
} from '../../shared/domain/privacy-consent-self-service.ts';
import type { ConsentSelfServiceAuthorityService } from './consent-self-service.action.ts';

// Keep only an allowlisted failure category: transport errors can contain bearer headers and bodies.
const failureCategory = (cause: unknown): string => {
  if (Schema.is(ConsentSelfServiceAuthorizationError)(cause)) {
    return cause.code;
  }
  if (
    Schema.is(
      Schema.Struct({
        _tag: Schema.Literals(['ConfigError', 'HttpClientError', 'HttpApiClientError', 'SchemaError', 'ParseError']),
      }),
    )(cause)
  ) {
    return cause._tag;
  }
  return 'OWNER_UNAVAILABLE';
};
const unavailable = (cause: unknown) =>
  new ConsentSelfServiceAuthorizationError({
    code: 'AUTHORITY_UNAVAILABLE',
    reason: `Commerce operation consent authority is unavailable (${failureCategory(cause)})`,
  });
const missing = () =>
  new ConsentSelfServiceAuthorizationError({
    code: 'MISSING_AUTHORITY',
    reason: 'No matching invocation-scoped Commerce consent authority is prepared',
  });
const deniedPorts = {
  resolveCurrentRetailPortalProfileBinding: () => Effect.fail(missing()),
  resolveSupportAuthority: () => Effect.fail(missing()),
};
export interface CommerceConsentAuthorityLookupInput {
  readonly credentialRef: string;
  readonly preflight: ActionAuthorizationPreflightInput;
  readonly request: ConsentSelfServiceRequest;
}
export interface CommerceConsentAuthorityLookupService {
  readonly resolve: (
    input: CommerceConsentAuthorityLookupInput,
  ) => Effect.Effect<TrustedOperationConsentAuthorityFact, ConsentSelfServiceAuthorizationError>;
  readonly resolveNotice: (input: {
    readonly preflight: ActionAuthorizationPreflightInput;
    readonly request: RecordNoticeProvisionPayload;
  }) => Effect.Effect<PrivacyNoticeAuthorityFact, ConsentSelfServiceAuthorizationError>;
}
export class CommerceConsentAuthorityLookup extends Context.Service<
  CommerceConsentAuthorityLookup,
  CommerceConsentAuthorityLookupService
>()('@app/privacy/actions/commerce-consent-authority/CommerceConsentAuthorityLookup') {}
const configuration = Config.all({
  actorPrincipalId: Config.schema(Schema.String.check(Schema.isUUID()), 'COMMERCE_MARKETING_ACTOR_PRINCIPAL_ID'),
  apiKey: Config.Redacted('ONTOS_PRIVACY_GATEWAY_API_KEY'),
  baseUrl: Config.schema(
    Schema.URLFromString.check(
      Schema.makeFilter((url) =>
        (url.protocol === 'http:' || url.protocol === 'https:') &&
        url.username.length === 0 &&
        url.password.length === 0 &&
        url.search.length === 0 &&
        url.hash.length === 0
          ? undefined
          : 'Shell URL must be HTTP(S) without credentials, query, or fragment',
      ),
    ),
    'ONTOS_SHELL_GATEWAY_BASE_URL',
  ),
});

/** Owner I/O is only invoked by the Core preflight, before the Action transaction opens. */
export const commerceConsentAuthorityLookup = Effect.gen(function* commerceConsentAuthorityLookupService() {
  const composition = yield* ActiveApplicationCompositionService;
  const acquireGateway = Effect.fn('PrivacyCommerceConsentAuthority.acquireGateway')(function* acquire(
    preflight: ActionAuthorizationPreflightInput,
  ) {
    const { legalEntityId } = preflight.scope;
    if (legalEntityId === undefined) {
      return yield* missing();
    }
    const configured = yield* configuration.pipe(Effect.mapError(unavailable));
    if (configured.actorPrincipalId !== preflight.principal.principalId) {
      return yield* missing();
    }
    const active = yield* composition.load.pipe(Effect.mapError(unavailable));
    const compositionRevision = active.composition.revision;
    const gateway = yield* issueApiKeyGatewayContext(
      {
        audience: 'commerce-customer-context',
        compositionRevision,
        legalEntityId,
      },
      {
        apiKey: configured.apiKey,
        baseUrl: configured.baseUrl,
        requestCorrelation: preflight.correlationId,
      },
    ).pipe(Effect.mapError(unavailable));
    const tokenPayload = gateway.token.split('.').at(1);
    if (tokenPayload === undefined || gateway.compositionRevision !== compositionRevision) {
      return yield* unavailable('gateway_scope_mismatch');
    }
    const claims = yield* Effect.fromResult(Base64Url.decodeString(tokenPayload)).pipe(
      Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(SupportedGatewayContextClaimsSchema))),
      Effect.mapError(unavailable),
    );
    if (
      claims.aud !== 'commerce-customer-context' ||
      claims.compositionRevision !== compositionRevision ||
      claims.principal.tenantId !== preflight.scope.tenantId ||
      claims.principal.legalEntityId !== legalEntityId ||
      claims.principal.authMethod !== 'api_key'
    ) {
      return yield* unavailable('gateway_scope_mismatch');
    }
    return {
      baseUrl: new URL(gateway.apiBaseUrl, configured.baseUrl),
      compositionRevision,
      credential: Redacted.make(`Bearer ${gateway.token}`),
      requestCorrelation: preflight.correlationId,
    };
  });
  return {
    resolve: Effect.fn('PrivacyCommerceConsentAuthority.resolve')(function* resolve(
      input: CommerceConsentAuthorityLookupInput,
    ) {
      const gateway = yield* acquireGateway(input.preflight);
      return yield* resolveCommerceConsentAuthorityWithAuthorization(
        { credentialRef: input.credentialRef, request: input.request },
        gateway,
      ).pipe(Effect.mapError(unavailable));
    }),
    resolveNotice: Effect.fn('PrivacyCommerceConsentAuthority.resolveNotice')(function* resolveNotice(input: {
      readonly preflight: ActionAuthorizationPreflightInput;
      readonly request: RecordNoticeProvisionPayload;
    }) {
      const gateway = yield* acquireGateway(input.preflight);
      return yield* resolveCommerceConsentNoticeAuthorityWithAuthorization(input.request, gateway).pipe(
        Effect.mapError(unavailable),
      );
    }),
  } satisfies CommerceConsentAuthorityLookupService;
});

export interface PreparedCommerceConsentExecution {
  readonly authority: ConsentSelfServiceAuthorityService;
  readonly clear: () => void;
  readonly noticeAuthority: NoticeChannelDeliveryAuthorityService;
  readonly preflight: ActionAuthorizationPreflightService;
}
const sameRequest = Schema.toEquivalence(ConsentSelfServiceRequestSchema);
const sameNoticeRequest = Schema.toEquivalence(RecordNoticeProvisionPayloadSchema);
const permissionUnavailable = (cause: unknown) =>
  new ActionPermissionCheckError({
    code: 'action_permission_check_failed',
    reason: `Commerce consent authority preparation did not complete (${failureCategory(cause)})`,
  });

/** A fresh instance belongs to exactly one native runAction call, never a cross-request cache. */
export const preparedCommerceConsentExecution: Effect.Effect<
  PreparedCommerceConsentExecution,
  never,
  CommerceConsentAuthorityLookup | Scope.Scope
> = Effect.gen(function* prepareCommerceConsentExecution() {
  const lookup = yield* CommerceConsentAuthorityLookup;
  let prepared: Readonly<{ fact: TrustedOperationConsentAuthorityFact; request: ConsentSelfServiceRequest }> | null =
    null;
  let preparedNotice: Readonly<{
    fact: PrivacyNoticeAuthorityFact;
    invocationId: string;
    legalEntityId: string;
    principalId: string;
    request: RecordNoticeProvisionPayload;
    tenantId: string;
  }> | null = null;
  const authority: ConsentSelfServiceAuthorityService = {
    ports: {
      ...deniedPorts,
      verifyOperationCredential: ({ credentialRef, request }) =>
        Effect.suspend(() => {
          const current = prepared;
          prepared = null;
          return current !== null && current.fact.proofRef === credentialRef && sameRequest(current.request, request)
            ? Effect.succeed(current.fact)
            : Effect.fail(missing());
        }),
    },
  };
  const execution: PreparedCommerceConsentExecution = {
    authority,
    clear: () => {
      prepared = null;
      preparedNotice = null;
    },
    noticeAuthority: {
      resolve: (request, context) =>
        Effect.suspend(() => {
          const current = preparedNotice;
          preparedNotice = null;
          return current !== null &&
            current.invocationId === context.actionInvocationId &&
            current.principalId === context.principalId &&
            current.tenantId === context.tenantId &&
            current.legalEntityId === context.legalEntityId &&
            sameNoticeRequest(current.request, request)
            ? Effect.succeed(current.fact)
            : Effect.fail(
                new NoticeProvisionPersistenceError({
                  code: 'privacy_notice_provision_persistence_unavailable',
                  reason: 'No matching invocation-scoped Commerce notice authority is prepared',
                }),
              );
        }),
    },
    preflight: {
      prepare: Effect.fn('PrivacyCommerceConsentAuthority.prepare')(function* prepare(input) {
        if (input.actionKey === 'privacy.core.record-notice-provision') {
          preparedNotice = null;
          const request = yield* Schema.decodeUnknownEffect(RecordNoticeProvisionPayloadSchema, {
            onExcessProperty: 'error',
          })(input.payload).pipe(Effect.mapError(permissionUnavailable));
          if (
            input.scope.legalEntityId === undefined ||
            input.scope.principalId !== input.principal.principalId ||
            input.scope.tenantId !== input.principal.tenantId ||
            input.scope.legalEntityId !== input.principal.legalEntityId
          ) {
            return { outcome: 'denied' } as const;
          }
          const fact = yield* lookup
            .resolveNotice({ preflight: input, request })
            .pipe(
              Effect.flatMap(
                Schema.decodeUnknownEffect(PrivacyNoticeAuthorityFactSchema, { onExcessProperty: 'error' }),
              ),
              Effect.mapError(permissionUnavailable),
            );
          if (fact.claimRef !== request.claimRef) {
            return { outcome: 'denied' } as const;
          }
          preparedNotice = {
            fact,
            invocationId: input.actionInvocationId,
            legalEntityId: input.scope.legalEntityId,
            principalId: input.principal.principalId,
            request,
            tenantId: input.scope.tenantId,
          };
          return { outcome: 'not_applicable' } as const;
        }
        if (input.actionKey !== 'privacy.core.consent-self-service') {
          return { outcome: 'not_applicable' } as const;
        }
        prepared = null;
        const request = yield* Schema.decodeUnknownEffect(ConsentSelfServiceRequestSchema, {
          onExcessProperty: 'error',
        })(input.payload).pipe(Effect.mapError(permissionUnavailable));
        if (
          request.path.kind !== 'OPERATION_SCOPED' ||
          input.scope.legalEntityId === undefined ||
          input.scope.principalId !== input.principal.principalId ||
          input.scope.tenantId !== input.principal.tenantId ||
          input.scope.legalEntityId !== input.principal.legalEntityId ||
          request.scope.privacySubjectRef.tenantId !== input.scope.tenantId
        ) {
          return { outcome: 'denied' } as const;
        }
        const fact = yield* lookup
          .resolve({ credentialRef: request.path.credentialRef, preflight: input, request })
          .pipe(
            Effect.flatMap(
              Schema.decodeUnknownEffect(TrustedOperationConsentAuthorityFactSchema, { onExcessProperty: 'error' }),
            ),
            Effect.mapError(permissionUnavailable),
          );
        if (
          fact.actorPrincipalRef?.principalId !== input.principal.principalId ||
          fact.actorPrincipalRef.tenantId !== input.principal.tenantId
        ) {
          return { outcome: 'denied' } as const;
        }
        const now = DateTime.formatIso(yield* DateTime.now);
        const decision = yield* resolveAndAuthorizeConsentSelfService({
          now,
          ports: { ...deniedPorts, verifyOperationCredential: () => Effect.succeed(fact) },
          principalRef: { principalId: input.principal.principalId, tenantId: input.principal.tenantId },
          request,
        }).pipe(Effect.mapError(permissionUnavailable));
        if (!decision.allowed) {
          return { outcome: 'denied' } as const;
        }
        prepared = { fact, request };
        // Preparation supplies evidence only. Ordinary module, scope and executor gates still run.
        return { outcome: 'not_applicable' } as const;
      }),
    },
  };
  yield* Effect.addFinalizer(() => Effect.sync(execution.clear));
  return execution;
});
