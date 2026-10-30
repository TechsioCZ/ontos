import { makeLiveOperationFixture } from '@app/core-runtime/testing/actions';
import { STAFF_AUTHENTICATION_NAMESPACE_ID } from '@app/core-runtime/auth/staff-authentication-namespace';
import { recordConsentDecisionAction } from '../../src/actions/record-consent-decision.action.ts';
import { addProcessingPurposeVersionAction } from '../../src/actions/add-processing-purpose-version.action.ts';
import { PurposeVersionConflict } from '../../shared/domain/processing-purpose.ts';
import type { OperationalScope, ScopedTransactionExecutor } from '@app/core-runtime';
import { createHash } from 'node:crypto';
import { makeIsolatedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import { makeApplicationCompositionSnapshotFixture } from '@app/core-runtime/testing/module-contract';
import {
  makeContextPermissionRelationshipMutationLive,
  runAction,
  TrustedPrincipalContextSchema,
  ReadRuntime,
  canonicalizeApplicationComposition,
  OntosModuleDeploymentContractSchema,
  validateActiveApplicationCompositionSnapshot,
} from '@app/core-runtime';
import { ultramodernApiMarker } from '../../shared/ultramodern-build.ts';
import { makeNativeReadTestContext } from '@app/core-runtime/testing/native-reads';
import { eq } from 'drizzle-orm';
import { currentConsentRead } from '../../src/api/current-consent.read.ts';
import { processingPurposesRead } from '../../src/api/processing-purposes.read.ts';
import { consentDecisions, consentScopeBindings, purposeVersions } from '../../src/database/schema.ts';
import { NodeCrypto, NodeChildProcessSpawner, NodeServices } from '@effect/platform-node';
import { Crypto, DateTime, Effect, Layer, Option, Redacted, Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { TestClock } from 'effect/testing';

import { PrivacyApplicabilityDecisionSchema } from '../../shared/domain/privacy-applicability.ts';
import { PrivacyLegalBasisAssignmentSchema } from '../../shared/domain/privacy-legal-basis.ts';
import { PrivacyResponsibilityAssignmentSchema } from '../../shared/domain/privacy-responsibility-assignment.ts';
import { RetentionRuleAuthorityResolutionSchema } from '../../shared/domain/privacy-retention-rule.ts';
import { CreateProcessingActivityInputSchema } from '../../shared/domain/processing-activity.ts';
import { ProcessingActivityAuthoritativeCoverageSchema } from '../../shared/domain/processing-coverage.ts';
import { processingActivityRepositoryForScope } from '../../src/persistence/processing-activity-postgres-repository.ts';
import { ConsentDecisionSchema } from '../../shared/domain/privacy-consent-decision.ts';
import { PrivacySubjectRecordSchema } from '../../shared/domain/privacy-subject.ts';
import { noticeProvisionRepositoryForScope } from '../../src/persistence/notice-provision-postgres-repository.ts';
import { privacyOperationRepositoryForScope } from '../../src/persistence/privacy-operation-postgres-repository.ts';
import { processingPurposeRepositoryForScope } from '../../src/persistence/processing-purpose-postgres-repository.ts';

const atGrant = '2026-01-02T00:00:00.000Z';
const atEnd = '2026-02-01T00:00:00.000Z';
const atWithdrawal = '2026-03-01T00:00:00.000Z';
const nextId = Crypto.Crypto.use((crypto) => crypto.randomUUIDv4());

const nativeServices = NodeChildProcessSpawner.layer.pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeCrypto.layer),
);
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const makeRetainedIsolation = Effect.fn('RetainedWithdrawal.makeIsolation')(function* makeRetainedIsolation() {
  const base = yield* makeApplicationCompositionSnapshotFixture(
    [ultramodernApiMarker.appId],
    ultramodernApiMarker.buildMarker,
  );
  const modules = yield* Effect.forEach(
    base.composition.modules,
    Effect.fn('RetainedWithdrawal.moduleContract')(function* moduleContract(module) {
      const contract = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(OntosModuleDeploymentContractSchema))(
        module.contractDocument,
      );
      const document = yield* Schema.encodeEffect(Schema.fromJsonString(OntosModuleDeploymentContractSchema))({
        ...contract,
        manifest: { ...contract.manifest, module: { ...contract.manifest.module, id: 'privacy.core' } },
      });
      const sha256 = digest(document);
      return {
        ...module,
        contract: { ...module.contract, sha256 },
        contractDocument: document,
        moduleId: 'privacy.core',
        publicContract: { ...module.publicContract, id: 'privacy.core', sha256 },
      };
    }),
    { concurrency: 1 },
  );
  const composition = { ...base.composition, modules };
  const snapshot = yield* validateActiveApplicationCompositionSnapshot({
    ...base,
    composition: {
      ...composition,
      revision: digest(canonicalizeApplicationComposition({ ...composition, revision: '0'.repeat(64) })),
    },
  });
  const isolated = yield* makeIsolatedNativeDatabaseFixture({
    compositionSnapshot: snapshot,
    mode: 'schema-only',
    purpose: 'stabilization-1261-retained-purpose-withdrawal',
  });
  expect(isolated.connections.admin.database.startsWith('ontos_test_party_gateway_')).toBe(true);
  expect(isolated.connections.runtime.database).toBe(isolated.connections.admin.database);
  return { isolated, snapshot };
});
const makeRetainedNative = Effect.fn('RetainedWithdrawal.makeNative')(function* makeRetainedNative(
  contextPermissions: readonly string[],
) {
  const { isolated } = yield* makeRetainedIsolation();
  return yield* makeNativeReadTestContext({
    connections: {
      admin: { connectionString: Redacted.make(isolated.connections.admin.connectionString) },
      runtime: { connectionString: Redacted.make(isolated.connections.runtime.connectionString) },
    },
    contextPermissions,
    moduleId: 'privacy.core',
    ownerFixtureRetention: 'retain-complete-context',
  });
});

// Normal owner producers; the channel proof is an explicit fixture precondition,
// not a claim that a production channel/receiving authority has been configured.
const prepareOriginalConsent = Effect.fn('RetainedWithdrawal.prepareOriginalConsent')(function* prepareOriginalConsent(
  transaction: ScopedTransactionExecutor,
  scope: OperationalScope,
) {
  const legalEntityId = Option.getOrThrow(Option.fromUndefinedOr(scope.legalEntityId));
  const purposeOwner = yield* processingPurposeRepositoryForScope(transaction, scope);
  const owner = yield* privacyOperationRepositoryForScope(transaction, scope);
  const provisions = yield* noticeProvisionRepositoryForScope(transaction, scope);
  const subjectId = yield* nextId;
  const scopeRef = `retained-scope:${yield* nextId}`;
  const controllerRef = 'controller:retained-withdrawal';
  const materialScope = {
    applicabilityKey: 'applicability:retained-withdrawal',
    consentRequired: true,
    consentScopeKey: scopeRef,
    controllerRef,
    dataCategoryRefs: ['contact'],
    processingScopeRef: scopeRef,
    recipientRefs: [],
  };
  const purpose = yield* purposeOwner.create(scope.tenantId, legalEntityId, yield* nextId, {
    businessCode: 'RETAINED_WITHDRAWAL',
    effectiveFrom: '2026-01-01T00:00:00.000Z',
    governanceOwnerId: scope.principalId,
    materialScope,
    meaning: 'Original V1 Consent purpose',
    requiredConsentDimensions: [],
  });
  const version = Option.getOrThrow(Option.fromUndefinedOr(purpose.versions[0]));
  const subject = yield* Schema.decodeUnknownEffect(PrivacySubjectRecordSchema)({
    createdAt: atGrant,
    subject: {
      anonymousContext: {
        addressability: 'SESSION',
        contextRef: `session:${subjectId}`,
        createdAt: atGrant,
        expiresAt: '2027-01-01T00:00:00.000Z',
        kind: 'ANONYMOUS_PRIVACY_CONTEXT',
        provenance: { method: 'SESSION', source: 'retained-withdrawal-owner-fixture' },
      },
      kind: 'ANONYMOUS',
    },
    subjectRef: {
      moduleId: 'privacy.core',
      resourceId: subjectId,
      resourceType: 'privacy.core.privacy-subject',
      tenantId: scope.tenantId,
    },
    updatedAt: atGrant,
  });
  yield* owner.createSubject(
    { legalEntityId, tenantId: scope.tenantId },
    { actionInvocationId: yield* nextId, subject },
  );
  const consentScope = {
    controllerRef,
    materialDimensions: [],
    privacySubjectRef: subject.subjectRef,
    processingPurposeRef: purpose.purposeRef,
    purposeMeaning: version.meaning,
    purposeVersionRef: version.versionId,
    scopeRef,
  };
  const notice = yield* owner.createNoticeVersion(
    { legalEntityId, tenantId: scope.tenantId },
    {
      actionInvocationId: yield* nextId,
      input: {
        applicableScope: {
          facts: [
            { dimension: 'PRIVACY_SUBJECT', value: subjectId },
            { dimension: 'CONTROLLER_SCOPE', value: controllerRef },
            { dimension: 'PROCESSING_PURPOSE', value: purpose.purposeRef.resourceId },
            { dimension: 'PROCESSING_PURPOSE_VERSION', value: version.versionId },
          ],
          operation: 'CONSENT_DECISION',
          processingScopeRef: { scopeId: scopeRef, scopeType: 'privacy.processing-scope' },
        },
        contentIdentity: `notice:${scopeRef}`,
        effectiveFrom: '2026-01-01T00:00:00.000Z',
        evidenceArtifactRef: null,
        language: 'en',
        wording: 'Original V1 choice information',
      },
      noticeId: yield* nextId,
    },
  );
  const evidenceRef = `notice-proof:${yield* nextId}`;
  const interaction = `interaction:${yield* nextId}`;
  yield* provisions.record(scope.tenantId, legalEntityId, yield* nextId, {
    actionRef: 'retained-withdrawal-fixture',
    anonymousContextRef: null,
    businessInteractionRef: interaction,
    channel: 'web',
    channelProof: {
      anonymousContextRef: null,
      authorityRef: 'fixture:notice-channel-precondition',
      businessInteractionRef: interaction,
      channel: 'web',
      controllerRef,
      evidenceRef,
      noticeVersionRef: notice.versionId,
      observedAt: '2026-01-01T00:00:01.000Z',
      privacySubjectRef: subjectId,
      processingPurposeRef: purpose.purposeRef.resourceId,
      processingScopeRef: scopeRef,
      proofKind: 'INTERACTIVE_ACKNOWLEDGEMENT',
      providedLanguage: 'en',
    },
    controllerRef,
    evidenceRef,
    failureReason: null,
    noticeVersionRef: notice.versionId,
    outcome: 'PROVEN_PROVISION',
    privacySubjectRef: subjectId,
    processingPurposeRef: purpose.purposeRef.resourceId,
    processingScopeRef: scopeRef,
    providedLanguage: 'en',
    provisionedAt: '2026-01-01T00:00:01.000Z',
    provisionId: evidenceRef,
    recordedAt: '2026-01-01T00:00:02.000Z',
    supersedesProvisionRef: null,
  });
  const grant = yield* Schema.decodeUnknownEffect(ConsentDecisionSchema)({
    actorEvidence: {
      actor: { principalId: scope.principalId, tenantId: scope.tenantId },
      attributedAt: atGrant,
      authMethod: scope.authMethod,
      impersonatedBy: null,
    },
    decision: 'GRANTED',
    decisionId: yield* nextId,
    effectiveAt: atGrant,
    flowEvidenceRefs: [],
    noticeEvidenceRefs: [evidenceRef],
    provenanceRefs: ['fixture:original-choice'],
    recordedAt: atGrant,
    scope: consentScope,
  });
  const versionInput = {
    effectiveFrom: atEnd,
    materialChange: { affectedPrivacySubjectRefs: [subjectId], changedAt: atEnd, changeRef: `change:${scopeRef}` },
    materialScope,
    meaning: 'Changed V2 purpose must not inherit V1 Consent',
    requiredConsentDimensions: [],
  };
  return { grant, purpose, versionInput };
});

it.live('rejects ended V1 withdrawal without a retained original grant in the native owner transaction', () =>
  Effect.gen(function* nativeRetainedBasisRed() {
    const native = yield* makeRetainedNative(['privacy.consent.read']);
    const context = yield* Layer.build(native.layer);
    const original = yield* native.prepareOwner(prepareOriginalConsent).pipe(Effect.provideContext(context));
    const rawBefore = yield* native
      .prepareOwner((transaction) =>
        transaction
          .select()
          .from(purposeVersions)
          .where(eq(purposeVersions.purposeVersionId, original.grant.scope.purposeVersionRef)),
      )
      .pipe(Effect.provideContext(context));
    const appended = yield* native
      .prepareOwner(
        Effect.fn('RetainedWithdrawal.endOriginalPurpose')(function* endOriginalPurpose(transaction, scope) {
          const purposes = yield* processingPurposeRepositoryForScope(transaction, scope);
          return yield* purposes.addVersion(
            scope.tenantId,
            Option.getOrThrow(Option.fromUndefinedOr(scope.legalEntityId)),
            original.purpose.purposeRef.resourceId,
            yield* nextId,
            original.versionInput,
          );
        }),
      )
      .pipe(Effect.provideContext(context));
    const rawAfter = yield* native
      .prepareOwner((transaction) =>
        transaction
          .select()
          .from(purposeVersions)
          .where(eq(purposeVersions.purposeVersionId, original.grant.scope.purposeVersionRef)),
      )
      .pipe(Effect.provideContext(context));
    expect(rawAfter).toEqual(rawBefore);
    expect(rawAfter[0]?.effectiveTo).toBeNull();
    expect(appended.versions[0]?.effectiveTo).toBe(atEnd);
    const withdrawal = {
      ...original.grant,
      decision: 'WITHDRAWN' as const,
      decisionId: yield* nextId,
      effectiveAt: atWithdrawal,
      recordedAt: atWithdrawal,
    };
    const result = yield* native
      .prepareOwner(
        Effect.fn('RetainedWithdrawal.withdrawWithoutGrant')(function* withdrawWithoutGrant(transaction, scope) {
          const owner = yield* privacyOperationRepositoryForScope(transaction, scope);
          return yield* owner.recordConsentDecision(
            scope.tenantId,
            Option.getOrThrow(Option.fromUndefinedOr(scope.legalEntityId)),
            yield* nextId,
            withdrawal,
          );
        }),
      )
      .pipe(Effect.provideContext(context), Effect.result);
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure).toMatchObject({ code: 'privacy_operation_conflict' });
    }
    const bindings = yield* native
      .prepareOwner((transaction) =>
        transaction
          .select()
          .from(consentScopeBindings)
          .where(eq(consentScopeBindings.scopeRef, original.grant.scope.scopeRef)),
      )
      .pipe(Effect.provideContext(context));
    expect(bindings).toEqual([]);
  }).pipe(Effect.provide(nativeServices)),
);

const proveRetainedWithdrawal = Effect.fn('RetainedWithdrawal.proveNativeBoundary')(function* proveRetainedWithdrawal(
  at: string,
) {
  const native = yield* makeRetainedNative(['privacy.consent.read', 'privacy.processing_catalog.read']);
  const context = yield* Layer.build(native.layer);
  const original = yield* native.prepareOwner(prepareOriginalConsent).pipe(Effect.provideContext(context));
  const originalInvocation = yield* nextId;
  const before = yield* native
    .prepareOwner(
      Effect.fn('RetainedWithdrawal.recordOriginal')(function* recordOriginal(transaction, scope) {
        const owner = yield* privacyOperationRepositoryForScope(transaction, scope);
        yield* owner.recordConsentDecision(
          scope.tenantId,
          Option.getOrThrow(Option.fromUndefinedOr(scope.legalEntityId)),
          originalInvocation,
          original.grant,
        );
        return yield* transaction
          .select()
          .from(purposeVersions)
          .where(eq(purposeVersions.purposeVersionId, original.grant.scope.purposeVersionRef));
      }),
    )
    .pipe(Effect.provideContext(context));
  yield* native
    .prepareOwner(
      Effect.fn('RetainedWithdrawal.appendV2')(function* appendV2(transaction, scope) {
        const owner = yield* processingPurposeRepositoryForScope(transaction, scope);
        return yield* owner.addVersion(
          scope.tenantId,
          Option.getOrThrow(Option.fromUndefinedOr(scope.legalEntityId)),
          original.purpose.purposeRef.resourceId,
          yield* nextId,
          original.versionInput,
        );
      }),
    )
    .pipe(Effect.provideContext(context));
  const withdrawal = {
    ...original.grant,
    decision: 'WITHDRAWN' as const,
    decisionId: yield* nextId,
    effectiveAt: at,
    recordedAt: at,
  };
  const written = yield* native
    .prepareOwner(
      Effect.fn('RetainedWithdrawal.appendWithdrawal')(function* appendWithdrawal(transaction, scope) {
        const owner = yield* privacyOperationRepositoryForScope(transaction, scope);
        return yield* owner.recordConsentDecision(
          scope.tenantId,
          Option.getOrThrow(Option.fromUndefinedOr(scope.legalEntityId)),
          yield* nextId,
          withdrawal,
        );
      }),
    )
    .pipe(Effect.provideContext(context));
  expect(written).toEqual(withdrawal);
  const current = yield* native.runtime
    .runRead({
      input: { scopeRefs: [original.grant.scope.scopeRef] },
      principal: native.principal,
      registration: currentConsentRead,
      transport: { correlationId: yield* nextId },
    })
    .pipe(Effect.provideContext(context));
  expect(current.items[0]?.resolution).toEqual({ decision: withdrawal, outcome: 'CURRENT' });
  const catalog = yield* native.runtime
    .runRead({
      input: { at, includeRetired: true, purposeRefs: [original.purpose.purposeRef] },
      principal: native.principal,
      registration: processingPurposesRead,
      transport: { correlationId: yield* nextId },
    })
    .pipe(Effect.provideContext(context));
  expect(catalog.items[0]?.purpose.versions[0]?.effectiveTo).toBe(atEnd);
  expect(catalog.items[0]?.effectiveVersion?.versionNumber).toBe(2);
  const invalidGrant = yield* native
    .prepareOwner(
      Effect.fn('RetainedWithdrawal.rejectNewEndedGrant')(function* rejectNewEndedGrant(transaction, scope) {
        const owner = yield* privacyOperationRepositoryForScope(transaction, scope);
        return yield* owner.recordConsentDecision(
          scope.tenantId,
          Option.getOrThrow(Option.fromUndefinedOr(scope.legalEntityId)),
          yield* nextId,
          { ...original.grant, decisionId: yield* nextId, effectiveAt: at, recordedAt: at },
        );
      }),
    )
    .pipe(Effect.provideContext(context), Effect.result);
  expect(Result.isFailure(invalidGrant)).toBe(true);
  if (Result.isFailure(invalidGrant)) {
    expect(invalidGrant.failure).toMatchObject({ code: 'privacy_operation_conflict' });
  }
  const retained = yield* native
    .prepareOwner((transaction) =>
      Effect.all(
        {
          history: transaction
            .select({ record: consentDecisions.decisionRecord })
            .from(consentDecisions)
            .where(eq(consentDecisions.scopeRef, original.grant.scope.scopeRef)),
          purpose: transaction
            .select()
            .from(purposeVersions)
            .where(eq(purposeVersions.purposeVersionId, original.grant.scope.purposeVersionRef)),
        },
        { concurrency: 1 },
      ),
    )
    .pipe(Effect.provideContext(context));
  expect(retained.purpose).toEqual(before);
  expect(retained.history.map(({ record }) => record)).toEqual(
    expect.arrayContaining([
      Schema.encodeSync(ConsentDecisionSchema)(original.grant),
      Schema.encodeSync(ConsentDecisionSchema)(withdrawal),
    ]),
  );
  expect(retained.history).toHaveLength(2);
});

it.live(
  'retains V1 bytes and permits exact original withdrawal at its exclusive end while rejecting new V1 grants',
  () => proveRetainedWithdrawal(atEnd).pipe(Effect.scoped, Effect.provide(nativeServices)),
);

it.live(
  'retains V1 bytes and permits exact original withdrawal after its exclusive end while rejecting new V1 grants',
  () => proveRetainedWithdrawal(atWithdrawal).pipe(Effect.scoped, Effect.provide(nativeServices)),
);

// Ancillary governance/owner coverage are explicit trusted fixture preconditions.
// Their records are produced through the actual scoped owner repositories, never raw SQL.
const prepareActivity = Effect.fn('RetainedWithdrawal.prepareActivity')(function* prepareActivity(
  transaction: ScopedTransactionExecutor,
  scope: OperationalScope,
  original: Effect.Success<ReturnType<typeof prepareOriginalConsent>>,
  at: string,
) {
  const legalEntityId = Option.getOrThrow(Option.fromUndefinedOr(scope.legalEntityId));
  const owner = yield* privacyOperationRepositoryForScope(transaction, scope);
  const activities = yield* processingActivityRepositoryForScope(transaction, scope);
  const actor = {
    moduleId: 'core.identity',
    principalId: scope.principalId,
    principalType: 'user',
    tenantId: scope.tenantId,
  };
  const controller = {
    moduleId: 'core.identity',
    resourceId: legalEntityId,
    resourceType: 'core.identity.legal-entity',
    tenantId: scope.tenantId,
  };
  const ref = (resourceType: string, resourceId: string) => ({
    moduleId: 'privacy.core',
    resourceId,
    resourceType,
    tenantId: scope.tenantId,
  });
  const responsibilityRef = ref('privacy.core.privacy-responsibility-assignment', yield* nextId);
  const basisRef = ref('privacy.core.legal-basis-assignment', yield* nextId);
  const category = ref('privacy.core.data-category', yield* nextId);
  const system = ref('privacy.core.system-of-record', yield* nextId);
  const ruleRef = ref('privacy.core.retention-rule', yield* nextId);
  const ruleVersionId = yield* nextId;
  const scopeRef = { scopeId: `activity:${yield* nextId}`, scopeType: 'privacy.processing-scope' };
  const applicabilityScope = {
    facts: [
      { dimension: 'CONTROLLER_SCOPE', value: legalEntityId },
      { dimension: 'PROCESSING_PURPOSE', value: original.purpose.purposeRef.resourceId },
      { dimension: 'PROCESSING_PURPOSE_VERSION', value: original.grant.scope.purposeVersionRef },
    ],
    operation: 'retained-purpose-activity',
    processingScopeRef: scopeRef,
  };
  const applicability = yield* Schema.decodeUnknownEffect(PrivacyApplicabilityDecisionSchema)({
    authority: {
      controllerRef: controller,
      legalEntityId,
      purposeRef: original.purpose.purposeRef,
      purposeVersionRef: ref('privacy.core.processing-purpose-version', original.grant.scope.purposeVersionRef),
      tenantId: scope.tenantId,
    },
    evaluatedAt: atGrant,
    evaluatedScope: applicabilityScope,
    evidenceRefs: ['fixture:activity-applicability'],
    outcome: 'APPLICABLE',
    policyIdentities: [{ policyKey: 'privacy.applicability.eu-eea.v1', policyVersion: '1' }],
    proposedActivity: true,
    reasonCodes: ['explicit_policy_match'],
    responsibilityAssignmentRefs: [responsibilityRef],
  });
  yield* owner.assignResponsibility(
    scope.tenantId,
    legalEntityId,
    yield* nextId,
    yield* Schema.decodeUnknownEffect(PrivacyResponsibilityAssignmentSchema)({
      actor,
      assignmentRef: responsibilityRef,
      effectiveFrom: atGrant,
      effectiveTo: null,
      holder: { holder: controller, holderKind: 'LEGAL_ENTITY' },
      provenance: {
        decisionEvidenceRefs: ['fixture:responsibility'],
        reason: 'native period consumer proof',
        recordedAt: atGrant,
      },
      role: 'CONTROLLER',
      scopeRef,
    }),
  );
  yield* owner.recordApplicability(scope.tenantId, legalEntityId, yield* nextId, yield* nextId, applicability);
  yield* owner.assignLegalBasis(
    scope.tenantId,
    legalEntityId,
    yield* nextId,
    yield* Schema.decodeUnknownEffect(PrivacyLegalBasisAssignmentSchema)({
      actor,
      applicabilityDecision: applicability,
      assignmentRef: basisRef,
      basis: 'LEGAL_OBLIGATION',
      basisVersion: '1',
      decision: 'APPROVED',
      effectiveFrom: atGrant,
      effectiveTo: null,
      provenance: {
        decisionEvidenceRefs: ['fixture:basis'],
        policyRef: 'fixture:basis-policy',
        policyVersion: '1',
        reason: 'native period consumer proof',
        recordedAt: atGrant,
      },
      scope: {
        controllerRef: legalEntityId,
        operation: applicabilityScope.operation,
        processingScopeRef: scopeRef,
        purposeRef: original.purpose.purposeRef,
        purposeVersionId: original.grant.scope.purposeVersionRef,
      },
    }),
  );
  yield* owner.upsertRetentionRule(
    scope.tenantId,
    legalEntityId,
    yield* nextId,
    yield* Schema.decodeUnknownEffect(RetentionRuleAuthorityResolutionSchema)({
      asOf: atGrant,
      legalEntityId,
      rule: {
        applicability: 'PROSPECTIVE_ONLY',
        authorityRef: 'fixture:retention-authority',
        businessStartAt: '2026-01-01T00:00:00.000Z',
        businessStartRef: 'fixture:business-start',
        contentScopeRef: 'native-period-proof',
        controllerRef: legalEntityId,
        dispositionOutcome: 'DELETE',
        effectiveFrom: atGrant,
        effectiveTo: null,
        evidenceRefs: ['fixture:retention'],
        policyRef: 'fixture:retention-policy',
        policyVersion: 1,
        provenanceRef: 'fixture:retention-provenance',
        retentionWindow: { durationDays: 365, kind: 'DURATION' },
        retroactiveApprovalRef: null,
        ruleRef: ruleRef.resourceId,
        ruleVersion: 1,
        ruleVersionId,
      },
      status: 'CURRENT',
      tenantId: scope.tenantId,
    }),
  );
  const dataCoverage = [
    {
      dataCategoryRef: category,
      ownerCapability: 'privacy-owner',
      ownerModuleId: 'privacy.core',
      recordContentScope: 'native-period-proof',
      systemOfRecordRef: system,
    },
  ];
  const retentionCoverage = [
    {
      applicabilityDecisionRef: 'fixture:activity-applicability',
      asOf: at,
      controllerRef: controller,
      dataCategoryRefs: [category],
      legalEntityId,
      purposeVersionId: original.grant.scope.purposeVersionRef,
      recordContentScopes: ['native-period-proof'],
      ruleRef,
      ruleVersionId,
      tenantId: scope.tenantId,
    },
  ];
  const processingScope = {
    applicabilityScope,
    purposeRef: original.purpose.purposeRef,
    purposeVersionId: original.grant.scope.purposeVersionRef,
    responsibilityAssignmentRefs: [responsibilityRef],
  };
  const input = yield* Schema.decodeUnknownEffect(CreateProcessingActivityInputSchema)({
    applicabilityDecisions: [applicability],
    dataCategoryRefs: [category],
    dataCoverage,
    legalBasisAssignmentRefs: [basisRef],
    processingScope,
    recipientRefs: [],
    recipientTransfers: [],
    retentionCoverage,
    retentionRuleRefs: [ruleRef],
    systemOfRecordRefs: [system],
  });
  const activity = yield* activities.create(
    scope.tenantId,
    legalEntityId,
    yield* Schema.decodeUnknownEffect(PrivacyResponsibilityAssignmentSchema.fields.actor)(actor),
    yield* nextId,
    input,
  );
  const coverage = yield* Schema.decodeUnknownEffect(ProcessingActivityAuthoritativeCoverageSchema)({
    activityRef: activity.activityRef,
    applicabilityDecisions: [applicability],
    authorityRef: 'fixture:owner-coverage',
    controllerRefs: [controller],
    dataCategoryRefs: [category],
    dataCoverage,
    evidenceRefs: ['fixture:coverage'],
    legalEntityId,
    observedAt: atGrant,
    ownerCapabilityBindings: [
      {
        dataCategoryRef: category,
        ownerCapability: 'privacy-owner',
        ownerModuleId: 'privacy.core',
        systemOfRecordRef: system,
      },
    ],
    processingScope,
    processingScopeRef: scopeRef,
    recipientRefs: [],
    recipientTransfers: [],
    retentionCoverage,
    revision: '1',
    systemOfRecordRefs: [system],
    tenantId: scope.tenantId,
  });
  return {
    activity,
    actor: yield* Schema.decodeUnknownEffect(PrivacyResponsibilityAssignmentSchema.fields.actor)(actor),
    coverage,
  };
});

it.live('uses the same derived exclusive Purpose boundary for native Processing Activity prerequisites', () =>
  Effect.gen(function* nativeActivityBoundary() {
    const native = yield* makeRetainedNative(['privacy.processing_catalog.read']);
    const context = yield* Layer.build(native.layer);
    const original = yield* native.prepareOwner(prepareOriginalConsent).pipe(Effect.provideContext(context));
    yield* native
      .prepareOwner(
        Effect.fn('RetainedWithdrawal.appendActivitySuccessor')(function* appendActivitySuccessor(transaction, scope) {
          const owner = yield* processingPurposeRepositoryForScope(transaction, scope);
          return yield* owner.addVersion(
            scope.tenantId,
            Option.getOrThrow(Option.fromUndefinedOr(scope.legalEntityId)),
            original.purpose.purposeRef.resourceId,
            yield* nextId,
            original.versionInput,
          );
        }),
      )
      .pipe(Effect.provideContext(context));
    for (const at of [atGrant, atEnd, atWithdrawal]) {
      const prepared = yield* native
        .prepareOwner((transaction, scope) => prepareActivity(transaction, scope, original, at))
        .pipe(Effect.provideContext(context));
      const result = yield* native
        .prepareOwner(
          Effect.fn('RetainedWithdrawal.checkActivityBoundary')(function* checkActivityBoundary(transaction, scope) {
            const owner = yield* processingActivityRepositoryForScope(transaction, scope);
            return yield* owner.transition(
              scope.tenantId,
              Option.getOrThrow(Option.fromUndefinedOr(scope.legalEntityId)),
              prepared.activity.activityRef.resourceId,
              prepared.actor,
              yield* nextId,
              'EFFECTIVE',
              ['fixture:activation'],
              at,
              prepared.coverage,
            );
          }),
        )
        .pipe(Effect.provideContext(context), Effect.result);
      expect(Result.isSuccess(result)).toBe(at === atGrant);
      if (Result.isFailure(result)) {
        expect(result.failure).toMatchObject({ code: 'privacy_processing_activity_transition_rejected' });
      }
    }
  }).pipe(Effect.provide(nativeServices)),
);

const appendOriginalSuccessor = Effect.fn('RetainedWithdrawal.appendForControls')(function* appendOriginalSuccessor(
  transaction: ScopedTransactionExecutor,
  scope: OperationalScope,
  original: Effect.Success<ReturnType<typeof prepareOriginalConsent>>,
  invocation: string,
  effectiveFrom = atEnd,
) {
  const owner = yield* processingPurposeRepositoryForScope(transaction, scope);
  return yield* owner.addVersion(
    scope.tenantId,
    Option.getOrThrow(Option.fromUndefinedOr(scope.legalEntityId)),
    original.purpose.purposeRef.resourceId,
    invocation,
    {
      ...original.versionInput,
      effectiveFrom,
      materialChange: {
        ...original.versionInput.materialChange,
        changedAt: effectiveFrom,
        changeRef: `change:${invocation}`,
      },
      meaning: `Successor ${invocation}`,
    },
  );
});

it.live(
  'serializes append-only Purpose retries, rejects competing chronology and rolls back an unsuccessful append',
  () =>
    Effect.gen(function* nativeAppendControls() {
      const native = yield* makeRetainedNative([]);
      const context = yield* Layer.build(native.layer);
      const original = yield* native.prepareOwner(prepareOriginalConsent).pipe(Effect.provideContext(context));
      const invocation = yield* nextId;
      const replays = yield* Effect.all(
        [0, 1].map(() =>
          native
            .prepareOwner((transaction, scope) => appendOriginalSuccessor(transaction, scope, original, invocation))
            .pipe(Effect.provideContext(context)),
        ),
        { concurrency: 2 },
      );
      expect(replays[0]).toEqual(replays[1]);
      expect(replays[0]?.versions).toHaveLength(2);
      const changed = yield* native
        .prepareOwner((transaction, scope) =>
          appendOriginalSuccessor(transaction, scope, original, invocation, atWithdrawal),
        )
        .pipe(Effect.provideContext(context), Effect.result);
      expect(Result.isFailure(changed)).toBe(true);
      if (Result.isFailure(changed)) {
        expect(changed.failure).toMatchObject({ code: 'privacy_purpose_version_conflict' });
      }
      const rollback = yield* native
        .prepareOwner(
          Effect.fn('RetainedWithdrawal.rollbackAppend')(function* rollbackAppend(transaction, scope) {
            yield* appendOriginalSuccessor(transaction, scope, original, yield* nextId, atWithdrawal);
            return yield* new PurposeVersionConflict({
              code: 'privacy_purpose_version_conflict',
              reason: 'Fixture downstream transaction failure',
            });
          }),
        )
        .pipe(Effect.provideContext(context), Effect.result);
      expect(Result.isFailure(rollback)).toBe(true);
      const retainedAfterRollback = yield* native
        .prepareOwner((transaction) =>
          transaction
            .select()
            .from(purposeVersions)
            .where(eq(purposeVersions.processingPurposeId, original.purpose.purposeRef.resourceId)),
        )
        .pipe(Effect.provideContext(context));
      expect(retainedAfterRollback).toHaveLength(2);
      const competing = yield* Effect.all(
        [yield* nextId, yield* nextId].map((id) =>
          native
            .prepareOwner((transaction, scope) =>
              appendOriginalSuccessor(transaction, scope, original, id, atWithdrawal),
            )
            .pipe(Effect.provideContext(context), Effect.result),
        ),
        { concurrency: 2 },
      );
      expect(competing.filter(Result.isSuccess)).toHaveLength(1);
      const loser = competing.find(Result.isFailure);
      expect(loser).toBeDefined();
      if (loser !== undefined && Result.isFailure(loser)) {
        expect(loser.failure).toMatchObject({ code: 'privacy_purpose_version_conflict' });
      }
      const raw = yield* native
        .prepareOwner((transaction) =>
          transaction
            .select()
            .from(purposeVersions)
            .where(eq(purposeVersions.processingPurposeId, original.purpose.purposeRef.resourceId)),
        )
        .pipe(Effect.provideContext(context));
      expect(raw).toHaveLength(3);
      expect(raw.every(({ effectiveTo }) => effectiveTo === null)).toBe(true);
      const mutation = yield* native
        .prepareOwner((transaction) =>
          transaction
            .update(purposeVersions)
            .set({ effectiveTo: new Date(atEnd) })
            .where(eq(purposeVersions.purposeVersionId, original.grant.scope.purposeVersionRef)),
        )
        .pipe(Effect.provideContext(context), Effect.result);
      expect(Result.isFailure(mutation)).toBe(true);
      const deletion = yield* native
        .prepareOwner((transaction) =>
          transaction
            .delete(purposeVersions)
            .where(eq(purposeVersions.purposeVersionId, original.grant.scope.purposeVersionRef)),
        )
        .pipe(Effect.provideContext(context), Effect.result);
      expect(Result.isFailure(deletion)).toBe(true);
      const after = yield* native
        .prepareOwner((transaction) =>
          transaction
            .select()
            .from(purposeVersions)
            .where(eq(purposeVersions.processingPurposeId, original.purpose.purposeRef.resourceId)),
        )
        .pipe(Effect.provideContext(context));
      expect(after).toEqual(raw);
    }).pipe(Effect.provide(nativeServices)),
);

it.live(
  'runs the registered Purpose append and original Consent withdrawal through the actual native public Action boundary',
  () =>
    Effect.gen(function* publicRetainedWithdrawal() {
      const { isolated, snapshot } = yield* makeRetainedIsolation();
      const fixture = yield* Effect.acquireRelease(
        makeLiveOperationFixture({
          actionKeys: [
            addProcessingPurposeVersionAction.descriptor.actionKey,
            recordConsentDecisionAction.descriptor.actionKey,
          ],
          adminConnectionString: Redacted.make(isolated.connections.admin.connectionString),
          authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
          compositionRevision: snapshot.composition.revision,
          moduleKeys: ['privacy.core'],
          runtimeConnectionString: Redacted.make(isolated.connections.runtime.connectionString),
        }),
        (value) => value.close().pipe(Effect.orDie),
      );
      const principal = yield* Schema.decodeUnknownEffect(TrustedPrincipalContextSchema)({
        ...fixture.manager,
        legalEntityId: fixture.legalEntityId,
      });
      const permissions = yield* makeContextPermissionRelationshipMutationLive();
      for (const permission of ['privacy.consent.read', 'privacy.processing_catalog.read']) {
        const target = { moduleId: 'privacy.core', permission };
        yield* permissions.mutate({
          legalEntityId: fixture.legalEntityId,
          operation: 'grant',
          principal,
          target,
          tenantId: fixture.tenantId,
        });
        yield* Effect.addFinalizer(() =>
          permissions
            .mutate({
              legalEntityId: fixture.legalEntityId,
              operation: 'revoke',
              principal,
              target,
              tenantId: fixture.tenantId,
            })
            .pipe(Effect.orDie),
        );
      }
      const context = yield* Layer.build(fixture.layer);
      const original = yield* fixture
        .prepareOwner(prepareOriginalConsent, 'required')
        .pipe(Effect.provideContext(context));
      yield* fixture
        .prepareOwner(
          Effect.fn('RetainedWithdrawal.publicOriginalGrant')(function* publicOriginalGrant(transaction, scope) {
            const owner = yield* privacyOperationRepositoryForScope(transaction, scope);
            return yield* owner.recordConsentDecision(
              scope.tenantId,
              Option.getOrThrow(Option.fromUndefinedOr(scope.legalEntityId)),
              yield* nextId,
              original.grant,
            );
          }),
          'required',
        )
        .pipe(Effect.provideContext(context));
      const businessNow = DateTime.toEpochMillis(yield* DateTime.now);
      expect(businessNow).toBeGreaterThanOrEqual(DateTime.toEpochMillis(snapshot.observedAt));
      expect(businessNow).toBeLessThan(DateTime.toEpochMillis(snapshot.validUntil));
      yield* Effect.gen(function* trustedCurrentBusinessActions() {
        yield* TestClock.setTime(businessNow);
        const appended = yield* runAction({
          payload: { purposeRef: original.purpose.purposeRef, version: original.versionInput },
          principal,
          registration: addProcessingPurposeVersionAction,
          transport: { correlationId: yield* nextId, idempotencyKey: yield* nextId, targetModuleKey: 'privacy.core' },
        }).pipe(Effect.provideContext(context));
        expect(appended.versions[0]?.effectiveTo).toBe(atEnd);
        const actualNow = DateTime.formatIso(yield* DateTime.now);
        const withdrawal = {
          ...original.grant,
          decision: 'WITHDRAWN' as const,
          decisionId: yield* nextId,
          effectiveAt: actualNow,
          recordedAt: actualNow,
        };
        const recorded = yield* runAction({
          payload: { decision: withdrawal },
          principal,
          registration: recordConsentDecisionAction,
          transport: { correlationId: yield* nextId, idempotencyKey: yield* nextId, targetModuleKey: 'privacy.core' },
        }).pipe(Effect.provideContext(context));
        expect(recorded.decision).toBe('WITHDRAWN');
        expect(recorded.effectiveAt).toBe(actualNow);
        expect(recorded.actorEvidence?.actor).toEqual({
          principalId: principal.principalId,
          tenantId: fixture.tenantId,
        });
        const runtime = yield* ReadRuntime.pipe(Effect.provideContext(context));
        const missingModule = yield* runtime
          .runRead({
            input: { scopeRefs: [withdrawal.scope.scopeRef] },
            principal,
            registration: currentConsentRead,
            transport: { correlationId: yield* nextId },
          })
          .pipe(Effect.provideContext(context), Effect.result);
        expect(Result.isFailure(missingModule)).toBe(true);
        if (Result.isFailure(missingModule)) {
          expect(missingModule.failure).toMatchObject({ code: 'read_permission_denied' });
        }
        // This genuine produced Purpose reference supplies exact Privacy module access;
        // the Consent Read itself still targets the module and separately requires its context permission.
        yield* fixture.grantResourceAccess(original.purpose.purposeRef, fixture.manager.principalId, 'reader');
        const consentPermission = { moduleId: 'privacy.core', permission: 'privacy.consent.read' };
        yield* permissions.mutate({
          legalEntityId: fixture.legalEntityId,
          operation: 'revoke',
          principal,
          target: consentPermission,
          tenantId: fixture.tenantId,
        });
        const missingContext = yield* runtime
          .runRead({
            input: { scopeRefs: [withdrawal.scope.scopeRef] },
            principal,
            registration: currentConsentRead,
            transport: { correlationId: yield* nextId },
          })
          .pipe(Effect.provideContext(context), Effect.result);
        expect(Result.isFailure(missingContext)).toBe(true);
        if (Result.isFailure(missingContext)) {
          expect(missingContext.failure).toMatchObject({ code: 'read_permission_denied' });
        }
        yield* permissions.mutate({
          legalEntityId: fixture.legalEntityId,
          operation: 'grant',
          principal,
          target: consentPermission,
          tenantId: fixture.tenantId,
        });
        const current = yield* runtime
          .runRead({
            input: { scopeRefs: [withdrawal.scope.scopeRef] },
            principal,
            registration: currentConsentRead,
            transport: { correlationId: yield* nextId },
          })
          .pipe(Effect.provideContext(context));
        expect(current.items[0]?.resolution).toEqual({ decision: recorded, outcome: 'CURRENT' });
        const rejected = yield* runAction({
          payload: {
            decision: { ...original.grant, decisionId: yield* nextId, effectiveAt: actualNow, recordedAt: actualNow },
          },
          principal,
          registration: recordConsentDecisionAction,
          transport: { correlationId: yield* nextId, idempotencyKey: yield* nextId, targetModuleKey: 'privacy.core' },
        }).pipe(Effect.provideContext(context), Effect.result);
        expect(Result.isFailure(rejected)).toBe(true);
        if (Result.isFailure(rejected)) {
          expect(rejected.failure).toMatchObject({ code: 'privacy_action_rejected' });
        }
      }).pipe(Effect.provide(TestClock.layer()));
    }).pipe(Effect.provide(nativeServices)),
);
