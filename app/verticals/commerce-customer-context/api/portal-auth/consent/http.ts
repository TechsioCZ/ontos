import { createHash, randomUUID } from 'node:crypto';
import { RecordNoticeProvisionPayloadSchema } from '@app/consent-authority-contracts';
import type {
  ConsentSelfServiceRequest,
  RecordNoticeProvisionPayload,
  TrustedOperationConsentAuthorityFact,
  PrivacyNoticeAuthorityFact,
} from '@app/consent-authority-contracts';
import { CommerceConsentAuthoritySchemaError } from '@app/consent-authority-contracts/api';
import type { CommerceConsentAuthorityPayload } from '@app/consent-authority-contracts/api';
import type { ModuleEntrypointDescriptor, TrustedPrincipalContext } from '@app/core-runtime';
import {
  ActiveApplicationCompositionService,
  validateActiveApplicationCompositionSnapshot,
} from '@app/core-runtime/modules/active-application-composition';
import {
  executeConsentSelfServiceWithAuthorization,
  executeRecordNoticeProvisionWithAuthorization,
} from '@app/privacy/api/client';
import { HttpApiBuilder, HttpApiMiddleware, Layer } from '@modern-js/bff-effect/effect-edge';
import { DateTime, Effect, Match, Option, Redacted, Schema } from 'effect';
import type { HttpServerRequest } from 'effect/unstable/http';
import { commerceCustomerContextApi } from '../../../shared/api.ts';
import { CustomerOwnConsentSchemaError } from '../../../shared/portal-auth/consent-api.ts';
import type { UpdateCustomerOwnConsent } from '../../../shared/portal-auth/consent-api.ts';
import {
  customerConsentAuthorityEntrypoint,
  customerConsentNoticeAuthorityEntrypoint,
  customerConsentReadOwnEntrypoint,
  customerConsentUpdateOwnEntrypoint,
} from '../../../shared/portal-auth/consent-entrypoints.ts';
import { readRetailEnrollmentAccountParty } from '../../../src/enrollment/attempts/registration-persistence.ts';
import { CommerceEnrollmentOwnerTransactionRunner } from '../../../src/enrollment/orchestration/owner-transition-production.ts';
import { CommercePortalAuthAudit } from '../../../src/portal-auth/audit/audit.ts';
import { authenticateOperationPrincipal } from '../../auth/action-principal.ts';
import { noStoreHeaders, requireTrustedOrigin } from '../http-transport.ts';
import { authorizeCustomerProfile } from '../profile/http.ts';
import { readCustomerPartyProfile } from '../profile/party-profile.ts';
import { admitCustomerAccount } from '../session/http.ts';
import { CommercePortalAuthSessionLifecycle } from '../session/lifecycle.ts';
import {
  CustomerConsentReceiptSchema,
  matchesCustomerConsentReceipt,
  noticeProvisionRequest,
  sameCustomerConsentScope,
} from './model.ts';
import { acquireCustomerPrivacyGateway } from './privacy-gateway.ts';
import type { CustomerConsentScope } from './privacy-gateway.ts';
import {
  prepareCustomerNewsletterNotice,
  readCustomerNewsletterCatalog,
  readCustomerNewsletterState,
  readCustomerPrivacySubject,
  readExactCustomerNotice,
} from './privacy-owner.ts';
import { readCustomerConsentReceipt, recordCustomerConsentReceipt } from './receipt-persistence.ts';
import {
  consentAuthentication,
  consentConflict,
  consentForbidden,
  consentInvalid,
  consentUnavailable,
} from './problems.ts';

const authorize = (principal: Readonly<TrustedPrincipalContext>, entrypoint: ModuleEntrypointDescriptor) =>
  authorizeCustomerProfile(principal, entrypoint).pipe(
    Effect.mapError((p) => (p.status === 403 ? consentForbidden() : consentUnavailable())),
  );
const activeRevision = Effect.gen(function* composition() {
  const compositions = yield* ActiveApplicationCompositionService;
  return (yield* compositions.load.pipe(
    Effect.flatMap(validateActiveApplicationCompositionSnapshot),
    Effect.mapError(consentUnavailable),
  )).composition.revision;
});
const admitted = Effect.fn('CustomerConsent.admit')(function* admit(
  request: HttpServerRequest.HttpServerRequest,
  entrypoint: ModuleEntrypointDescriptor,
) {
  yield* noStoreHeaders;
  const current = yield* admitCustomerAccount(request).pipe(
    Effect.mapError((problem) => {
      if (problem.status === 401) {
        return consentAuthentication();
      }
      if (problem.status === 403) {
        return consentForbidden();
      }
      return consentUnavailable();
    }),
  );
  if (current.state !== 'authenticated') {
    return yield* Effect.fail(consentAuthentication());
  }
  yield* authorize(current.principal, entrypoint);
  if (current.principal.legalEntityId === undefined) {
    return yield* Effect.fail(consentForbidden());
  }
  const scope: CustomerConsentScope = {
    compositionRevision: yield* activeRevision,
    legalEntityId: current.principal.legalEntityId,
    partyId: current.account.partyId,
    requestCorrelation: randomUUID(),
    tenantId: current.principal.tenantId,
  };
  // Archived/merged/aliased Parties require real owner reconciliation, not a guessed successor.
  yield* readCustomerPartyProfile(scope).pipe(Effect.mapError(consentUnavailable));
  return { current, scope };
});
const read = Effect.fn('CustomerConsent.read')(function* readConsent(request: HttpServerRequest.HttpServerRequest) {
  const { scope } = yield* admitted(request, customerConsentReadOwnEntrypoint);
  const catalog = yield* readCustomerNewsletterCatalog(scope);
  const notice = yield* prepareCustomerNewsletterNotice(scope, catalog);
  return yield* readCustomerNewsletterState(scope, catalog, notice.versionId);
});
const update = Effect.fn('CustomerConsent.update')(function* updateConsent(
  request: HttpServerRequest.HttpServerRequest,
  input: UpdateCustomerOwnConsent,
) {
  yield* noStoreHeaders;
  yield* requireTrustedOrigin(request.headers, consentForbidden);
  const { current, scope } = yield* admitted(request, customerConsentUpdateOwnEntrypoint);
  const catalog = yield* readCustomerNewsletterCatalog(scope);
  if (input.purposeVersionId !== catalog.consentScope.purposeVersionRef || !input.noticeAcknowledged) {
    return yield* Effect.fail(consentConflict());
  }
  const notice = yield* readExactCustomerNotice(scope, catalog, input.noticeVersionId);
  if ((yield* readCustomerPrivacySubject(scope, catalog.consentScope)) === undefined) {
    return yield* Effect.fail(consentConflict());
  }
  const audit = yield* CommercePortalAuthAudit;
  const event = {
    correlationDigest: createHash('sha256').update(input.requestId).digest('hex'),
    operation: 'customer-newsletter-consent',
    providerSubjectId: current.session.providerSubjectId,
    sessionRef: current.session.sessionRef,
  };
  yield* audit
    .record({
      ...event,
      eventType: 'commerce.portal-auth.consent-requested.v1',
      occurredAt: yield* DateTime.nowAsDate,
      outcome: 'requested',
    })
    .pipe(Effect.mapError(consentUnavailable));
  const acknowledged = yield* Schema.decodeUnknownEffect(CustomerConsentReceiptSchema)({
    acknowledgedAt: DateTime.formatIso(yield* DateTime.now),
    decision: input.decision,
    noticeVersionId: notice.versionId,
    partyId: scope.partyId,
    providedLanguage: notice.language,
    providerSubjectId: current.session.providerSubjectId,
    requestId: input.requestId,
    scope: catalog.consentScope,
    sessionRef: current.session.sessionRef,
  }).pipe(Effect.mapError(consentUnavailable));
  const receipt = yield* recordCustomerConsentReceipt(scope, acknowledged);
  // The actual browser acknowledgement is now durable. Every network call runs outside its owner transaction.
  const persist = Effect.gen(function* persistChoice() {
    const noticeGateway = yield* acquireCustomerPrivacyGateway(scope);
    const provision = yield* executeRecordNoticeProvisionWithAuthorization(
      noticeProvisionRequest(receipt),
      Redacted.value(noticeGateway.credential),
      scope.requestCorrelation,
      { ...noticeGateway.options, idempotencyKey: `commerce-newsletter-provision:${receipt.requestId}` },
    ).pipe(Effect.mapError(consentUnavailable));
    if (provision.provisionId !== `commerce-notice:${receipt.requestId}`) {
      return yield* Effect.fail(consentUnavailable());
    }
    const payload: ConsentSelfServiceRequest = {
      decision: receipt.decision,
      noticeEvidenceRefs: [provision.provisionId],
      path: {
        credentialRef: receipt.sessionRef,
        kind: 'OPERATION_SCOPED',
        operation: receipt.decision === 'WITHDRAWN' ? 'CONSENT_WITHDRAW' : 'CONSENT_WRITE',
        operationRef: receipt.requestId,
        requestRef: receipt.requestId,
        scopeRef: receipt.scope.scopeRef,
        subjectRef: receipt.scope.privacySubjectRef,
      },
      scope: receipt.scope,
    };
    const gateway = yield* acquireCustomerPrivacyGateway(scope);
    yield* executeConsentSelfServiceWithAuthorization(
      payload,
      Redacted.value(gateway.credential),
      scope.requestCorrelation,
      { ...gateway.options, idempotencyKey: `commerce-newsletter-consent:${receipt.requestId}` },
    ).pipe(Effect.mapError(consentUnavailable));
    const state = yield* readCustomerNewsletterState(scope, catalog, notice.versionId);
    if (state.decision !== input.decision) {
      return yield* Effect.fail(consentConflict());
    }
    return state;
  });
  const result = yield* persist.pipe(
    Effect.tapError(() =>
      DateTime.nowAsDate.pipe(
        Effect.flatMap((occurredAt) =>
          audit.record({
            ...event,
            eventType: 'commerce.portal-auth.consent-failed.v1',
            occurredAt,
            outcome: 'unavailable',
          }),
        ),
        Effect.mapError(consentUnavailable),
      ),
    ),
  );
  yield* audit
    .record({
      ...event,
      eventType: 'commerce.portal-auth.consent-recorded.v1',
      occurredAt: yield* DateTime.nowAsDate,
      outcome: 'success',
    })
    .pipe(Effect.mapError(consentUnavailable));
  return result;
});

const authorityScope = Effect.fn('CustomerConsent.authorityScope')(function* authorityScope(
  request: HttpServerRequest.HttpServerRequest,
  entrypoint: ModuleEntrypointDescriptor,
) {
  yield* noStoreHeaders;
  const principal = yield* authenticateOperationPrincipal(Redacted.make(request.headers['authorization']), {
    authentication: consentAuthentication,
    unavailable: consentUnavailable,
  }).pipe(Effect.mapError(consentAuthentication));
  yield* authorize(principal, entrypoint);
  if (principal.legalEntityId === undefined || principal.authMethod !== 'api_key') {
    return yield* Effect.fail(consentForbidden());
  }
  return {
    compositionRevision: yield* activeRevision,
    legalEntityId: principal.legalEntityId,
    requestCorrelation: randomUUID(),
    tenantId: principal.tenantId,
  };
});
const verifiedReceipt = Effect.fn('CustomerConsent.verifyReceipt')(function* verifyReceipt(
  base: Omit<CustomerConsentScope, 'partyId'>,
  requestId: string,
) {
  if (!/^[a-f0-9-]{36}$/iu.test(requestId)) {
    return yield* Effect.fail(consentForbidden());
  }
  const found = yield* readCustomerConsentReceipt(base, requestId);
  if (Option.isNone(found)) {
    return yield* Effect.fail(consentForbidden());
  }
  const receipt = found.value;
  const lifecycle = yield* CommercePortalAuthSessionLifecycle;
  const evidence = yield* lifecycle
    .evidenceForSession({ expectedProviderSubjectId: receipt.providerSubjectId, sessionRef: receipt.sessionRef })
    .pipe(
      Effect.mapError((error) =>
        Match.value(error).pipe(
          Match.tag('CommercePortalAuthSessionUnavailable', consentUnavailable),
          Match.orElse(consentForbidden),
        ),
      ),
    );
  const runner = yield* CommerceEnrollmentOwnerTransactionRunner;
  const party = yield* runner
    .run(base, (transaction) => readRetailEnrollmentAccountParty(transaction, evidence.providerSubjectId))
    .pipe(Effect.mapError(consentUnavailable));
  if (Option.isNone(party) || party.value !== receipt.partyId) {
    return yield* Effect.fail(consentForbidden());
  }
  const scope = { ...base, partyId: party.value };
  const catalog = yield* readCustomerNewsletterCatalog(scope);
  if (
    !sameCustomerConsentScope(catalog.consentScope, receipt.scope) ||
    (yield* readCustomerPrivacySubject(scope, catalog.consentScope)) === undefined
  ) {
    return yield* Effect.fail(consentForbidden());
  }
  yield* readCustomerPartyProfile(scope).pipe(Effect.mapError(consentUnavailable));
  yield* readExactCustomerNotice(scope, catalog, receipt.noticeVersionId);
  return { catalog, evidence, receipt };
});
const resolve = Effect.fn('CustomerConsent.resolveAuthority')(function* resolveAuthority(
  request: HttpServerRequest.HttpServerRequest,
  payload: CommerceConsentAuthorityPayload,
) {
  const base = yield* authorityScope(request, customerConsentAuthorityEntrypoint);
  const { path } = payload.request;
  if (path.kind !== 'OPERATION_SCOPED' || path.credentialRef !== payload.credentialRef) {
    return yield* Effect.fail(consentForbidden());
  }
  const { catalog, evidence, receipt } = yield* verifiedReceipt(base, path.requestRef);
  const operation = receipt.decision === 'WITHDRAWN' ? 'CONSENT_WITHDRAW' : 'CONSENT_WRITE';
  if (!matchesCustomerConsentReceipt(payload.credentialRef, payload.request, receipt)) {
    return yield* Effect.fail(consentForbidden());
  }
  const fact: TrustedOperationConsentAuthorityFact = {
    actorPrincipalRef: { principalId: catalog.configured.actorPrincipalId, tenantId: base.tenantId },
    authorizedScope: receipt.scope,
    evidenceRefs: [receipt.requestId, evidence.sessionRef],
    expiresAt: evidence.expiresAt.toISOString(),
    kind: 'OPERATION_SCOPED',
    operation,
    operationRef: receipt.requestId,
    proofRef: evidence.sessionRef,
    scopeRef: receipt.scope.scopeRef,
    status: 'CURRENT',
    subjectRef: receipt.scope.privacySubjectRef,
    verifiedAt: evidence.observedAt.toISOString(),
  };
  return fact;
});
const noticePayloadEquivalent = Schema.toEquivalence(RecordNoticeProvisionPayloadSchema);
const resolveNotice = Effect.fn('CustomerConsent.resolveNoticeAuthority')(function* resolveNoticeAuthority(
  request: HttpServerRequest.HttpServerRequest,
  payload: RecordNoticeProvisionPayload,
) {
  const base = yield* authorityScope(request, customerConsentNoticeAuthorityEntrypoint);
  const { receipt } = yield* verifiedReceipt(base, payload.claimRef);
  if (!noticePayloadEquivalent(payload, noticeProvisionRequest(receipt))) {
    return yield* Effect.fail(consentForbidden());
  }
  const proof = {
    anonymousContextRef: null,
    authorityRef: 'commerce.customer-context.customer-consent-receipt',
    businessInteractionRef: receipt.requestId,
    channel: 'COMMERCE_PORTAL',
    controllerRef: receipt.scope.controllerRef,
    evidenceRef: receipt.requestId,
    noticeVersionRef: receipt.noticeVersionId,
    observedAt: DateTime.formatIso(receipt.acknowledgedAt),
    privacySubjectRef: receipt.scope.privacySubjectRef.resourceId,
    processingPurposeRef: receipt.scope.processingPurposeRef.resourceId,
    processingScopeRef: receipt.scope.scopeRef,
    proofKind: 'INTERACTIVE_ACKNOWLEDGEMENT' as const,
    providedLanguage: receipt.providedLanguage,
  };
  const fact: PrivacyNoticeAuthorityFact = {
    claimRef: receipt.requestId,
    provision: {
      actionRef: null,
      anonymousContextRef: null,
      businessInteractionRef: receipt.requestId,
      channel: proof.channel,
      channelProof: proof,
      controllerRef: proof.controllerRef,
      evidenceRef: receipt.requestId,
      failureReason: null,
      noticeVersionRef: proof.noticeVersionRef,
      outcome: 'PROVEN_PROVISION',
      privacySubjectRef: proof.privacySubjectRef,
      processingPurposeRef: proof.processingPurposeRef,
      processingScopeRef: proof.processingScopeRef,
      providedLanguage: proof.providedLanguage,
      provisionedAt: DateTime.formatIso(receipt.acknowledgedAt),
      provisionId: `commerce-notice:${receipt.requestId}`,
      supersedesProvisionRef: null,
    },
  };
  return fact;
});
const schemaErrorLive = HttpApiMiddleware.layerSchemaErrorTransform(CustomerOwnConsentSchemaError, () =>
  Effect.fail(consentInvalid()),
);
const authoritySchemaErrorLive = HttpApiMiddleware.layerSchemaErrorTransform(CommerceConsentAuthoritySchemaError, () =>
  Effect.fail(consentInvalid()),
);
const noticeSchemaErrorLive = HttpApiMiddleware.layerSchemaErrorTransform(CommerceConsentAuthoritySchemaError, () =>
  Effect.fail(consentInvalid()),
);
export const customerOwnConsentReadApiLive = HttpApiBuilder.group(
  commerceCustomerContextApi,
  'customerOwnConsentRead',
  (handlers) => handlers.handle('execute', ({ request }) => read(request)),
).pipe(Layer.provide(schemaErrorLive));
export const customerOwnConsentUpdateApiLive = HttpApiBuilder.group(
  commerceCustomerContextApi,
  'customerOwnConsentUpdate',
  (handlers) => handlers.handle('execute', ({ payload, request }) => update(request, payload)),
).pipe(Layer.provide(schemaErrorLive));
export const commerceConsentAuthorityApiLive = HttpApiBuilder.group(
  commerceCustomerContextApi,
  'commerceConsentAuthority',
  (handlers) =>
    handlers.handle('execute', ({ payload, request }) =>
      resolve(request, payload).pipe(Effect.mapError((p) => (p.status === 409 ? consentForbidden() : p))),
    ),
).pipe(Layer.provide(authoritySchemaErrorLive));
export const commerceConsentNoticeAuthorityApiLive = HttpApiBuilder.group(
  commerceCustomerContextApi,
  'commerceConsentNoticeAuthority',
  (handlers) =>
    handlers.handle('execute', ({ payload, request }) =>
      resolveNotice(request, payload).pipe(Effect.mapError((p) => (p.status === 409 ? consentForbidden() : p))),
    ),
).pipe(Layer.provide(noticeSchemaErrorLive));
