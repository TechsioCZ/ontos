import { describe, expect, it } from 'effect-rstest';
import { Effect, Exit, Schema } from 'effect';

import {
  makeInMemoryProcessingActivityRegistry,
  processingActivityAuthoritativeCoverageIsReady,
} from '../../src/domain/processing-activity-registry.ts';
import type {
  CreateProcessingActivityInput,
  ProcessingActivity,
  ProcessingActivityResolvedPrerequisites,
} from '../../src/domain/processing-activity-registry.ts';
import { PrivacyApplicabilityDecisionSchema } from '../../shared/domain/privacy-applicability.ts';
import { PrivacyLegalBasisAssignmentSchema } from '../../shared/domain/privacy-legal-basis.ts';
import { PrivacyResponsibilityAssignmentSchema } from '../../shared/domain/privacy-responsibility-assignment.ts';
import { PrivacyRetentionRuleVersionSchema } from '../../shared/domain/privacy-retention-rule.ts';
import { CreateProcessingActivityInputSchema } from '../../shared/domain/processing-activity.ts';
import {
  ProcessingActivityAuthoritativeCoverageSchema,
  PersonalDataCoverageSchema,
  ProcessingRetentionReferenceSchema,
} from '../../shared/domain/processing-coverage.ts';

const tenantId = '00000000-0000-4000-8000-000000000001';
const createInvocationId = '00000000-0000-4000-8000-000000000006';
const transitionInvocationId = '00000000-0000-4000-8000-000000000007';
const actor = {
  moduleId: 'core.identity',
  principalId: '00000000-0000-4000-8000-000000000002',
  principalType: 'user',
  tenantId,
} as const;
const purpose = {
  businessCode: 'ACCOUNT_SECURITY' as const,
  createdAt: '2026-01-01T00:00:00Z',
  governanceOwnerId: '00000000-0000-4000-8000-000000000003',
  legalEntityId: '00000000-0000-4000-8000-000000000005',
  lifecycle: 'ACTIVE' as const,
  purposeRef: {
    moduleId: 'privacy.core' as const,
    resourceId: 'purpose-1',
    resourceType: 'privacy.core.processing-purpose' as const,
    tenantId,
  },
  retiredAt: null,
  versions: [
    {
      effectiveFrom: '2026-01-01T00:00:00Z',
      effectiveTo: null,
      materialChangeAssessment: null,
      meaning: 'Protect accounts',
      recordedAt: '2026-01-01T00:00:00Z',
      versionId: '00000000-0000-4000-8000-000000000004',
      versionNumber: 1,
    },
  ],
};
const scope = {
  facts: [
    { dimension: 'CONTROLLER_SCOPE' as const, value: purpose.legalEntityId },
    { dimension: 'PROCESSING_PURPOSE' as const, value: purpose.purposeRef.resourceId },
    { dimension: 'PROCESSING_PURPOSE_VERSION' as const, value: purpose.versions[0].versionId },
  ],
  operation: 'account-security',
  processingScopeRef: { scopeId: 'scope-1', scopeType: 'privacy.processing-scope' as const },
};
const assignment = {
  moduleId: 'privacy.core' as const,
  resourceId: 'assignment-1',
  resourceType: 'privacy.core.privacy-responsibility-assignment' as const,
  tenantId,
};
const applicabilityDecision = Schema.decodeUnknownSync(PrivacyApplicabilityDecisionSchema)({
  authority: {
    controllerRef: {
      moduleId: 'core.identity',
      resourceId: purpose.legalEntityId,
      resourceType: 'core.identity.legal-entity',
      tenantId,
    },
    legalEntityId: purpose.legalEntityId,
    purposeRef: purpose.purposeRef,
    purposeVersionRef: {
      moduleId: 'privacy.core',
      resourceId: purpose.versions[0].versionId,
      resourceType: 'privacy.core.processing-purpose-version',
      tenantId,
    },
    tenantId,
  },
  evaluatedAt: '2026-01-01T00:00:00Z',
  evaluatedScope: scope,
  evidenceRefs: ['policy-evidence'],
  outcome: 'APPLICABLE',
  policyIdentities: [{ policyKey: 'privacy.applicability.eu-eea.v1', policyVersion: '1' }],
  proposedActivity: true,
  reasonCodes: ['explicit_policy_match'],
  responsibilityAssignmentRefs: [assignment],
});

const input: CreateProcessingActivityInput = Schema.decodeUnknownSync(CreateProcessingActivityInputSchema)({
  applicabilityDecisions: [applicabilityDecision],
  dataCategoryRefs: [
    {
      moduleId: 'privacy.core',
      resourceId: 'category:account',
      resourceType: 'privacy.core.data-category',
      tenantId,
    },
  ],
  dataCoverage: [
    Schema.decodeUnknownSync(PersonalDataCoverageSchema)({
      dataCategoryRef: {
        moduleId: 'privacy.core',
        resourceId: 'category:account',
        resourceType: 'privacy.core.data-category',
        tenantId,
      },
      ownerCapability: 'privacy-owner',
      ownerModuleId: 'privacy.core',
      recordContentScope: 'account-security',
      systemOfRecordRef: {
        moduleId: 'privacy.core',
        resourceId: 'system:accounts',
        resourceType: 'privacy.core.system-of-record',
        tenantId,
      },
    }),
  ],
  legalBasisAssignmentRefs: [
    {
      moduleId: 'privacy.core',
      resourceId: 'legal-basis-1',
      resourceType: 'privacy.core.legal-basis-assignment',
      tenantId,
    },
  ],
  processingScope: {
    applicabilityScope: scope,
    purposeRef: purpose.purposeRef,
    purposeVersionId: purpose.versions[0].versionId,
    responsibilityAssignmentRefs: [assignment],
  },
  recipientRefs: [
    {
      moduleId: 'privacy.core',
      resourceId: 'recipient:archive',
      resourceType: 'privacy.core.recipient',
      tenantId,
    },
  ],
  recipientTransfers: [
    {
      dataCategoryRefs: [
        {
          moduleId: 'privacy.core',
          resourceId: 'category:account',
          resourceType: 'privacy.core.data-category',
          tenantId,
        },
      ],
      downstreamSystemRefs: [
        {
          moduleId: 'privacy.core',
          resourceId: 'system:accounts',
          resourceType: 'privacy.core.system-of-record',
          tenantId,
        },
      ],
      recipientTarget: {
        recipientRef: {
          moduleId: 'privacy.core',
          resourceId: 'recipient:archive',
          resourceType: 'privacy.core.recipient',
          tenantId,
        },
      },
      role: 'RECIPIENT',
    },
  ],
  retentionCoverage: [
    Schema.decodeUnknownSync(ProcessingRetentionReferenceSchema)({
      applicabilityDecisionRef: 'policy-evidence',
      asOf: '2026-02-01T00:00:00Z',
      controllerRef: {
        moduleId: 'core.identity',
        resourceId: purpose.legalEntityId,
        resourceType: 'core.identity.legal-entity',
        tenantId,
      },
      dataCategoryRefs: [
        {
          moduleId: 'privacy.core',
          resourceId: 'category:account',
          resourceType: 'privacy.core.data-category',
          tenantId,
        },
      ],
      legalEntityId: purpose.legalEntityId,
      purposeVersionId: purpose.versions[0].versionId,
      recordContentScopes: ['account-security'],
      ruleRef: {
        moduleId: 'privacy.core',
        resourceId: 'retention-rule-1',
        resourceType: 'privacy.core.retention-rule',
        tenantId,
      },
      ruleVersionId: 'retention-version-1',
      tenantId,
    }),
  ],
  retentionRuleRefs: [
    {
      moduleId: 'privacy.core',
      resourceId: 'retention-rule-1',
      resourceType: 'privacy.core.retention-rule',
      tenantId,
    },
  ],
  systemOfRecordRefs: [
    {
      moduleId: 'privacy.core',
      resourceId: 'system:accounts',
      resourceType: 'privacy.core.system-of-record',
      tenantId,
    },
  ],
});

const resolvedPrerequisites = (activity: ProcessingActivity): ProcessingActivityResolvedPrerequisites => ({
  applicabilityDecisions: [applicabilityDecision],
  coverage: Schema.decodeUnknownSync(ProcessingActivityAuthoritativeCoverageSchema)({
    activityRef: activity.activityRef,
    applicabilityDecisions: [applicabilityDecision],
    authorityRef: 'coverage-authority-1',
    controllerRefs: [
      {
        moduleId: 'core.identity',
        resourceId: purpose.legalEntityId,
        resourceType: 'core.identity.legal-entity',
        tenantId,
      },
    ],
    dataCategoryRefs: [
      {
        moduleId: 'privacy.core',
        resourceId: 'category:account',
        resourceType: 'privacy.core.data-category',
        tenantId,
      },
    ],
    dataCoverage: input.dataCoverage ?? [],
    evidenceRefs: ['coverage-evidence-1'],
    legalEntityId: purpose.legalEntityId,
    observedAt: '2026-01-01T00:00:00Z',
    ownerCapabilityBindings: [
      {
        dataCategoryRef: {
          moduleId: 'privacy.core',
          resourceId: 'category:account',
          resourceType: 'privacy.core.data-category',
          tenantId,
        },
        ownerCapability: 'privacy-owner',
        ownerModuleId: 'privacy.core',
        systemOfRecordRef: {
          moduleId: 'privacy.core',
          resourceId: 'system:accounts',
          resourceType: 'privacy.core.system-of-record',
          tenantId,
        },
      },
    ],
    processingScope: input.processingScope,
    processingScopeRef: scope.processingScopeRef,
    recipientRefs: [
      {
        moduleId: 'privacy.core',
        resourceId: 'recipient:archive',
        resourceType: 'privacy.core.recipient',
        tenantId,
      },
    ],
    recipientTransfers: input.recipientTransfers ?? [],
    retentionCoverage: input.retentionCoverage ?? [],
    revision: 'coverage-revision-1',
    systemOfRecordRefs: [
      {
        moduleId: 'privacy.core',
        resourceId: 'system:accounts',
        resourceType: 'privacy.core.system-of-record',
        tenantId,
      },
    ],
    tenantId,
  }),
  legalBasisAssignments: [
    Schema.decodeUnknownSync(PrivacyLegalBasisAssignmentSchema)({
      actor,
      applicabilityDecision,
      assignmentRef: {
        moduleId: 'privacy.core',
        resourceId: 'legal-basis-1',
        resourceType: 'privacy.core.legal-basis-assignment',
        tenantId,
      },
      basis: 'LEGAL_OBLIGATION',
      basisVersion: 'basis-v1',
      decision: 'APPROVED',
      effectiveFrom: '2026-01-01T00:00:00Z',
      effectiveTo: null,
      provenance: {
        decisionEvidenceRefs: ['basis-evidence'],
        policyRef: 'basis-policy',
        policyVersion: '1',
        reason: 'account-security',
        recordedAt: '2026-01-01T00:00:00Z',
      },
      scope: {
        controllerRef: purpose.legalEntityId,
        operation: scope.operation,
        processingScopeRef: scope.processingScopeRef,
        purposeRef: purpose.purposeRef,
        purposeVersionId: purpose.versions[0].versionId,
      },
    }),
  ],
  purpose,
  purposeVersion: purpose.versions[0],
  responsibilities: [
    Schema.decodeUnknownSync(PrivacyResponsibilityAssignmentSchema)({
      actor,
      assignmentRef: assignment,
      effectiveFrom: '2026-01-01T00:00:00Z',
      effectiveTo: null,
      holder: {
        holder: {
          moduleId: 'core.identity',
          resourceId: purpose.legalEntityId,
          resourceType: 'core.identity.legal-entity',
          tenantId,
        },
        holderKind: 'LEGAL_ENTITY',
      },
      provenance: {
        decisionEvidenceRefs: ['responsibility-evidence'],
        reason: 'account-security',
        recordedAt: '2026-01-01T00:00:00Z',
      },
      role: 'CONTROLLER',
      scopeRef: scope.processingScopeRef,
    }),
  ],
  retentionRules: [
    Schema.decodeUnknownSync(PrivacyRetentionRuleVersionSchema)({
      applicability: 'PROSPECTIVE_ONLY',
      authorityRef: 'retention-authority',
      businessStartAt: '2025-12-01T00:00:00Z',
      businessStartRef: 'account-created',
      contentScopeRef: 'account-security',
      controllerRef: purpose.legalEntityId,
      dispositionOutcome: 'DELETE',
      effectiveFrom: '2026-01-01T00:00:00Z',
      effectiveTo: null,
      evidenceRefs: ['retention-evidence-1'],
      policyRef: 'retention-policy-1',
      policyVersion: 1,
      provenanceRef: 'retention-provenance-1',
      retentionWindow: { durationDays: 365, kind: 'DURATION' },
      retroactiveApprovalRef: null,
      ruleRef: 'retention-rule-1',
      ruleVersion: 1,
      ruleVersionId: 'retention-version-1',
    }),
  ],
});

describe('Processing Activity registry', () => {
  it.effect('keeps a proposed activity distinct until complete approved inputs activate it', () =>
    Effect.gen(function* rejectsIncompleteActivation() {
      const registry = makeInMemoryProcessingActivityRegistry();
      const created = yield* registry.create(tenantId, purpose.legalEntityId, actor, createInvocationId, {
        ...input,
        legalBasisAssignmentRefs: [],
        retentionRuleRefs: [],
      });
      expect(created.currentLifecycle).toBe('PROPOSED');
      const transition = yield* Effect.exit(
        registry.transition(
          tenantId,
          purpose.legalEntityId,
          created.activityRef.resourceId,
          actor,
          transitionInvocationId,
          'EFFECTIVE',
          ['approval-1'],
          '2026-02-01T00:00:00Z',
        ),
      );
      expect(Exit.isFailure(transition)).toBe(true);
    }),
  );

  it.effect('rejects a Processing Purpose reference from another tenant before persistence', () =>
    Effect.gen(function* rejectsCrossTenantPurpose() {
      const registry = makeInMemoryProcessingActivityRegistry();
      const result = yield* Effect.exit(
        registry.create(tenantId, purpose.legalEntityId, actor, createInvocationId, {
          ...input,
          processingScope: {
            ...input.processingScope,
            purposeRef: { ...purpose.purposeRef, tenantId: '00000000-0000-4000-8000-000000000099' },
          },
        }),
      );
      expect(Exit.isFailure(result)).toBe(true);
    }),
  );

  it.effect('rejects Legal Basis and Retention Rule references from another tenant before persistence', () =>
    Effect.gen(function* rejectsCrossTenantPrerequisites() {
      const registry = makeInMemoryProcessingActivityRegistry();
      const foreignTenantId = '00000000-0000-4000-8000-000000000099';
      const foreignLegalBasisInput = Schema.decodeUnknownSync(CreateProcessingActivityInputSchema)({
        ...input,
        legalBasisAssignmentRefs: input.legalBasisAssignmentRefs?.map((reference) => ({
          ...reference,
          tenantId: foreignTenantId,
        })),
      });
      const foreignRetentionInput = Schema.decodeUnknownSync(CreateProcessingActivityInputSchema)({
        ...input,
        retentionRuleRefs: input.retentionRuleRefs?.map((reference) => ({
          ...reference,
          tenantId: foreignTenantId,
        })),
      });
      const legalBasisResult = yield* Effect.exit(
        registry.create(tenantId, purpose.legalEntityId, actor, createInvocationId, foreignLegalBasisInput),
      );
      const retentionResult = yield* Effect.exit(
        registry.create(tenantId, purpose.legalEntityId, actor, createInvocationId, foreignRetentionInput),
      );
      expect(Exit.isFailure(legalBasisResult)).toBe(true);
      expect(Exit.isFailure(retentionResult)).toBe(true);
    }),
  );

  it.effect('requires bijective full typed coverage references and owner bindings', () =>
    Effect.gen(function* rejectsNonExactCoverage() {
      const registry = makeInMemoryProcessingActivityRegistry();
      const activity = yield* registry.create(tenantId, purpose.legalEntityId, actor, createInvocationId, input);
      const prerequisites = resolvedPrerequisites(activity);
      const { coverage } = prerequisites;

      expect(
        processingActivityAuthoritativeCoverageIsReady(
          activity,
          coverage,
          prerequisites.responsibilities,
          '2026-02-01T00:00:00Z',
          prerequisites.retentionRules,
        ),
      ).toBe(true);
      expect(
        processingActivityAuthoritativeCoverageIsReady(
          activity,
          coverage,
          prerequisites.responsibilities,
          '2026-02-01T00:00:00Z',
        ),
      ).toBe(false);
      expect(
        processingActivityAuthoritativeCoverageIsReady(
          activity,
          { ...coverage, dataCategoryRefs: [...coverage.dataCategoryRefs, ...coverage.dataCategoryRefs.slice(0, 1)] },
          prerequisites.responsibilities,
          '2026-02-01T00:00:00Z',
          prerequisites.retentionRules,
        ),
      ).toBe(false);
      expect(
        processingActivityAuthoritativeCoverageIsReady(
          activity,
          { ...coverage, dataCoverage: [] },
          prerequisites.responsibilities,
          '2026-02-01T00:00:00Z',
          prerequisites.retentionRules,
        ),
      ).toBe(false);
      expect(
        processingActivityAuthoritativeCoverageIsReady(
          activity,
          { ...coverage, retentionCoverage: [] },
          prerequisites.responsibilities,
          '2026-02-01T00:00:00Z',
          prerequisites.retentionRules,
        ),
      ).toBe(false);
      expect(
        processingActivityAuthoritativeCoverageIsReady(
          activity,
          {
            ...coverage,
            retentionCoverage: [...coverage.retentionCoverage, coverage.retentionCoverage[0]],
          },
          prerequisites.responsibilities,
          '2026-02-01T00:00:00Z',
          prerequisites.retentionRules,
        ),
      ).toBe(false);
      expect(
        processingActivityAuthoritativeCoverageIsReady(
          activity,
          Schema.decodeUnknownSync(ProcessingActivityAuthoritativeCoverageSchema)({
            ...coverage,
            retentionCoverage: [{ ...coverage.retentionCoverage[0], ruleVersionId: 'retention-version-foreign' }],
          }),
          prerequisites.responsibilities,
          '2026-02-01T00:00:00Z',
          prerequisites.retentionRules,
        ),
      ).toBe(false);
      expect(
        processingActivityAuthoritativeCoverageIsReady(
          activity,
          {
            ...coverage,
            retentionCoverage: [
              {
                ...coverage.retentionCoverage[0],
                applicabilityDecisionRef: 'evidence:foreign',
                asOf: '2026-02-02T00:00:00Z',
              },
            ],
          },
          prerequisites.responsibilities,
          '2026-02-01T00:00:00Z',
          prerequisites.retentionRules,
        ),
      ).toBe(false);

      const wrongModule = Schema.decodeUnknownSync(ProcessingActivityAuthoritativeCoverageSchema)({
        ...coverage,
        dataCategoryRefs: [{ ...coverage.dataCategoryRefs[0], moduleId: 'other.owner' }],
      });
      const wrongType = Schema.decodeUnknownSync(ProcessingActivityAuthoritativeCoverageSchema)({
        ...coverage,
        dataCategoryRefs: [{ ...coverage.dataCategoryRefs[0], resourceType: 'other.owner.data-category' }],
      });
      const wrongTenant = Schema.decodeUnknownSync(ProcessingActivityAuthoritativeCoverageSchema)({
        ...coverage,
        dataCategoryRefs: [{ ...coverage.dataCategoryRefs[0], tenantId: '00000000-0000-4000-8000-000000000099' }],
      });
      const wrongOwner = Schema.decodeUnknownSync(ProcessingActivityAuthoritativeCoverageSchema)({
        ...coverage,
        ownerCapabilityBindings: [{ ...coverage.ownerCapabilityBindings[0], ownerModuleId: 'other.owner' }],
      });
      const wrongRecipient = Schema.decodeUnknownSync(ProcessingActivityAuthoritativeCoverageSchema)({
        ...coverage,
        recipientRefs: [{ ...coverage.recipientRefs[0], resourceType: 'other.owner.recipient' }],
      });
      const wrongTransfer = Schema.decodeUnknownSync(ProcessingActivityAuthoritativeCoverageSchema)({
        ...coverage,
        recipientTransfers: [
          {
            ...coverage.recipientTransfers[0],
            dataCategoryRefs: [{ ...coverage.recipientTransfers[0].dataCategoryRefs[0], moduleId: 'other.owner' }],
          },
        ],
      });
      const duplicateTransferReference = Schema.decodeUnknownSync(ProcessingActivityAuthoritativeCoverageSchema)({
        ...coverage,
        recipientTransfers: [
          {
            ...coverage.recipientTransfers[0],
            dataCategoryRefs: [
              ...coverage.recipientTransfers[0].dataCategoryRefs,
              coverage.recipientTransfers[0].dataCategoryRefs[0],
            ],
          },
        ],
      });
      for (const invalidCoverage of [
        wrongModule,
        wrongType,
        wrongTenant,
        wrongOwner,
        wrongRecipient,
        wrongTransfer,
        duplicateTransferReference,
      ]) {
        expect(
          processingActivityAuthoritativeCoverageIsReady(
            activity,
            invalidCoverage,
            prerequisites.responsibilities,
            '2026-02-01T00:00:00Z',
            prerequisites.retentionRules,
          ),
        ).toBe(false);
      }
    }),
  );

  it.effect(
    'rejects applicability authority for another controller, purpose, version, tenant, legal entity, or time',
    () =>
      Effect.gen(function* rejectsForeignApplicabilityAuthority() {
        const registry = makeInMemoryProcessingActivityRegistry();
        const activity = yield* registry.create(tenantId, purpose.legalEntityId, actor, createInvocationId, input);
        const prerequisites = resolvedPrerequisites(activity);
        const baseAuthority = applicabilityDecision.authority;
        expect(baseAuthority).toBeDefined();
        if (baseAuthority === undefined) {
          return;
        }
        const decisions = [
          {
            ...applicabilityDecision,
            authority: {
              ...baseAuthority,
              controllerRef: { ...baseAuthority.controllerRef, resourceId: 'controller:foreign' },
            },
          },
          {
            ...applicabilityDecision,
            authority: { ...baseAuthority, purposeRef: { ...baseAuthority.purposeRef, resourceId: 'purpose:foreign' } },
          },
          {
            ...applicabilityDecision,
            authority: {
              ...baseAuthority,
              purposeVersionRef: {
                ...baseAuthority.purposeVersionRef,
                resourceId: '00000000-0000-4000-8000-000000000099',
              },
            },
          },
          {
            ...applicabilityDecision,
            authority: { ...baseAuthority, tenantId: '00000000-0000-4000-8000-000000000098' },
          },
          {
            ...applicabilityDecision,
            authority: { ...baseAuthority, legalEntityId: '00000000-0000-4000-8000-000000000097' },
          },
          { ...applicabilityDecision, evaluatedAt: '2026-03-01T00:00:00Z' },
        ];

        for (const undecodedForeignDecision of decisions) {
          const foreignDecision = Schema.decodeUnknownSync(PrivacyApplicabilityDecisionSchema)(
            undecodedForeignDecision,
          );
          const foreignPrerequisites = {
            ...prerequisites,
            applicabilityDecisions: [foreignDecision],
            coverage: { ...prerequisites.coverage, applicabilityDecisions: [foreignDecision] },
          };
          const foreignRegistry = makeInMemoryProcessingActivityRegistry({
            resolvePrerequisites: () => Effect.succeed(foreignPrerequisites),
          });
          const foreignActivity = yield* foreignRegistry.create(
            tenantId,
            purpose.legalEntityId,
            actor,
            createInvocationId,
            input,
          );
          const transition = yield* Effect.exit(
            foreignRegistry.transition(
              tenantId,
              purpose.legalEntityId,
              foreignActivity.activityRef.resourceId,
              actor,
              transitionInvocationId,
              'EFFECTIVE',
              ['approval-1'],
              '2026-02-01T00:00:00Z',
            ),
          );
          expect(Exit.isFailure(transition)).toBe(true);
        }
      }),
  );

  it.effect('does not resurrect an older APPLICABLE decision after a newer exact-scope UNRESOLVED decision', () =>
    Effect.gen(function* rejectsStaleApplicableDecision() {
      const registry = makeInMemoryProcessingActivityRegistry({
        resolvePrerequisites: (activity) => {
          const prerequisites = resolvedPrerequisites(activity);
          const newerUnresolved = Schema.decodeUnknownSync(PrivacyApplicabilityDecisionSchema)({
            ...applicabilityDecision,
            evaluatedAt: '2026-01-15T00:00:00Z',
            outcome: 'UNRESOLVED',
            reasonCodes: ['policy_not_effective'],
          });
          const decisions = [applicabilityDecision, newerUnresolved];
          return Effect.succeed({
            ...prerequisites,
            applicabilityDecisions: decisions,
            coverage: { ...prerequisites.coverage, applicabilityDecisions: decisions },
          });
        },
      });
      const created = yield* registry.create(tenantId, purpose.legalEntityId, actor, createInvocationId, input);
      const transition = yield* Effect.exit(
        registry.transition(
          tenantId,
          purpose.legalEntityId,
          created.activityRef.resourceId,
          actor,
          transitionInvocationId,
          'EFFECTIVE',
          ['approval-1'],
          '2026-02-01T00:00:00Z',
        ),
      );
      expect(Exit.isFailure(transition)).toBe(true);
    }),
  );

  it('rejects foreign module and resource-type aliases in prerequisite references', () => {
    expect(() =>
      Schema.decodeUnknownSync(CreateProcessingActivityInputSchema)({
        ...input,
        legalBasisAssignmentRefs: [
          {
            ...input.legalBasisAssignmentRefs?.[0],
            moduleId: 'foreign.module',
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(CreateProcessingActivityInputSchema)({
        ...input,
        retentionRuleRefs: [
          {
            ...input.retentionRuleRefs?.[0],
            resourceType: 'foreign.retention-rule',
          },
        ],
      }),
    ).toThrow();
  });

  it.effect('requires explicit applicability and prevents resurrection after ending', () =>
    Effect.gen(function* preventsResurrection() {
      const registry = makeInMemoryProcessingActivityRegistry({
        resolvePrerequisites: (activity) => Effect.succeed(resolvedPrerequisites(activity)),
      });
      const created = yield* registry.create(tenantId, purpose.legalEntityId, actor, createInvocationId, input);
      const effective = yield* registry.transition(
        tenantId,
        purpose.legalEntityId,
        created.activityRef.resourceId,
        actor,
        transitionInvocationId,
        'EFFECTIVE',
        ['approval-1'],
        '2026-02-01T00:00:00Z',
      );
      const ended = yield* registry.transition(
        tenantId,
        purpose.legalEntityId,
        effective.activityRef.resourceId,
        actor,
        '00000000-0000-4000-8000-000000000008',
        'ENDED',
        ['end-1'],
        '2026-03-01T00:00:00Z',
      );
      expect(ended.currentLifecycle).toBe('ENDED');
      const resurrection = yield* Effect.exit(
        registry.transition(
          tenantId,
          purpose.legalEntityId,
          ended.activityRef.resourceId,
          actor,
          '00000000-0000-4000-8000-000000000009',
          'EFFECTIVE',
          ['resurrection'],
          '2026-04-01T00:00:00Z',
        ),
      );
      expect(Exit.isFailure(resurrection)).toBe(true);
    }),
  );

  it.effect('rejects lifecycle jumps outside the governed transition matrix', () =>
    Effect.gen(function* rejectsInvalidLifecycleJump() {
      const registry = makeInMemoryProcessingActivityRegistry();
      const created = yield* registry.create(tenantId, purpose.legalEntityId, actor, createInvocationId, input);
      const rejected = yield* Effect.exit(
        registry.transition(
          tenantId,
          purpose.legalEntityId,
          created.activityRef.resourceId,
          actor,
          transitionInvocationId,
          'SUSPENDED',
          ['suspension-evidence'],
          '2026-02-01T00:00:00Z',
        ),
      );
      expect(Exit.isFailure(rejected)).toBe(true);
    }),
  );
});
