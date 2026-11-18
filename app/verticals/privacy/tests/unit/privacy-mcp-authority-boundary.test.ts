import { ConsentSelfServiceRequestSchema, RecordNoticeProvisionPayloadSchema } from '@app/consent-authority-contracts';
import { OntosMcpHidden } from '@app/core-runtime/modules/mcp-contribution';
import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { ConsentSelfServiceAuthorizationError } from '../../shared/domain/privacy-consent-self-service.ts';
import { privacyMcpContribution } from '../../shared/mcp/contribution.ts';
import {
  CommerceConsentAuthorityLookup,
  preparedCommerceConsentExecution,
} from '../../src/actions/commerce-consent-authority.ts';
import { privacyManifest } from '../../vertical.manifest.ts';

const tenantId = '00000000-0000-4000-8000-000000000001';
const principalId = '00000000-0000-4000-8000-000000000002';
const legalEntityId = '00000000-0000-4000-8000-000000000003';
const subjectRef = {
  moduleId: 'privacy.core',
  resourceId: 'retail-party:one',
  resourceType: 'privacy.core.privacy-subject',
  tenantId,
};
const consentRequest = Schema.decodeUnknownSync(ConsentSelfServiceRequestSchema)({
  decision: 'GRANTED',
  noticeEvidenceRefs: ['notice-provision:one'],
  path: {
    credentialRef: 'session:one',
    kind: 'OPERATION_SCOPED',
    operation: 'CONSENT_WRITE',
    operationRef: 'request:one',
    requestRef: 'request:one',
    scopeRef: 'scope:one',
    subjectRef,
  },
  scope: {
    controllerRef: legalEntityId,
    materialDimensions: [{ kind: 'COMMUNICATION_CHANNEL', value: 'EMAIL' }],
    privacySubjectRef: subjectRef,
    processingPurposeRef: {
      moduleId: 'privacy.core',
      resourceId: 'purpose:one',
      resourceType: 'privacy.core.processing-purpose',
      tenantId,
    },
    purposeMeaning: 'Volitelné obchodní zprávy e-mailem',
    purposeVersionRef: 'purpose-version:one',
    scopeRef: 'scope:one',
  },
});
const noticeRequest = Schema.decodeUnknownSync(RecordNoticeProvisionPayloadSchema)({
  actionRef: 'commerce:account-marketing',
  anonymousContextRef: null,
  businessInteractionRef: 'interaction:one',
  channel: 'EMAIL',
  claimRef: 'receipt:one',
  controllerRef: legalEntityId,
  noticeVersionRef: 'notice-version:one',
  privacySubjectRef: 'retail-party:one',
  processingPurposeRef: 'purpose:one',
  processingScopeRef: 'scope:one',
  providedLanguage: 'cs',
});
const ownerUnreached = () =>
  Effect.fail(
    new ConsentSelfServiceAuthorizationError({
      code: 'AUTHORITY_UNAVAILABLE',
      reason: 'No owner read belongs to this unprepared invocation',
    }),
  );

it('the deployed catalog exposes both consent tools because their authorities are installed', () => {
  expect(privacyMcpContribution.actions['consent-self-service']).not.toBe(OntosMcpHidden);
  expect(privacyMcpContribution.actions['record-notice-provision']).not.toBe(OntosMcpHidden);
  expect(privacyManifest.publicSurface.mcp).toEqual(privacyMcpContribution);
});

// The production Action runtime (api/consent-aware-action-runtime.ts) installs this per-invocation execution as the
// ConsentSelfServiceAuthority and NoticeChannelDeliveryAuthority of every Privacy Action it runs. Both answer from
// invocation-prepared owner evidence: an unprepared invocation is refused as missing evidence, not as an authority
// that is not configured.
it.effect('the production Action runtime supplies both consent authorities instead of the unavailable ones', () =>
  Effect.gen(function* installedConsentAuthorities() {
    const execution = yield* preparedCommerceConsentExecution.pipe(
      Effect.provideService(CommerceConsentAuthorityLookup, { resolve: ownerUnreached, resolveNotice: ownerUnreached }),
    );
    const consent = yield* execution.authority.ports
      .verifyOperationCredential({
        credentialRef: 'session:one',
        now: '2026-11-18T12:00:00.000Z',
        request: consentRequest,
      })
      .pipe(Effect.flip);
    expect(consent).toMatchObject({ code: 'MISSING_AUTHORITY' });
    const notice = yield* execution.noticeAuthority
      .resolve(noticeRequest, { actionInvocationId: 'invocation:one', legalEntityId, principalId, tenantId })
      .pipe(Effect.flip);
    expect(notice).toMatchObject({ reason: 'No matching invocation-scoped Commerce notice authority is prepared' });
  }).pipe(Effect.scoped),
);
