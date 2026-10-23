import { PrivacySubjectSchema } from '@app/privacy/domain/privacy-subject';
import { Config, DateTime, Effect, Redacted, Schema } from 'effect';
import type { ConsentScope } from '@app/consent-authority-contracts';
import {
  executeCreateNoticeVersionWithAuthorization,
  executeCreatePrivacySubjectWithAuthorization,
  executeCurrentConsentWithAuthorization,
  executeNoticeVersionsWithAuthorization,
  executePrivacySubjectsWithAuthorization,
  executeProcessingPurposesWithAuthorization,
} from '@app/privacy/api/client';
import { CustomerOwnConsentSchema } from '../../../shared/portal-auth/consent-api.ts';
import { acquireCustomerPrivacyGateway } from './privacy-gateway.ts';
import type { CustomerConsentScope } from './privacy-gateway.ts';
import { customerNewsletterScope, sameCustomerConsentScope } from './model.ts';
import { consentConflict, consentUnavailable } from './problems.ts';

const configuration = Config.all({
  actorPrincipalId: Config.String('COMMERCE_MARKETING_ACTOR_PRINCIPAL_ID'),
  controllerRef: Config.String('COMMERCE_MARKETING_CONTROLLER_REF'),
  noticeId: Config.String('COMMERCE_MARKETING_NOTICE_ID'),
  noticeVersionId: Config.String('COMMERCE_MARKETING_NOTICE_VERSION_ID'),
  purposeId: Config.String('COMMERCE_MARKETING_PURPOSE_ID'),
  purposeVersionId: Config.String('COMMERCE_MARKETING_PURPOSE_VERSION_ID'),
});
const readNewsletterPurpose = Effect.fn('CustomerConsent.readPurpose')(function* readPurpose(
  scope: CustomerConsentScope,
  configured: { actorPrincipalId: string; purposeId: string; purposeVersionId: string },
  now: string,
) {
  const gateway = yield* acquireCustomerPrivacyGateway(scope);
  if (gateway.principalId !== configured.actorPrincipalId) {
    return yield* Effect.fail(consentUnavailable());
  }
  const purposes = yield* executeProcessingPurposesWithAuthorization(
    {
      at: now,
      includeRetired: false,
      purposeRefs: [
        {
          moduleId: 'privacy.core',
          resourceId: configured.purposeId,
          resourceType: 'privacy.core.processing-purpose',
          tenantId: scope.tenantId,
        },
      ],
    },
    Redacted.value(gateway.credential),
    scope.requestCorrelation,
    gateway.options,
  ).pipe(Effect.mapError(consentUnavailable));
  const [item] = purposes.items;
  if (purposes.items.length !== 1 || purposes.missingRefs.length !== 0 || item === undefined) {
    return yield* Effect.fail(consentUnavailable());
  }
  if (
    item.purpose.purposeRef.tenantId !== scope.tenantId ||
    item.purpose.purposeRef.resourceId !== configured.purposeId ||
    item.purpose.legalEntityId !== scope.legalEntityId ||
    item.purpose.lifecycle !== 'ACTIVE' ||
    item.effectiveVersion === null ||
    item.effectiveVersion.versionId !== configured.purposeVersionId ||
    item.effectiveVersion.requiredConsentDimensions?.length !== 1 ||
    item.effectiveVersion.requiredConsentDimensions[0] !== 'COMMUNICATION_CHANNEL'
  ) {
    return yield* Effect.fail(consentUnavailable());
  }
  return item.effectiveVersion;
});

export const readCustomerNewsletterCatalog = Effect.fn('CustomerConsent.readCatalog')(function* readCatalog(
  scope: CustomerConsentScope,
) {
  const configured = yield* configuration.pipe(Effect.mapError(consentUnavailable));
  if (configured.controllerRef !== scope.legalEntityId) {
    return yield* Effect.fail(consentUnavailable());
  }
  const now = DateTime.formatIso(yield* DateTime.now);
  const purposeVersion = yield* readNewsletterPurpose(scope, configured, now);
  const noticeGateway = yield* acquireCustomerPrivacyGateway(scope);
  const notices = yield* executeNoticeVersionsWithAuthorization(
    { asOf: now, languages: ['cs'], noticeRefs: [configured.noticeId] },
    Redacted.value(noticeGateway.credential),
    scope.requestCorrelation,
    noticeGateway.options,
  ).pipe(Effect.mapError(consentUnavailable));
  const templates = notices.items.filter((notice) => notice.versionId === configured.noticeVersionId);
  const [template] = templates;
  if (
    templates.length !== 1 ||
    template === undefined ||
    template.noticeRef.tenantId !== scope.tenantId ||
    template.noticeRef.resourceId !== configured.noticeId ||
    template.wording === null ||
    template.wording.trim().length === 0
  ) {
    return yield* Effect.fail(consentUnavailable());
  }
  const fact = (dimension: string, value: string) =>
    template.applicableScope.facts.some((f) => f.dimension === dimension && f.value === value);
  if (
    !fact('CONTROLLER_SCOPE', configured.controllerRef) ||
    !fact('PROCESSING_PURPOSE', configured.purposeId) ||
    !fact('PROCESSING_PURPOSE_VERSION', configured.purposeVersionId) ||
    !fact('CHANNEL', 'EMAIL')
  ) {
    return yield* Effect.fail(consentUnavailable());
  }
  const consentScope = customerNewsletterScope({
    controllerRef: configured.controllerRef,
    partyId: scope.partyId,
    purposeId: configured.purposeId,
    purposeMeaning: purposeVersion.meaning,
    purposeVersionId: configured.purposeVersionId,
    tenantId: scope.tenantId,
  });
  return { configured, consentScope, template };
});
export type CustomerNewsletterCatalog = Effect.Success<ReturnType<typeof readCustomerNewsletterCatalog>>;

export const readCustomerPrivacySubject = Effect.fn('CustomerConsent.readSubject')(function* readSubject(
  scope: CustomerConsentScope,
  consentScope: ConsentScope,
) {
  const gateway = yield* acquireCustomerPrivacyGateway(scope);
  const result = yield* executePrivacySubjectsWithAuthorization(
    { subjectRefs: [consentScope.privacySubjectRef] },
    Redacted.value(gateway.credential),
    scope.requestCorrelation,
    gateway.options,
  ).pipe(Effect.mapError(consentUnavailable));
  const [subject] = result.items;
  if (
    result.items.length > 1 ||
    (subject !== undefined &&
      (subject.subjectRef.resourceId !== consentScope.privacySubjectRef.resourceId ||
        subject.subjectRef.tenantId !== scope.tenantId ||
        subject.subject.kind !== 'DATA_SUBJECT' ||
        subject.subject.partyRef.tenantId !== scope.tenantId ||
        subject.subject.partyRef.resourceId !== scope.partyId))
  ) {
    return yield* Effect.fail(consentConflict());
  }
  return subject;
});
export const prepareCustomerNewsletterNotice = Effect.fn('CustomerConsent.prepareNotice')(function* prepareNotice(
  scope: CustomerConsentScope,
  catalog: CustomerNewsletterCatalog,
) {
  if ((yield* readCustomerPrivacySubject(scope, catalog.consentScope)) === undefined) {
    const gateway = yield* acquireCustomerPrivacyGateway(scope);
    const subject = yield* Schema.decodeEffect(PrivacySubjectSchema)({
      kind: 'DATA_SUBJECT',
      partyRef: {
        moduleId: 'party.registry',
        resourceId: scope.partyId,
        resourceType: 'party.registry.party',
        tenantId: scope.tenantId,
      },
    }).pipe(Effect.mapError(consentUnavailable));
    yield* executeCreatePrivacySubjectWithAuthorization(
      {
        subject,
        subjectRef: catalog.consentScope.privacySubjectRef,
      },
      Redacted.value(gateway.credential),
      scope.requestCorrelation,
      { ...gateway.options, idempotencyKey: `commerce-newsletter-subject:${scope.partyId}` },
    ).pipe(Effect.mapError(consentUnavailable));
    if ((yield* readCustomerPrivacySubject(scope, catalog.consentScope)) === undefined) {
      return yield* Effect.fail(consentUnavailable());
    }
  }
  const { consentScope, template } = catalog;
  const gateway = yield* acquireCustomerPrivacyGateway(scope);
  // Caller supplies a real notice collection identity; only the native owner creates/returns the immutable version.
  return yield* executeCreateNoticeVersionWithAuthorization(
    {
      input: {
        applicableScope: {
          facts: [
            { dimension: 'PRIVACY_SUBJECT', value: consentScope.privacySubjectRef.resourceId },
            { dimension: 'CONTROLLER_SCOPE', value: consentScope.controllerRef },
            { dimension: 'PROCESSING_PURPOSE', value: consentScope.processingPurposeRef.resourceId },
            { dimension: 'PROCESSING_PURPOSE_VERSION', value: consentScope.purposeVersionRef },
            { dimension: 'CHANNEL', value: 'EMAIL' },
          ],
          operation: 'NEWSLETTER_CONSENT',
          processingScopeRef: { scopeId: consentScope.scopeRef, scopeType: 'privacy.processing-scope' },
        },
        contentIdentity: template.contentIdentity,
        effectiveFrom: template.effectiveFrom,
        evidenceArtifactRef: template.evidenceArtifactRef,
        language: template.language,
        wording: template.wording,
      },
      noticeId: scope.partyId,
    },
    Redacted.value(gateway.credential),
    scope.requestCorrelation,
    {
      ...gateway.options,
      idempotencyKey: `commerce-newsletter-notice:${scope.partyId}:${template.versionId}`,
    },
  ).pipe(Effect.mapError(consentUnavailable));
});

export const readExactCustomerNotice = Effect.fn('CustomerConsent.readExactNotice')(function* readNotice(
  scope: CustomerConsentScope,
  catalog: CustomerNewsletterCatalog,
  versionId: string,
) {
  const gateway = yield* acquireCustomerPrivacyGateway(scope);
  const result = yield* executeNoticeVersionsWithAuthorization(
    { asOf: DateTime.formatIso(yield* DateTime.now), languages: ['cs'], noticeRefs: [scope.partyId] },
    Redacted.value(gateway.credential),
    scope.requestCorrelation,
    gateway.options,
  ).pipe(Effect.mapError(consentUnavailable));
  const matches = result.items.filter((n) => n.versionId === versionId);
  const [notice] = matches;
  const { consentScope, template } = catalog;
  const expectedFacts = [
    ['PRIVACY_SUBJECT', consentScope.privacySubjectRef.resourceId],
    ['CONTROLLER_SCOPE', consentScope.controllerRef],
    ['PROCESSING_PURPOSE', consentScope.processingPurposeRef.resourceId],
    ['PROCESSING_PURPOSE_VERSION', consentScope.purposeVersionRef],
    ['CHANNEL', 'EMAIL'],
  ];
  if (
    matches.length !== 1 ||
    notice === undefined ||
    notice.noticeRef.tenantId !== scope.tenantId ||
    notice.noticeRef.resourceId !== scope.partyId ||
    notice.wording !== template.wording ||
    notice.contentIdentity !== template.contentIdentity ||
    notice.language !== template.language ||
    notice.applicableScope.processingScopeRef.scopeId !== consentScope.scopeRef ||
    expectedFacts.some(
      ([dimension, value]) => !notice.applicableScope.facts.some((f) => f.dimension === dimension && f.value === value),
    )
  ) {
    return yield* Effect.fail(consentConflict());
  }
  return notice;
});
export const readCustomerNewsletterState = Effect.fn('CustomerConsent.readCurrent')(function* readCurrent(
  scope: CustomerConsentScope,
  catalog: CustomerNewsletterCatalog,
  noticeVersionId: string,
) {
  const notice = yield* readExactCustomerNotice(scope, catalog, noticeVersionId);
  const gateway = yield* acquireCustomerPrivacyGateway(scope);
  const result = yield* executeCurrentConsentWithAuthorization(
    { scopeRefs: [catalog.consentScope.scopeRef] },
    Redacted.value(gateway.credential),
    scope.requestCorrelation,
    gateway.options,
  ).pipe(Effect.mapError(consentUnavailable));
  const [item] = result.items;
  if (
    result.items.length !== 1 ||
    item === undefined ||
    item.scopeRef !== catalog.consentScope.scopeRef ||
    item.resolution.outcome === 'CONFLICT'
  ) {
    return yield* Effect.fail(consentConflict());
  }
  if (
    item.resolution.outcome === 'CURRENT' &&
    !sameCustomerConsentScope(item.resolution.decision.scope, catalog.consentScope)
  ) {
    return yield* Effect.fail(consentConflict());
  }
  return yield* Schema.decodeEffect(CustomerOwnConsentSchema)({
    decision: item.resolution.outcome === 'ABSENT' ? ('ABSENT' as const) : item.resolution.decision.decision,
    notice: {
      language: notice.language,
      noticeVersionId: notice.versionId,
      purposeVersionId: catalog.consentScope.purposeVersionRef,
      wording: notice.wording ?? '',
    },
  }).pipe(Effect.mapError(consentUnavailable));
});
