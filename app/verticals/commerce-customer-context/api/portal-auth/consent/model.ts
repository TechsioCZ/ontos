import { ConsentScopeSchema } from '@app/consent-authority-contracts';
import type {
  ConsentScope,
  ConsentSelfServiceRequest,
  RecordNoticeProvisionPayload,
} from '@app/consent-authority-contracts';
import { Schema } from 'effect';

import {
  CustomerConsentRequestIdSchema,
  CustomerNoticeVersionIdSchema,
} from '../../../shared/portal-auth/consent-api.ts';
import { EnrollmentResourceIdSchema } from '../../../shared/enrollment-contracts.ts';
import { CommercePortalAuthProviderSubjectIdSchema } from '../session/contracts.ts';

export const CustomerConsentReceiptSchema = Schema.Struct({
  acknowledgedAt: Schema.DateTimeUtcFromString,
  decision: Schema.Literals(['GRANTED', 'WITHDRAWN']),
  noticeVersionId: CustomerNoticeVersionIdSchema,
  partyId: EnrollmentResourceIdSchema,
  providedLanguage: Schema.String,
  providerSubjectId: CommercePortalAuthProviderSubjectIdSchema,
  requestId: CustomerConsentRequestIdSchema,
  scope: ConsentScopeSchema,
  sessionRef: Schema.String,
});
export type CustomerConsentReceipt = typeof CustomerConsentReceiptSchema.Type;

export const customerNewsletterScope = (input: {
  controllerRef: string;
  partyId: string;
  purposeId: string;
  purposeMeaning: string;
  purposeVersionId: string;
  tenantId: string;
}): ConsentScope => ({
  controllerRef: input.controllerRef,
  materialDimensions: [{ kind: 'COMMUNICATION_CHANNEL', value: 'EMAIL' }],
  privacySubjectRef: {
    moduleId: 'privacy.core',
    resourceId: `retail-party:${input.partyId}`,
    resourceType: 'privacy.core.privacy-subject',
    tenantId: input.tenantId,
  },
  processingPurposeRef: {
    moduleId: 'privacy.core',
    resourceId: input.purposeId,
    resourceType: 'privacy.core.processing-purpose',
    tenantId: input.tenantId,
  },
  purposeMeaning: input.purposeMeaning,
  purposeVersionRef: input.purposeVersionId,
  // A stable business scope: presentation/version changes do not silently re-enable a withdrawn choice.
  scopeRef: `retail-email:${input.controllerRef}:${input.partyId}:${input.purposeId}`,
});
export const sameCustomerConsentScope = Schema.toEquivalence(ConsentScopeSchema);

/** Fresh lifecycle and Party admission are checked separately; this binds every invocation field to its durable receipt. */
export const matchesCustomerConsentReceipt = (
  credentialRef: string,
  request: ConsentSelfServiceRequest,
  receipt: CustomerConsentReceipt,
): boolean => {
  const { path } = request;
  const subject = receipt.scope.privacySubjectRef;
  return (
    path.kind === 'OPERATION_SCOPED' &&
    credentialRef === receipt.sessionRef &&
    path.credentialRef === receipt.sessionRef &&
    path.requestRef === receipt.requestId &&
    path.operationRef === receipt.requestId &&
    path.scopeRef === receipt.scope.scopeRef &&
    path.operation === (receipt.decision === 'WITHDRAWN' ? 'CONSENT_WITHDRAW' : 'CONSENT_WRITE') &&
    path.subjectRef.moduleId === subject.moduleId &&
    path.subjectRef.resourceType === subject.resourceType &&
    path.subjectRef.resourceId === subject.resourceId &&
    path.subjectRef.tenantId === subject.tenantId &&
    request.decision === receipt.decision &&
    sameCustomerConsentScope(request.scope, receipt.scope) &&
    request.noticeEvidenceRefs.length === 1 &&
    request.noticeEvidenceRefs[0] === `commerce-notice:${receipt.requestId}`
  );
};

export const noticeProvisionRequest = (receipt: CustomerConsentReceipt): RecordNoticeProvisionPayload => ({
  actionRef: null,
  anonymousContextRef: null,
  businessInteractionRef: receipt.requestId,
  channel: 'COMMERCE_PORTAL',
  claimRef: receipt.requestId,
  controllerRef: receipt.scope.controllerRef,
  noticeVersionRef: receipt.noticeVersionId,
  privacySubjectRef: receipt.scope.privacySubjectRef.resourceId,
  processingPurposeRef: receipt.scope.processingPurposeRef.resourceId,
  processingScopeRef: receipt.scope.scopeRef,
  providedLanguage: receipt.providedLanguage,
});
