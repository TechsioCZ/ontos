import { mapAcknowledgePrivacyNoticeActionProblem } from '../../api/acknowledge-privacy-notice-action-problems.ts';
import {
  AcknowledgePrivacyNoticeActionForbiddenProblemSchema,
  AcknowledgePrivacyNoticeActionIneligibleProblemSchema,
  AcknowledgePrivacyNoticeActionUnavailableProblemSchema,
} from '../../shared/apis/acknowledge-privacy-notice-action.ts';
import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import type { DataAccessEventInput, OperationalScope } from '@app/core-runtime';
import { authenticationNamespaceRegistryLayer } from '@app/core-runtime/auth/external-identity-admission';
import { AuthenticationNamespaceRegistrationSchema } from '@app/core-runtime/auth/external-identity-contracts';
import { bindActionTestServices, makeActionTestHarness } from '@app/core-runtime/testing/actions';
import { COMMERCE_AUTHENTICATION_NAMESPACE_ID } from '@app/commerce-customer-context/portal-auth/contracts';
import { NodeCrypto } from '@effect/platform-node';
import { Crypto, DateTime, Effect, Layer, Option, Redacted, Result, Schema } from 'effect';
import { TestClock } from 'effect/testing';
import { expect, it } from 'effect-rstest';
import { base64url } from 'jose';

import { acknowledgePrivacyNoticeAction } from '../../src/actions/acknowledge-privacy-notice.action.ts';
import {
  NoticeChannelDeliveryAuthority,
  recordNoticeProvisionAction,
} from '../../src/actions/record-notice-provision.action.ts';
import { makeInMemoryNoticeProvisionRepository } from '../../src/persistence/notice-provision-repository.ts';
import { materializePrivacyNoticeProvision } from '../../shared/domain/privacy-notice-provision.ts';
import { RecordNoticeProvisionPayloadSchema } from '../../shared/actions/record-notice-provision.ts';
import { PrivacyNoticeVersionSchema } from '../../shared/domain/privacy-notice-version.ts';
import type { PrivacyNoticeVersion } from '../../shared/domain/privacy-notice-version.ts';
import type { NoticePresentationRequest } from '../../shared/apis/notice-presentation.ts';
import {
  PrivacyNoticeAcknowledgementError,
  privacyNoticePresentationBindingFields,
} from '../../shared/resources/privacy-notice-acknowledgement.ts';
import type { PrivacyNoticeAcknowledgement } from '../../shared/resources/privacy-notice-acknowledgement.ts';
import {
  NoticeChannelDeliveryAuthorityForAcknowledgementsLive,
  privacyNoticeAcknowledgementChannel,
  makePrivacyNoticeInformationStep,
  privacyNoticeInformationStepLive,
  acknowledgePreparedNotice,
} from '../../src/services/privacy-notice-acknowledgement-authority.service.ts';
import {
  CommerceCustomerContextNoticeSubjectAuthorityService,
  observeNoticeSubjectPreparation,
} from '../../src/integrations/commerce-customer-context/commerce-customer-context-notice-subject-authority.service.ts';
import type { PreparedNoticeSubjectAuthority } from '../../src/integrations/commerce-customer-context/commerce-customer-context-notice-subject-authority.service.ts';
import { PrivacySubjectRecordSchema, PrivacySubjectOwnerEvidenceSchema } from '../../shared/domain/privacy-subject.ts';
import {
  PrivacyNoticePresentationService,
  makePrivacyNoticePresentationService,
  resolveNoticePresentationScope,
} from '../../src/services/privacy-notice-presentation.service.ts';
import type { NoticeAcknowledgementRepository } from '../../src/persistence/notice-provision-postgres-repository.ts';

const now = '2026-10-20T12:00:00.000Z';
const tenantId = '10000000-0000-4000-8000-000000000001';
const scope: OperationalScope = {
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authBindingId: '10000000-0000-4000-8000-000000000003',
    authContextRef: 'actual-unit-session',
    authenticationNamespaceId: COMMERCE_AUTHENTICATION_NAMESPACE_ID,
    authMethod: 'session',
    legalEntityId: '10000000-0000-4000-8000-000000000004',
    principalId: '10000000-0000-4000-8000-000000000002',
    tenantId,
  }),
  correlationId: 'notice-unit',
};
const target: NoticePresentationRequest = {
  businessInteractionRef: 'unit-information-step',
  noticeVersionId: '10000000-0000-4000-8000-000000000005',
  privacySubjectRef: {
    moduleId: 'privacy.core',
    resourceId: '10000000-0000-4000-8000-000000000006',
    resourceType: 'privacy.core.privacy-subject',
    tenantId,
  },
  retailProfileId: 'profile:opaque-owner-id',
};
const notice = Schema.decodeUnknownSync(PrivacyNoticeVersionSchema)({
  applicableScope: {
    facts: [
      { dimension: 'PRIVACY_SUBJECT', value: target.privacySubjectRef.resourceId },
      { dimension: 'CONTROLLER_SCOPE', value: 'controller:unit' },
      { dimension: 'PROCESSING_PURPOSE', value: 'purpose:unit' },
      { dimension: 'PROCESSING_PURPOSE_VERSION', value: '10000000-0000-4000-8000-000000000007' },
    ],
    operation: 'CONSENT_DECISION',
    processingScopeRef: { scopeId: 'scope:unit', scopeType: 'privacy.processing-scope' },
  },
  contentIdentity: 'notice:immutable-wording:v1',
  effectiveFrom: '2026-10-20T11:00:00.000Z',
  effectiveTo: null,
  evidenceArtifactRef: null,
  language: 'en',
  noticeRef: {
    moduleId: 'privacy.core',
    resourceId: 'notice:unit',
    resourceType: 'privacy.core.privacy-notice-version',
    tenantId,
  },
  recordedAt: '2026-10-20T11:00:00.000Z',
  versionId: target.noticeVersionId,
  versionNumber: 1,
  wording: 'The exact immutable information supplied by the Notice owner.',
});
const invocationId = '10000000-0000-4000-8000-000000000008';
const otherInvocationId = '10000000-0000-4000-8000-000000000009';
const sameBinding = Schema.toEquivalence(Schema.Struct(privacyNoticePresentationBindingFields));
const noticeUnitNamespaceLive = authenticationNamespaceRegistryLayer(
  Schema.decodeEffect(AuthenticationNamespaceRegistrationSchema)({
    allowedAudiences: ['privacy'],
    authenticationNamespaceId: COMMERCE_AUTHENTICATION_NAMESPACE_ID,
    provider: 'commerce-portal-better-auth',
    requiresOperationAdmission: false,
    reservationPrincipalKind: 'human',
    subjectTypes: ['user'],
    trustedAttesterPrincipalIds: [],
  }).pipe(Effect.map((registration) => [registration])),
);

/** Explicit owner-local unit ports; these are not public account/channel acceptance evidence. */
const fixture = Effect.fn('NoticeUnit.fixture')(function* fixture(selectedNotice: PrivacyNoticeVersion = notice) {
  yield* TestClock.setTime(Date.parse(now));
  const crypto = yield* Crypto.Crypto;
  const integrity = yield* makePrivacyNoticePresentationService({
    keyId: 'unit-channel-only',
    signingKey: Redacted.make(base64url.encode(new Uint8Array(32).fill(29))),
  });
  const records = new Map<string, PrivacyNoticeAcknowledgement>();
  let authorityCalls = 0;
  const acknowledgementReads: DataAccessEventInput[] = [];
  const dependencies = {
    crypto,
    integrity,
    repository: { listNoticeVersions: () => Effect.succeed([selectedNotice]), listSubjects: () => Effect.succeed([]) },
    subjectAuthority: {
      resolve: () =>
        Effect.sync(() => {
          authorityCalls += 1;
          return { evidenceRefs: ['unit:owner-evidence'] };
        }),
    },
  };
  const acknowledgements: NoticeAcknowledgementRepository = {
    findById: (id) =>
      Effect.succeed(Option.fromNullishOr([...records.values()].find((record) => record.acknowledgementId === id))),
    findByPresentation: (id) => Effect.succeed(Option.fromNullishOr(records.get(id))),
    readEvidence: () => [...acknowledgementReads],
    record: (record) =>
      Effect.suspend(() => {
        const retained = records.get(record.presentationId);
        if (retained !== undefined) {
          acknowledgementReads.push({
            accessKind: 'read',
            queryHash: 'privacy.notice-acknowledgement.by-presentation.v1',
            resultCount: 1,
            servingModuleKey: 'privacy.core',
          });
        }
        if (retained !== undefined && !sameBinding(retained, record)) {
          return Effect.fail(
            new PrivacyNoticeAcknowledgementError({
              code: 'privacy_notice_acknowledgement_conflict',
              reason: 'Unit immutable binding conflict',
            }),
          );
        }
        if (retained !== undefined) {
          return Effect.succeed(retained);
        }
        records.set(record.presentationId, record);
        return Effect.succeed(record);
      }),
  };
  return { acknowledgements, authorityCalls: () => authorityCalls, dependencies, records };
});

const operations = Effect.fn('NoticeUnit.operations')(function* unitOperations(
  unit: Effect.Success<ReturnType<typeof fixture>>,
  selectedScope: OperationalScope = scope,
  dependencies = unit.dependencies,
  acknowledgements = unit.acknowledgements,
  preparedSubject?: PreparedNoticeSubjectAuthority,
) {
  const informationStep = yield* makePrivacyNoticeInformationStep.pipe(
    Effect.provideService(PrivacyNoticePresentationService, dependencies.integrity),
    Effect.provideService(CommerceCustomerContextNoticeSubjectAuthorityService, {
      forScope: () => dependencies.subjectAuthority,
    }),
  );
  return informationStep.forScope({
    acknowledgements,
    preparedSubject,
    repository: dependencies.repository,
    scope: selectedScope,
  });
});

it.effect('retains both preparation and commit Subject observations without repeating remote authority', () =>
  Effect.gen(function* preparedReadEvidence() {
    const unit = yield* fixture();
    const presented = yield* (yield* operations(unit)).present(target);
    const retainedSubject = Schema.decodeUnknownSync(PrivacySubjectRecordSchema)({
      createdAt: now,
      subject: {
        kind: 'DATA_SUBJECT',
        partyRef: {
          moduleId: 'party.registry',
          resourceId: '20000000-0000-4000-8000-000000000001',
          resourceType: 'party.registry.party',
          tenantId,
        },
      },
      subjectRef: target.privacySubjectRef,
      updatedAt: now,
    });
    const partyEvidence = Schema.decodeUnknownSync(PrivacySubjectOwnerEvidenceSchema)({
      observedAt: now,
      ownerRevision: 1,
      partyRef: retainedSubject.subject.kind === 'DATA_SUBJECT' ? retainedSubject.subject.partyRef : null,
      typeAssertions: [{ assertionId: 'unit:prepared-person', validFrom: now, validTo: '2026-10-20T12:00:30.000Z' }],
    });
    let subjectReads = 0;
    let remoteCalls = 0;
    const dependencies = {
      ...unit.dependencies,
      repository: {
        ...unit.dependencies.repository,
        listSubjects: () =>
          Effect.sync(() => {
            subjectReads += 1;
            return [retainedSubject];
          }),
      },
    };
    const records = yield* dependencies.repository.listSubjects();
    const preparationRead: DataAccessEventInput = {
      accessKind: 'list',
      queryHash: 'privacy.subject.for-scope.v1',
      resultCount: records.length,
      servingModuleKey: 'privacy.core',
    };
    const compositionRevision = 'a'.repeat(64);
    const subject = yield* observeNoticeSubjectPreparation(
      { compositionRevision, records, scope, target },
      {
        forScope: () => ({
          resolve: () =>
            Effect.sync(() => {
              remoteCalls += 1;
              return { evidenceRefs: ['unit:prepared-owner'], partyEvidence };
            }),
        }),
      },
    );
    const services = yield* operations(unit, scope, dependencies, unit.acknowledgements, subject);
    const payload = { acknowledged: true as const, presentationReceipt: presented.presentationReceipt };
    const acknowledge = acknowledgePreparedNotice(
      {
        context: { actionInvocationId: invocationId, compositionRevision, scope },
        payload,
        readEvidence: [preparationRead],
        subject,
      },
      services,
    );
    expect(remoteCalls).toBe(1);
    const result = yield* acknowledge(payload, invocationId);
    expect(result.readEvidence).toEqual([
      preparationRead,
      preparationRead,
      {
        accessKind: 'list',
        queryHash: 'privacy.notice-version.for-scope.v1',
        resultCount: 1,
        servingModuleKey: 'privacy.core',
      },
    ]);
    expect(subjectReads).toBe(2);
    expect(remoteCalls).toBe(1);
    expect(unit.authorityCalls()).toBe(1);
    expect(unit.records.size).toBe(1);
    expect(Result.isFailure(yield* acknowledge(payload, otherInvocationId).pipe(Effect.result))).toBe(true);
    expect(subjectReads).toBe(2);
    expect(remoteCalls).toBe(1);
    expect(unit.records.size).toBe(1);
  }).pipe(Effect.provide(NodeCrypto.layer)),
);

it.effect('serves exact immutable wording without proof and retains one acknowledgement on a fresh invocation', () =>
  Effect.gen(function* exactInformationStep() {
    const unit = yield* fixture();
    const presentation = yield* (yield* operations(unit, scope, unit.dependencies)).present(target);
    expect(presentation.notice).toEqual(notice);
    expect(unit.records.size).toBe(0);
    const payload = { acknowledged: true as const, presentationReceipt: presentation.presentationReceipt };
    const { acknowledge } = yield* operations(unit, scope);
    const first = yield* acknowledge(payload, invocationId);
    yield* TestClock.adjust(1);
    const second = yield* acknowledge(payload, otherInvocationId);
    expect(second.acknowledgementRef).toEqual(first.acknowledgementRef);
    expect(second.acknowledgedAt).toBe(first.acknowledgedAt);
    expect(first.readEvidence).toEqual([
      {
        accessKind: 'list',
        queryHash: 'privacy.notice-version.for-scope.v1',
        resultCount: 1,
        servingModuleKey: 'privacy.core',
      },
    ]);
    expect(second.readEvidence).toEqual([
      ...first.readEvidence,
      {
        accessKind: 'read',
        queryHash: 'privacy.notice-acknowledgement.by-presentation.v1',
        resultCount: 1,
        servingModuleKey: 'privacy.core',
      },
    ]);
    expect(unit.records.size).toBe(1);
    expect(unit.authorityCalls()).toBe(3);
    const [retained] = [...unit.records.values()];
    expect(retained?.actionInvocationId).toBe(invocationId);
    expect(retained?.recordedAt).toBe(now);
    expect(JSON.stringify(retained)).not.toContain(Redacted.value(presentation.presentationReceipt));
    expect(JSON.stringify(retained)).not.toContain(scope.authContextRef);
  }).pipe(Effect.provide(NodeCrypto.layer)),
);

it.effect('rejects a tampered receipt and different real session, actor, binding, namespace or scope', () =>
  Effect.gen(function* callerBinding() {
    const unit = yield* fixture();
    const presented = yield* (yield* operations(unit, scope, unit.dependencies)).present(target);
    const payload = { acknowledged: true as const, presentationReceipt: presented.presentationReceipt };
    const changedScopes: readonly OperationalScope[] = [
      { ...scope, authContextRef: 'another-session' },
      { ...scope, authBindingId: '10000000-0000-4000-8000-000000000099' },
      { ...scope, principalId: '10000000-0000-4000-8000-000000000099' },
      { ...scope, tenantId: '10000000-0000-4000-8000-000000000099' },
      { ...scope, legalEntityId: '10000000-0000-4000-8000-000000000099' },
      { ...scope, authenticationNamespaceId: 'staff' },
      { ...scope, impersonatedByPrincipalId: scope.principalId },
    ];
    for (const changed of changedScopes) {
      const service = yield* operations(unit, changed);
      expect(Result.isFailure(yield* service.acknowledge(payload, invocationId).pipe(Effect.result))).toBe(true);
    }
    const tampered = Redacted.make(`${Redacted.value(payload.presentationReceipt)}corrupt`);
    const failure = yield* Effect.flip(
      (yield* operations(unit, scope, unit.dependencies, unit.acknowledgements)).acknowledge(
        { ...payload, presentationReceipt: tampered },
        invocationId,
      ),
    );
    expect(failure.code).toBe('privacy_notice_acknowledgement_invalid');
    expect(unit.authorityCalls()).toBe(1);
    expect(unit.records.size).toBe(0);
  }).pipe(Effect.provide(NodeCrypto.layer)),
);

it.effect('does not accept altered immutable Notice material or a substituted signed target', () =>
  Effect.gen(function* exactMaterial() {
    const unit = yield* fixture();
    const presented = yield* (yield* operations(unit, scope, unit.dependencies)).present(target);
    const claims = yield* unit.dependencies.integrity.open(presented.presentationReceipt);
    for (const changed of [
      { ...claims, wordingDigest: '0'.repeat(64) },
      { ...claims, contentIdentity: 'notice:other-content' },
      { ...claims, applicableScopeDigest: '0'.repeat(64) },
      { ...claims, noticeVersionId: '10000000-0000-4000-8000-000000000099' },
      { ...claims, servedAt: '2026-10-20T12:00:00.001Z' },
    ]) {
      const receipt = yield* unit.dependencies.integrity.seal(changed);
      const result = yield* (yield* operations(unit, scope, unit.dependencies, unit.acknowledgements))
        .acknowledge({ acknowledged: true, presentationReceipt: receipt }, invocationId)
        .pipe(Effect.result);
      expect(Result.isFailure(result)).toBe(true);
    }
    expect(unit.records.size).toBe(0);
  }).pipe(Effect.provide(NodeCrypto.layer)),
);

it.effect('rejects ended or unsupported applicability without silently substituting another Notice or language', () =>
  Effect.gen(function* exactScope() {
    for (const unsupported of [
      { ...notice, wording: null },
      { ...notice, effectiveTo: now },
      { ...notice, applicableScope: { ...notice.applicableScope, operation: 'OTHER_OPERATION' } },
      {
        ...notice,
        applicableScope: {
          ...notice.applicableScope,
          facts: [...notice.applicableScope.facts, { dimension: 'CHANNEL' as const, value: 'web' }],
        },
      },
      {
        ...notice,
        applicableScope: {
          ...notice.applicableScope,
          facts: notice.applicableScope.facts.filter(({ dimension }) => dimension !== 'PRIVACY_SUBJECT'),
        },
      },
      {
        ...notice,
        applicableScope: {
          ...notice.applicableScope,
          facts: notice.applicableScope.facts.map((fact) =>
            fact.dimension === 'PROCESSING_PURPOSE_VERSION' ? { ...fact, value: 'not-a-version' } : fact,
          ),
        },
      },
    ]) {
      expect(
        Result.isFailure(yield* resolveNoticePresentationScope(unsupported, target, now).pipe(Effect.result)),
      ).toBe(true);
    }
    const fractional = { ...notice, effectiveTo: '2026-10-20T12:00:00.000001Z' };
    expect(Result.isSuccess(yield* resolveNoticePresentationScope(fractional, target, now).pipe(Effect.result))).toBe(
      true,
    );
    expect(
      Result.isFailure(
        yield* resolveNoticePresentationScope(fractional, target, fractional.effectiveTo).pipe(Effect.result),
      ),
    ).toBe(true);
  }),
);

it.effect('samples effective time after blocking Subject authority and signing before releasing the Notice', () =>
  Effect.gen(function* latePresentation() {
    const unit = yield* fixture({ ...notice, effectiveTo: '2026-10-20T12:00:00.001Z' });
    const authorityDelayed = {
      ...unit.dependencies,
      subjectAuthority: {
        resolve: () => TestClock.adjust(1).pipe(Effect.as({ evidenceRefs: ['unit:owner-evidence'] })),
      },
    };
    expect(
      Result.isFailure(yield* (yield* operations(unit, scope, authorityDelayed)).present(target).pipe(Effect.result)),
    ).toBe(true);
    yield* TestClock.setTime(Date.parse(now));
    const signingDelayed = {
      ...unit.dependencies,
      integrity: {
        ...unit.dependencies.integrity,
        seal: (claims: Parameters<typeof unit.dependencies.integrity.seal>[0]) =>
          unit.dependencies.integrity.seal(claims).pipe(Effect.tap(() => TestClock.adjust(1))),
      },
    };
    expect(
      Result.isFailure(yield* (yield* operations(unit, scope, signingDelayed)).present(target).pipe(Effect.result)),
    ).toBe(true);
    expect(unit.records.size).toBe(0);
  }).pipe(Effect.provide(NodeCrypto.layer)),
);

it.effect(
  'samples effective time after blocking authority and persistence and fails the Action on an end boundary',
  () =>
    Effect.gen(function* lateAcknowledgement() {
      const unit = yield* fixture({ ...notice, effectiveTo: '2026-10-20T12:00:00.001Z' });
      const presented = yield* (yield* operations(unit, scope, unit.dependencies)).present(target);
      const payload = { acknowledged: true as const, presentationReceipt: presented.presentationReceipt };
      const authorityDelayed = {
        ...unit.dependencies,
        subjectAuthority: {
          resolve: () => TestClock.adjust(1).pipe(Effect.as({ evidenceRefs: ['unit:owner-evidence'] })),
        },
      };
      expect(
        Result.isFailure(
          yield* (yield* operations(unit, scope, authorityDelayed, unit.acknowledgements))
            .acknowledge(payload, invocationId)
            .pipe(Effect.result),
        ),
      ).toBe(true);
      expect(unit.records.size).toBe(0);
      yield* TestClock.setTime(Date.parse(now));
      const blockingRepository = {
        ...unit.acknowledgements,
        record: (record: PrivacyNoticeAcknowledgement) =>
          unit.acknowledgements.record(record).pipe(Effect.tap(() => TestClock.adjust(1))),
      };
      const failed = yield* Effect.flip(
        (yield* operations(unit, scope, unit.dependencies, blockingRepository)).acknowledge(payload, invocationId),
      );
      expect(failed.code).toBe('privacy_notice_acknowledgement_invalid');
      // The unit port records the attempted insert; real transaction rollback is a separate PostgreSQL proof.
      expect(unit.records.size).toBe(1);
      expect(DateTime.formatIso(yield* DateTime.now)).toBe('2026-10-20T12:00:00.001Z');
    }).pipe(Effect.provide(NodeCrypto.layer)),
);

it.effect(
  'derives one stable Provision only from a retained acknowledgement and preserves its original recording time',
  () =>
    Effect.gen(function* durableChannel() {
      const unit = yield* fixture();
      const ports = yield* operations(unit);
      const presented = yield* ports.present(target);
      const acknowledged = yield* ports.acknowledge(
        { acknowledged: true, presentationReceipt: presented.presentationReceipt },
        invocationId,
      );
      const provisions = makeInMemoryNoticeProvisionRepository();
      const request = Schema.decodeUnknownSync(RecordNoticeProvisionPayloadSchema)({
        actionRef: null,
        anonymousContextRef: null,
        businessInteractionRef: target.businessInteractionRef,
        channel: privacyNoticeAcknowledgementChannel,
        claimRef: acknowledged.acknowledgementRef.resourceId,
        controllerRef: 'controller:unit',
        noticeVersionRef: target.noticeVersionId,
        privacySubjectRef: target.privacySubjectRef.resourceId,
        processingPurposeRef: 'purpose:unit',
        processingScopeRef: 'scope:unit',
        providedLanguage: 'en',
      });
      const context = {
        actionInvocationId: otherInvocationId,
        legalEntityId: scope.legalEntityId ?? '',
        principalId: scope.principalId,
        tenantId,
      };
      const authority = yield* Effect.gen(function* obtainChannel() {
        return yield* NoticeChannelDeliveryAuthority;
      }).pipe(
        Effect.provide(NoticeChannelDeliveryAuthorityForAcknowledgementsLive),
        Effect.provideService(PrivacyNoticePresentationService, unit.dependencies.integrity),
        Effect.provideService(CommerceCustomerContextNoticeSubjectAuthorityService, {
          forScope: () => unit.dependencies.subjectAuthority,
        }),
      );
      if (authority.forScope === undefined) {
        return yield* new PrivacyNoticeAcknowledgementError({
          code: 'privacy_notice_acknowledgement_unavailable',
          reason: 'Expected actual scoped acknowledgement owner',
        });
      }
      const reads: DataAccessEventInput[] = [];
      const channel = authority.forScope({
        acknowledgements: {
          findById: (id) =>
            unit.acknowledgements.findById(id).pipe(
              Effect.tap((row) =>
                Effect.sync(() => {
                  reads.push({
                    accessKind: 'read',
                    queryHash: 'privacy.notice-acknowledgement.by-id.v1',
                    resultCount: Option.isSome(row) ? 1 : 0,
                    servingModuleKey: 'privacy.core',
                  });
                }),
              ),
            ),
        },
        provisions: {
          findById: (readTenantId, legalEntityId, provisionId) =>
            provisions.findById(readTenantId, legalEntityId, provisionId).pipe(
              Effect.tap((row) =>
                Effect.sync(() => {
                  reads.push({
                    accessKind: 'read',
                    queryHash: 'privacy.notice-provision.by-id.v1',
                    resultCount: Option.isSome(row) ? 1 : 0,
                    servingModuleKey: 'privacy.core',
                  });
                }),
              ),
            ),
        },
        scope,
        subjects: unit.dependencies.repository,
      });
      const notAnAcknowledgement = yield* unit.dependencies.integrity.open(presented.presentationReceipt);
      expect(
        Result.isFailure(
          yield* channel
            .resolve({ ...request, claimRef: notAnAcknowledgement.presentationId }, context)
            .pipe(Effect.result),
        ),
      ).toBe(true);
      const fact = yield* channel.resolve(request, context);
      expect(fact.provision.provisionedAt).toBe(now);
      expect(fact.provision.channelProof?.proofKind).toBe('INTERACTIVE_ACKNOWLEDGEMENT');
      expect(fact.provision.provisionId).toBe(
        `privacy-notice-acknowledgement:${acknowledged.acknowledgementRef.resourceId}`,
      );
      const acknowledgement = unit.records.values().next().value;
      if (acknowledgement === undefined) {
        return yield* new PrivacyNoticeAcknowledgementError({
          code: 'privacy_notice_acknowledgement_unavailable',
          reason: 'Expected retained unit acknowledgement',
        });
      }
      const retainedSubject = Schema.decodeUnknownSync(PrivacySubjectRecordSchema)({
        createdAt: now,
        subject: {
          kind: 'DATA_SUBJECT',
          partyRef: {
            moduleId: 'party.registry',
            resourceId: '20000000-0000-4000-8000-000000000001',
            resourceType: 'party.registry.party',
            tenantId,
          },
        },
        subjectRef: target.privacySubjectRef,
        updatedAt: now,
      });
      const partyEvidence = Schema.decodeUnknownSync(PrivacySubjectOwnerEvidenceSchema)({
        observedAt: now,
        ownerRevision: 1,
        partyRef: retainedSubject.subject.kind === 'DATA_SUBJECT' ? retainedSubject.subject.partyRef : null,
        typeAssertions: [{ assertionId: 'unit:prepared-person', validFrom: now, validTo: '2026-10-20T12:00:30.000Z' }],
      });
      const preparedSubject = yield* observeNoticeSubjectPreparation(
        {
          compositionRevision: 'a'.repeat(64),
          records: [retainedSubject],
          scope,
          target: acknowledgement,
        },
        {
          forScope: () => ({ resolve: () => Effect.succeed({ evidenceRefs: ['unit:prepared-owner'], partyEvidence }) }),
        },
      );
      const preparedInput = {
        acknowledgements: unit.acknowledgements,
        prepared: { acknowledgement, readEvidence: [], subject: preparedSubject },
        provisions,
        scope,
        subjects: { listSubjects: () => Effect.succeed([retainedSubject]) },
      };
      const preparedChannel = authority.forScope(preparedInput);
      const callsBeforePreparedCommit = unit.authorityCalls();
      expect(yield* preparedChannel.resolve(request, context)).toEqual(fact);
      expect(unit.authorityCalls()).toBe(callsBeforePreparedCommit);
      expect(
        Result.isFailure(
          yield* preparedChannel.resolve({ ...request, providedLanguage: 'cs' }, context).pipe(Effect.result),
        ),
      ).toBe(true);
      expect(
        Result.isFailure(
          yield* authority
            .forScope({ ...preparedInput, scope: { ...scope, legalEntityId: '10000000-0000-4000-8000-000000000099' } })
            .resolve(request, context)
            .pipe(Effect.result),
        ),
      ).toBe(true);
      expect(
        Result.isFailure(
          yield* authority
            .forScope({
              ...preparedInput,
              subjects: {
                listSubjects: () => Effect.succeed([{ ...retainedSubject, updatedAt: '2026-10-20T12:00:01.000Z' }]),
              },
            })
            .resolve(request, context)
            .pipe(Effect.result),
        ),
      ).toBe(true);
      expect(
        Result.isFailure(
          yield* authority
            .forScope({
              ...preparedInput,
              acknowledgements: {
                findById: () => Effect.succeed(Option.some({ ...acknowledgement, businessInteractionRef: 'changed' })),
              },
            })
            .resolve(request, context)
            .pipe(Effect.result),
        ),
      ).toBe(true);
      yield* TestClock.adjust(30_000);
      expect(Result.isFailure(yield* preparedChannel.resolve(request, context).pipe(Effect.result))).toBe(true);
      expect(unit.authorityCalls()).toBe(callsBeforePreparedCommit);
      yield* TestClock.setTime(Date.parse(now));
      reads.length = 0;
      const harness = yield* makeActionTestHarness({
        actionPermission: 'allowed',
        services: [
          bindActionTestServices(recordNoticeProvisionAction, {
            authority: channel,
            readEvidence: () => [...reads],
            record: provisions.record,
          }),
        ],
      });
      const retained = yield* harness.runtime
        .runAction({
          audience: 'privacy',
          payload: request,
          principal: scope,
          registration: recordNoticeProvisionAction,
          transport: { correlationId: 'provision-evidence-first', idempotencyKey: 'provision-evidence-first' },
        })
        .pipe(Effect.provideService(NoticeChannelDeliveryAuthority, authority));
      expect(harness.snapshot().committed[0]?.evidence.dataAccessEvents.map(({ resultCount }) => resultCount)).toEqual([
        1, 0,
      ]);
      reads.length = 0;
      yield* TestClock.adjust(1000);
      const repeatedResult = yield* harness.runtime
        .runAction({
          audience: 'privacy',
          payload: request,
          principal: scope,
          registration: recordNoticeProvisionAction,
          transport: { correlationId: 'provision-evidence-retained', idempotencyKey: 'provision-evidence-retained' },
        })
        .pipe(Effect.provideService(NoticeChannelDeliveryAuthority, authority));
      expect(repeatedResult).toEqual(retained);
      expect(harness.snapshot().committed[1]?.evidence.dataAccessEvents.map(({ resultCount }) => resultCount)).toEqual([
        1, 1,
      ]);
      expect(
        JSON.stringify(harness.snapshot().committed.map(({ evidence }) => evidence.dataAccessEvents)),
      ).not.toContain(Redacted.value(presented.presentationReceipt));
      const repeated = yield* channel.resolve(request, context);
      expect(repeated.retainedProvision).toEqual(retained);
      expect(repeated.provision).toEqual(fact.provision);
      const sameFact = yield* materializePrivacyNoticeProvision(repeated.provision, {
        authoritativeProof: repeated.provision.channelProof ?? null,
        recordedAt: repeated.retainedProvision?.recordedAt ?? '',
      });
      expect(sameFact).toEqual(retained);
      for (const changed of [
        { ...request, controllerRef: 'controller:foreign' },
        { ...request, processingScopeRef: 'scope:foreign' },
        { ...request, processingPurposeRef: 'purpose:foreign' },
        { ...request, businessInteractionRef: 'interaction:foreign' },
        { ...request, providedLanguage: 'cs' },
        { ...request, noticeVersionRef: '10000000-0000-4000-8000-000000000099' },
      ]) {
        expect(Result.isFailure(yield* channel.resolve(changed, context).pipe(Effect.result))).toBe(true);
      }
      const otherSession = authority.forScope({
        acknowledgements: unit.acknowledgements,
        provisions,
        scope: { ...scope, authContextRef: 'another-session' },
        subjects: unit.dependencies.repository,
      });
      expect(Result.isFailure(yield* otherSession.resolve(request, context).pipe(Effect.result))).toBe(true);
      expect(Result.isFailure(yield* authority.resolve(request, context).pipe(Effect.result))).toBe(true);
      expect(unit.records.size).toBe(1);
      return yield* Effect.void;
    }).pipe(Effect.provide(Layer.mergeAll(NodeCrypto.layer, noticeUnitNamespaceLive))),
);

it.effect('the real acknowledgement Action commits the actual read metadata with its audit evidence', () =>
  Effect.gen(function* actionReadEvidence() {
    const unit = yield* fixture();
    const services = yield* operations(unit);
    const presented = yield* services.present(target);
    const harness = yield* makeActionTestHarness({
      actionPermission: 'allowed',
      services: [bindActionTestServices(acknowledgePrivacyNoticeAction, services)],
    });
    const payload = { acknowledged: true as const, presentationReceipt: Redacted.value(presented.presentationReceipt) };
    const first = yield* harness.runtime
      .runAction({
        audience: 'privacy',
        payload,
        principal: scope,
        registration: acknowledgePrivacyNoticeAction,
        transport: { correlationId: 'notice-evidence-first', idempotencyKey: 'notice-evidence-first' },
      })
      .pipe(
        Effect.provide(privacyNoticeInformationStepLive),
        Effect.provideService(PrivacyNoticePresentationService, unit.dependencies.integrity),
        Effect.provideService(CommerceCustomerContextNoticeSubjectAuthorityService, {
          forScope: () => unit.dependencies.subjectAuthority,
        }),
      );
    yield* TestClock.adjust(1);
    const second = yield* harness.runtime
      .runAction({
        audience: 'privacy',
        payload,
        principal: scope,
        registration: acknowledgePrivacyNoticeAction,
        transport: { correlationId: 'notice-evidence-retained', idempotencyKey: 'notice-evidence-retained' },
      })
      .pipe(
        Effect.provide(privacyNoticeInformationStepLive),
        Effect.provideService(PrivacyNoticePresentationService, unit.dependencies.integrity),
        Effect.provideService(CommerceCustomerContextNoticeSubjectAuthorityService, {
          forScope: () => unit.dependencies.subjectAuthority,
        }),
      );
    expect(second).toEqual(first);
    expect(first).not.toHaveProperty('readEvidence');
    expect(unit.records.size).toBe(1);
    const commits = harness.snapshot().committed;
    expect(commits.length).toBe(2);
    for (const commit of commits) {
      expect(commit.evidence.auditEvidence).toEqual(
        expect.objectContaining({
          acknowledgementRef: first.acknowledgementRef,
          noticeVersionId: first.noticeVersionId,
        }),
      );
    }

    expect(commits[0]?.evidence.dataAccessEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          accessKind: 'list',
          queryHash: 'privacy.notice-version.for-scope.v1',
          resultCount: 1,
          servingModuleKey: 'privacy.core',
        }),
      ]),
    );
    expect(commits[0]?.evidence.dataAccessEvents.length).toBe(1);
    expect(commits[1]?.evidence.dataAccessEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          accessKind: 'read',
          queryHash: 'privacy.notice-acknowledgement.by-presentation.v1',
          resultCount: 1,
          servingModuleKey: 'privacy.core',
        }),
      ]),
    );
    expect(commits[1]?.evidence.dataAccessEvents.length).toBe(2);
    expect(JSON.stringify(commits.map(({ evidence }) => evidence.dataAccessEvents))).not.toContain(
      Redacted.value(presented.presentationReceipt),
    );
    expect(JSON.stringify(commits.map(({ evidence }) => evidence.dataAccessEvents))).not.toContain(notice.wording);
    const rejectingHarness = yield* makeActionTestHarness({
      actionPermission: 'allowed',
      services: [
        bindActionTestServices(acknowledgePrivacyNoticeAction, {
          acknowledge: (received, actionInvocationId) =>
            services.acknowledge(received, actionInvocationId).pipe(
              Effect.map((result) => ({
                ...result,
                readEvidence: [
                  ...result.readEvidence,
                  {
                    accessKind: 'read' as const,
                    evidencePayloadJson: 'forbidden-for-metadata-only',
                    queryHash: 'privacy.unit.invalid-evidence.v1',
                    resultCount: 1,
                    servingModuleKey: 'privacy.core',
                  },
                ],
              })),
            ),
        }),
      ],
    });
    const rejected = yield* rejectingHarness.runtime
      .runAction({
        audience: 'privacy',
        payload,
        principal: scope,
        registration: acknowledgePrivacyNoticeAction,
        transport: { correlationId: 'notice-evidence-rejected', idempotencyKey: 'notice-evidence-rejected' },
      })
      .pipe(
        Effect.provide(privacyNoticeInformationStepLive),
        Effect.provideService(PrivacyNoticePresentationService, unit.dependencies.integrity),
        Effect.provideService(CommerceCustomerContextNoticeSubjectAuthorityService, {
          forScope: () => unit.dependencies.subjectAuthority,
        }),
        Effect.result,
      );
    expect(Result.isFailure(rejected)).toBe(true);
    expect(rejectingHarness.snapshot().committed.length).toBe(0);
    expect(rejectingHarness.snapshot().invocations.some(({ status }) => status === 'succeeded')).toBe(false);
  }).pipe(Effect.provide(Layer.mergeAll(NodeCrypto.layer, noticeUnitNamespaceLive))),
);

it('maps definite authenticated Notice authority denial to 403, invalidity to 422 and unavailable evidence to 503', () => {
  const denied = mapAcknowledgePrivacyNoticeActionProblem(
    new PrivacyNoticeAcknowledgementError({
      code: 'privacy_notice_acknowledgement_denied',
      reason: 'unit-private-owner-denial-detail',
    }),
  );
  expect(denied.status).toBe(403);
  expect(Schema.is(AcknowledgePrivacyNoticeActionForbiddenProblemSchema)(denied)).toBe(true);
  expect(Schema.is(AcknowledgePrivacyNoticeActionIneligibleProblemSchema)({ ...denied, status: 422 })).toBe(false);
  expect(JSON.stringify(denied)).not.toContain('unit-private-owner-denial-detail');
  const invalid = mapAcknowledgePrivacyNoticeActionProblem(
    new PrivacyNoticeAcknowledgementError({
      code: 'privacy_notice_acknowledgement_invalid',
      reason: 'Unit invalid presentation',
    }),
  );
  expect(invalid.status).toBe(422);
  expect(Schema.is(AcknowledgePrivacyNoticeActionIneligibleProblemSchema)(invalid)).toBe(true);
  const unavailable = mapAcknowledgePrivacyNoticeActionProblem(
    new PrivacyNoticeAcknowledgementError({
      code: 'privacy_notice_acknowledgement_unavailable',
      reason: 'Unit current evidence unavailable',
    }),
  );
  expect(unavailable.status).toBe(503);
  expect(Schema.is(AcknowledgePrivacyNoticeActionUnavailableProblemSchema)(unavailable)).toBe(true);
});
