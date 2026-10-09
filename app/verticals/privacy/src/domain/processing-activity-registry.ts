import { randomUUID } from 'node:crypto';
import { DateTime, Effect, Option, Schema } from 'effect';

import type { PrincipalRef } from '@app/core-runtime';
import {
  latestPrivacyApplicabilityDecisionsForExactAuthorities,
  PrivacyApplicabilityDecisionSchema,
  PrivacyApplicabilityScopeSchema,
} from '../../shared/domain/privacy-applicability.ts';
import type { PrivacyApplicabilityDecision } from '../../shared/domain/privacy-applicability.ts';
import type { PrivacyLegalBasisAssignment } from '../../shared/domain/privacy-legal-basis.ts';
import { validatePrivacyRetentionRuleVersion } from '../../shared/domain/privacy-retention-rule.ts';
import type { PrivacyRetentionRuleVersion } from '../../shared/domain/privacy-retention-rule.ts';
import type { PrivacyResponsibilityAssignmentSchema } from '../../shared/domain/privacy-responsibility-assignment.ts';
import {
  PersonalDataCoverageSchema,
  ProcessingActivityOwnerCapabilityBindingSchema,
  ProcessingRetentionReferenceSchema,
} from '../../shared/domain/processing-coverage.ts';
import type {
  ProcessingActivityAuthoritativeCoverage,
  ProcessingActivityAuthorityScope,
  ProcessingActivityOwnerCapabilityBinding,
  ProcessingRecipientTransfer,
} from '../../shared/domain/processing-coverage.ts';
import type { ProcessingPurpose, PurposeVersion } from '../../shared/domain/processing-purpose.ts';
import type {
  CreateProcessingActivityInput,
  ProcessingActivity,
  ProcessingActivityLifecycle,
  ProcessingActivityLifecycleEvent,
} from '../../shared/domain/processing-activity.ts';
import { processingActivityInputForeignReferenceReason } from '../../shared/domain/processing-activity.ts';
import type { ProcessingActivityRef } from '../../shared/resources/processing-activity.ts';
import { LegalBasisAssignmentRefSchema } from '../../shared/resources/legal-basis-assignment.ts';
import { ProcessingPurposeRefSchema } from '../../shared/resources/processing-purpose.ts';
import { PrivacyResponsibilityAssignmentRefSchema } from '../../shared/resources/privacy-responsibility-assignment.ts';
import type { ProcessingActivityRepositoryService } from '../persistence/processing-activity-repository.ts';

export type {
  CreateProcessingActivityInput,
  ProcessingActivity,
  ProcessingActivityLifecycle,
} from '../../shared/domain/processing-activity.ts';

export class ProcessingActivityRegistryError extends Schema.TaggedError<ProcessingActivityRegistryError>()(
  'ProcessingActivityRegistryError',
  {
    code: Schema.Literals([
      'privacy_processing_activity_not_found',
      'privacy_processing_activity_persistence_unavailable',
      'privacy_processing_activity_transition_rejected',
    ]),
    reason: Schema.String,
  },
) {}

const privacyModuleId = 'privacy.core';
const legalEntityModuleId = 'core.identity';
const legalEntityResourceType = 'core.identity.legal-entity';
const activityRef = (tenantId: string, resourceId: string): ProcessingActivityRef => ({
  moduleId: privacyModuleId,
  resourceId,
  resourceType: 'privacy.core.processing-activity',
  tenantId,
});

type PrivacyResponsibilityAssignment = typeof PrivacyResponsibilityAssignmentSchema.Type;

export interface ProcessingActivityResolvedPrerequisites {
  readonly applicabilityDecisions: readonly PrivacyApplicabilityDecision[];
  readonly coverage: ProcessingActivityAuthoritativeCoverage;
  readonly legalBasisAssignments: readonly PrivacyLegalBasisAssignment[];
  readonly purpose: ProcessingPurpose;
  readonly purposeVersion: PurposeVersion;
  readonly responsibilities: readonly PrivacyResponsibilityAssignment[];
  readonly retentionRules: readonly PrivacyRetentionRuleVersion[];
}

interface InMemoryProcessingActivityRegistryConfiguration {
  readonly resolvePrerequisites?: (
    activity: ProcessingActivity,
    asOf: string,
    authoritativeCoverage?: ProcessingActivityAuthoritativeCoverage,
  ) => Effect.Effect<ProcessingActivityResolvedPrerequisites, ProcessingActivityRegistryError>;
}

export type ProcessingActivityPrerequisiteResolver = (
  activity: ProcessingActivity,
  asOf: string,
  authoritativeCoverage?: ProcessingActivityAuthoritativeCoverage,
) => Effect.Effect<ProcessingActivityResolvedPrerequisites, ProcessingActivityRegistryError>;

const sameApplicabilityScope = Schema.toEquivalence(PrivacyApplicabilityScopeSchema);
const decisionEquivalent = Schema.toEquivalence(PrivacyApplicabilityDecisionSchema);
const dataCoverageEquivalent = Schema.toEquivalence(PersonalDataCoverageSchema);
const ownerCapabilityBindingEquivalent = Schema.toEquivalence(ProcessingActivityOwnerCapabilityBindingSchema);
const samePurposeRef = Schema.toEquivalence(ProcessingPurposeRefSchema);
const sameResponsibilityRef = Schema.toEquivalence(PrivacyResponsibilityAssignmentRefSchema);
const sameLegalBasisRef = Schema.toEquivalence(LegalBasisAssignmentRefSchema);
type OwnerReference = Readonly<{
  moduleId: string;
  resourceId: string;
  resourceType: string;
  tenantId: string;
}>;

const sameOwnerRef = (left: OwnerReference, right: OwnerReference): boolean =>
  left.moduleId === right.moduleId &&
  left.resourceId === right.resourceId &&
  left.resourceType === right.resourceType &&
  left.tenantId === right.tenantId;
const sameRecordSet = <Value>(
  left: readonly Value[],
  right: readonly Value[],
  equivalent: (left: Value, right: Value) => boolean,
): boolean => {
  if (left.length !== right.length) {
    return false;
  }
  const isUnique = (values: readonly Value[]): boolean =>
    values.every((value, index) => values.slice(index + 1).every((candidate) => !equivalent(value, candidate)));
  if (!isUnique(left) || !isUnique(right)) {
    return false;
  }
  const usedRightIndexes = new Set<number>();
  for (const value of left) {
    const matchingRightIndex = right.findIndex(
      (candidate, index) => !usedRightIndexes.has(index) && equivalent(value, candidate),
    );
    if (matchingRightIndex === -1) {
      return false;
    }
    usedRightIndexes.add(matchingRightIndex);
  }
  return usedRightIndexes.size === right.length;
};
const sameStringSet = (left: readonly string[], right: readonly string[]): boolean =>
  sameRecordSet([...new Set(left)], [...new Set(right)], (leftValue, rightValue) => leftValue === rightValue);
const currentAtNullable = (effectiveFrom: string, effectiveTo: string | null, asOf: string): boolean =>
  effectiveFrom <= asOf && (effectiveTo === null || asOf < effectiveTo);
const currentAtOption = (effectiveFrom: string, effectiveTo: Option.Option<string>, asOf: string): boolean =>
  effectiveFrom <= asOf && (Option.isNone(effectiveTo) || asOf < effectiveTo.value);

const hasCurrentController = (
  activity: ProcessingActivity,
  responsibilities: readonly PrivacyResponsibilityAssignment[],
  asOf: string,
): boolean =>
  responsibilities.some(
    (assignment) =>
      assignment.role === 'CONTROLLER' &&
      activity.processingScope.responsibilityAssignmentRefs.some((reference) =>
        sameResponsibilityRef(reference, assignment.assignmentRef),
      ) &&
      assignment.scopeRef.scopeId === activity.processingScope.applicabilityScope.processingScopeRef.scopeId &&
      assignment.scopeRef.scopeType === activity.processingScope.applicabilityScope.processingScopeRef.scopeType &&
      currentAtOption(assignment.effectiveFrom, assignment.effectiveTo, asOf),
  );

const currentResponsibilities = (
  activity: ProcessingActivity,
  responsibilities: readonly PrivacyResponsibilityAssignment[],
  asOf: string,
): readonly PrivacyResponsibilityAssignment[] =>
  responsibilities.filter(
    (assignment) =>
      activity.processingScope.responsibilityAssignmentRefs.some((reference) =>
        sameResponsibilityRef(reference, assignment.assignmentRef),
      ) &&
      assignment.scopeRef.scopeId === activity.processingScope.applicabilityScope.processingScopeRef.scopeId &&
      currentAtOption(assignment.effectiveFrom, assignment.effectiveTo, asOf),
  );

const currentControllerRefs = (
  activity: ProcessingActivity,
  responsibilities: readonly PrivacyResponsibilityAssignment[],
  asOf: string,
): readonly Readonly<{ moduleId: string; resourceId: string; resourceType: string; tenantId: string }>[] => {
  const controllerRefs: Readonly<{
    moduleId: string;
    resourceId: string;
    resourceType: string;
    tenantId: string;
  }>[] = [];
  for (const { holder, role } of currentResponsibilities(activity, responsibilities, asOf)) {
    if (role === 'CONTROLLER') {
      controllerRefs.push(holder.holder);
    }
  }
  return controllerRefs;
};

const currentLegalBasis = (
  activity: ProcessingActivity,
  legalBasisAssignments: readonly PrivacyLegalBasisAssignment[],
  controllers: readonly OwnerReference[],
  asOf: string,
): readonly PrivacyLegalBasisAssignment[] =>
  legalBasisAssignments.filter((assignment) => {
    const authorityController = assignment.applicabilityDecision.authority?.controllerRef;
    return [
      activity.legalBasisAssignmentRefs.some((reference) => sameLegalBasisRef(reference, assignment.assignmentRef)),
      assignment.decision === 'APPROVED',
      assignment.applicabilityDecision.outcome === 'APPLICABLE',
      assignment.assignmentRef.tenantId === activity.activityRef.tenantId,
      assignment.scope.operation === activity.processingScope.applicabilityScope.operation,
      assignment.scope.processingScopeRef.scopeId ===
        activity.processingScope.applicabilityScope.processingScopeRef.scopeId,
      assignment.scope.processingScopeRef.scopeType ===
        activity.processingScope.applicabilityScope.processingScopeRef.scopeType,
      samePurposeRef(assignment.scope.purposeRef, activity.processingScope.purposeRef),
      assignment.scope.purposeVersionId === activity.processingScope.purposeVersionId,
      authorityController !== undefined,
      authorityController?.resourceId === assignment.scope.controllerRef,
      authorityController !== undefined &&
        controllers.some((controller) => sameOwnerRef(controller, authorityController)),
      assignment.applicabilityDecision.authority?.tenantId === activity.activityRef.tenantId,
      assignment.applicabilityDecision.authority?.legalEntityId === activity.legalEntityId,
      currentAtNullable(assignment.effectiveFrom, assignment.effectiveTo, asOf),
    ].every(Boolean);
  });

const currentRetention = (
  activity: ProcessingActivity,
  retentionRules: readonly PrivacyRetentionRuleVersion[],
  asOf: string,
): readonly PrivacyRetentionRuleVersion[] =>
  retentionRules.filter(
    (rule) =>
      validatePrivacyRetentionRuleVersion(rule).valid &&
      activity.retentionRuleRefs.some(
        (reference) =>
          reference.moduleId === privacyModuleId &&
          reference.resourceType === 'privacy.core.retention-rule' &&
          reference.tenantId === activity.activityRef.tenantId &&
          reference.resourceId === rule.ruleRef,
      ) &&
      currentAtOption(rule.effectiveFrom, rule.effectiveTo, asOf),
  );

const latestApplicableDecisions = (
  activity: ProcessingActivity,
  applicabilityDecisions: readonly PrivacyApplicabilityDecision[],
  asOf: string,
): readonly PrivacyApplicabilityDecision[] =>
  latestPrivacyApplicabilityDecisionsForExactAuthorities(
    applicabilityDecisions,
    activity.processingScope.applicabilityScope,
    asOf,
  );

const applicabilityDecisionMatchesActivity = (
  activity: ProcessingActivity,
  decision: PrivacyApplicabilityDecision,
  currentControllers: readonly OwnerReference[],
  asOf: string,
): boolean => {
  const { authority } = decision;
  if (authority === undefined) {
    return false;
  }
  return [
    decision.outcome === 'APPLICABLE',
    decision.evaluatedAt <= asOf,
    sameApplicabilityScope(decision.evaluatedScope, activity.processingScope.applicabilityScope),
    authority.tenantId === activity.activityRef.tenantId,
    authority.legalEntityId === activity.legalEntityId,
    authority.controllerRef.tenantId === activity.activityRef.tenantId,
    currentControllers.some((controller) => sameOwnerRef(controller, authority.controllerRef)),
    samePurposeRef(authority.purposeRef, activity.processingScope.purposeRef),
    authority.purposeVersionRef.moduleId === privacyModuleId,
    authority.purposeVersionRef.resourceType === 'privacy.core.processing-purpose-version',
    authority.purposeVersionRef.tenantId === activity.activityRef.tenantId,
    authority.purposeVersionRef.resourceId === activity.processingScope.purposeVersionId,
    sameRecordSet(
      decision.responsibilityAssignmentRefs,
      activity.processingScope.responsibilityAssignmentRefs,
      sameOwnerRef,
    ),
  ].every(Boolean);
};

const applicabilityIsAuthoritative = (
  activity: ProcessingActivity,
  storedDecisions: readonly PrivacyApplicabilityDecision[],
  coverage: ProcessingActivityAuthoritativeCoverage,
  responsibilities: readonly PrivacyResponsibilityAssignment[],
  asOf: string,
): boolean => {
  const currentControllers = currentControllerRefs(activity, responsibilities, asOf);
  const authoritative = latestApplicableDecisions(activity, coverage.applicabilityDecisions, asOf);
  const stored = latestApplicableDecisions(activity, storedDecisions, asOf);
  const authoritativeControllerRefs = authoritative.flatMap(({ authority }) =>
    authority === undefined ? [] : [authority.controllerRef],
  );
  return (
    currentControllers.length > 0 &&
    sameRecordSet(authoritative, stored, decisionEquivalent) &&
    sameRecordSet(authoritativeControllerRefs, currentControllers, sameOwnerRef) &&
    authoritative.every((decision) =>
      applicabilityDecisionMatchesActivity(activity, decision, currentControllers, asOf),
    )
  );
};

type RetentionCoverageEntryValues = Readonly<{
  readonly activityRetention: ProcessingActivity['retentionCoverage'][number];
  readonly controller: OwnerReference;
  readonly decision: PrivacyApplicabilityDecision;
  readonly expectedDataCategoryRefs: readonly OwnerReference[];
  readonly rule: PrivacyRetentionRuleVersion;
}>;

const retentionCoverageEntryValues = (
  activity: ProcessingActivity,
  matchingDecisions: readonly PrivacyApplicabilityDecision[],
  controllers: readonly OwnerReference[],
  currentRules: readonly PrivacyRetentionRuleVersion[],
  retention: ProcessingActivityAuthoritativeCoverage['retentionCoverage'][number],
): RetentionCoverageEntryValues | undefined => {
  const activityRetention = activity.retentionCoverage.find((candidate) =>
    Schema.toEquivalence(ProcessingRetentionReferenceSchema)(candidate, retention),
  );
  const controller = controllers.find((candidate) => sameOwnerRef(candidate, retention.controllerRef));
  const decision =
    controller === undefined
      ? undefined
      : matchingDecisions.find(
          ({ authority, evidenceRefs }) =>
            authority !== undefined &&
            sameOwnerRef(authority.controllerRef, controller) &&
            evidenceRefs.includes(retention.applicabilityDecisionRef),
        );
  const rule = currentRules.find(
    (candidate) =>
      candidate.ruleRef === retention.ruleRef.resourceId &&
      candidate.ruleVersionId === retention.ruleVersionId &&
      candidate.controllerRef === retention.controllerRef.resourceId,
  );
  if (activityRetention === undefined || controller === undefined || decision === undefined || rule === undefined) {
    return undefined;
  }
  return {
    activityRetention,
    controller,
    decision,
    expectedDataCategoryRefs: activity.dataCoverage.flatMap(({ dataCategoryRef, recordContentScope }) =>
      recordContentScope === rule.contentScopeRef ? [dataCategoryRef] : [],
    ),
    rule,
  };
};

const retentionCoverageEntryMatches = (
  activity: ProcessingActivity,
  asOf: string,
  retention: ProcessingActivityAuthoritativeCoverage['retentionCoverage'][number],
  activityRetention: ProcessingActivity['retentionCoverage'][number],
  controller: OwnerReference,
  decision: PrivacyApplicabilityDecision,
  expectedDataCategoryRefs: readonly OwnerReference[],
  rule: PrivacyRetentionRuleVersion,
): boolean =>
  [
    retention.asOf === asOf,
    retention.tenantId === activity.activityRef.tenantId,
    retention.legalEntityId === activity.legalEntityId,
    retention.purposeVersionId === activity.processingScope.purposeVersionId,
    retention.recordContentScopes.length === 1,
    rule.contentScopeRef === retention.recordContentScopes[0],
    expectedDataCategoryRefs.length > 0,
    sameOwnerRef(retention.ruleRef, activityRetention.ruleRef),
    retention.ruleVersionId === activityRetention.ruleVersionId,
    sameOwnerRef(retention.controllerRef, controller),
    sameRecordSet(retention.dataCategoryRefs, expectedDataCategoryRefs, sameOwnerRef),
    sameRecordSet(retention.recordContentScopes, [rule.contentScopeRef], (a, b) => a === b),
    decision.evidenceRefs.filter((ref) => ref === retention.applicabilityDecisionRef).length === 1,
    decision.authority !== undefined,
    decision.authority === undefined || sameOwnerRef(decision.authority.controllerRef, retention.controllerRef),
    decision.authority === undefined || decision.authority.tenantId === retention.tenantId,
    decision.authority === undefined || decision.authority.legalEntityId === retention.legalEntityId,
    decision.authority === undefined ||
      samePurposeRef(decision.authority.purposeRef, activity.processingScope.purposeRef),
    decision.authority === undefined || decision.authority.purposeVersionRef.resourceId === retention.purposeVersionId,
    decision.authority === undefined ||
      sameApplicabilityScope(decision.evaluatedScope, activity.processingScope.applicabilityScope),
  ].every(Boolean);

const retentionCoverageIsComplete = (
  activity: ProcessingActivity,
  coverage: ProcessingActivityAuthoritativeCoverage,
  decisions: readonly PrivacyApplicabilityDecision[],
  controllers: readonly OwnerReference[],
  retentionRules: readonly PrivacyRetentionRuleVersion[],
  asOf: string,
): boolean => {
  if (
    coverage.retentionCoverage.length !== activity.retentionCoverage.length ||
    coverage.retentionCoverage.length !== activity.retentionRuleRefs.length ||
    activity.retentionRuleRefs.length === 0
  ) {
    return false;
  }
  const matchingDecisions = latestApplicableDecisions(activity, decisions, asOf);
  const currentRules = currentRetention(activity, retentionRules, asOf);
  const exactStoredCoverage = sameRecordSet(
    coverage.retentionCoverage,
    activity.retentionCoverage,
    Schema.toEquivalence(ProcessingRetentionReferenceSchema),
  );
  const exactRuleRefs = sameRecordSet(
    coverage.retentionCoverage.map(({ ruleRef }) => ruleRef),
    activity.retentionRuleRefs,
    sameOwnerRef,
  );
  const exactCurrentRules = sameRecordSet(
    currentRules.map((rule) => ({
      moduleId: privacyModuleId,
      resourceId: rule.ruleRef,
      resourceType: 'privacy.core.retention-rule',
      tenantId: activity.activityRef.tenantId,
    })),
    activity.retentionRuleRefs,
    sameOwnerRef,
  );
  const exactActivityContentScopes = sameStringSet(
    currentRules.map(({ contentScopeRef }) => contentScopeRef),
    activity.dataCoverage.map(({ recordContentScope }) => recordContentScope),
  );
  return (
    exactStoredCoverage &&
    exactRuleRefs &&
    exactCurrentRules &&
    exactActivityContentScopes &&
    coverage.retentionCoverage.every((retention) => {
      const values = retentionCoverageEntryValues(activity, matchingDecisions, controllers, currentRules, retention);
      return (
        values !== undefined &&
        retentionCoverageEntryMatches(
          activity,
          asOf,
          retention,
          values.activityRetention,
          values.controller,
          values.decision,
          values.expectedDataCategoryRefs,
          values.rule,
        )
      );
    })
  );
};

const purposeIsReady = (
  activity: ProcessingActivity,
  purpose: ProcessingPurpose,
  purposeVersion: PurposeVersion,
  asOf: string,
): boolean =>
  samePurposeRef(purpose.purposeRef, activity.processingScope.purposeRef) &&
  purpose.purposeRef.tenantId === activity.activityRef.tenantId &&
  purpose.legalEntityId === activity.legalEntityId &&
  purpose.lifecycle === 'ACTIVE' &&
  purposeVersion.versionId === activity.processingScope.purposeVersionId &&
  currentAtNullable(purposeVersion.effectiveFrom, purposeVersion.effectiveTo, asOf);

const responsibilityPrerequisitesAreReady = (
  activity: ProcessingActivity,
  responsibilities: readonly PrivacyResponsibilityAssignment[],
  asOf: string,
): boolean => {
  const current = currentResponsibilities(activity, responsibilities, asOf);
  return (
    hasCurrentController(activity, responsibilities, asOf) &&
    current.length === activity.processingScope.responsibilityAssignmentRefs.length &&
    activity.processingScope.responsibilityAssignmentRefs.length > 0
  );
};

const policyPrerequisitesAreReady = (
  activity: ProcessingActivity,
  legalBasisAssignments: readonly PrivacyLegalBasisAssignment[],
  responsibilities: readonly PrivacyResponsibilityAssignment[],
  retentionRules: readonly PrivacyRetentionRuleVersion[],
  asOf: string,
): boolean => {
  const controllers = currentControllerRefs(activity, responsibilities, asOf);
  const bases = currentLegalBasis(activity, legalBasisAssignments, controllers, asOf);
  return (
    controllers.length > 0 &&
    bases.length === controllers.length &&
    sameRecordSet(
      bases.map((assignment) => assignment.assignmentRef),
      activity.legalBasisAssignmentRefs,
      sameLegalBasisRef,
    ) &&
    sameRecordSet(
      bases.map((assignment) => ({
        moduleId: legalEntityModuleId,
        resourceId: assignment.scope.controllerRef,
        resourceType: legalEntityResourceType,
        tenantId: activity.activityRef.tenantId,
      })),
      controllers,
      sameOwnerRef,
    ) &&
    currentRetention(activity, retentionRules, asOf).length === activity.retentionRuleRefs.length &&
    activity.retentionRuleRefs.length > 0
  );
};

const sameOwnerRefSet = (left: readonly OwnerReference[], right: readonly OwnerReference[]): boolean =>
  sameRecordSet(left, right, sameOwnerRef);

const sameRecipientTarget = (
  left: ProcessingRecipientTransfer['recipientTarget'],
  right: ProcessingRecipientTransfer['recipientTarget'],
): boolean => {
  if ('recipientRef' in left && 'recipientRef' in right) {
    return sameOwnerRef(left.recipientRef, right.recipientRef);
  }
  if ('recipientCategoryRef' in left && 'recipientCategoryRef' in right) {
    return sameOwnerRef(left.recipientCategoryRef, right.recipientCategoryRef);
  }
  return false;
};

const recipientTransferEquivalent = (left: ProcessingRecipientTransfer, right: ProcessingRecipientTransfer): boolean =>
  left.role === right.role &&
  sameOwnerRefSet(left.dataCategoryRefs, right.dataCategoryRefs) &&
  sameOwnerRefSet(left.downstreamSystemRefs, right.downstreamSystemRefs) &&
  sameRecipientTarget(left.recipientTarget, right.recipientTarget);

const processingScopeEquivalent = (
  left: ProcessingActivityAuthorityScope,
  right: ProcessingActivity['processingScope'],
): boolean =>
  sameApplicabilityScope(left.applicabilityScope, right.applicabilityScope) &&
  samePurposeRef(left.purposeRef, right.purposeRef) &&
  left.purposeVersionId === right.purposeVersionId &&
  sameOwnerRefSet(left.responsibilityAssignmentRefs, right.responsibilityAssignmentRefs);

const ownerCapabilityBindingMatches = (
  coverage: ProcessingActivityAuthoritativeCoverage,
  dataCoverage: ProcessingActivity['dataCoverage'][number],
): boolean =>
  coverage.ownerCapabilityBindings.some(
    (binding) =>
      sameOwnerRef(binding.dataCategoryRef, dataCoverage.dataCategoryRef) &&
      sameOwnerRef(binding.systemOfRecordRef, dataCoverage.systemOfRecordRef) &&
      binding.ownerCapability === dataCoverage.ownerCapability &&
      binding.ownerModuleId === dataCoverage.ownerModuleId,
  );

/**
 * Checks the private coverage proof against the stored activity and current
 * responsibility assignments. Caller-provided activity fields are never an
 * authority substitute for this result.
 */
export const processingActivityAuthoritativeCoverageIsReady = (
  activity: ProcessingActivity,
  coverage: ProcessingActivityAuthoritativeCoverage,
  responsibilities: readonly PrivacyResponsibilityAssignment[],
  asOf: string,
  retentionRules?: readonly PrivacyRetentionRuleVersion[],
): boolean => {
  if (retentionRules === undefined) {
    return false;
  }
  const {
    activityRef: storedActivityRef,
    dataCategoryRefs: activityDataCategoryRefs,
    legalEntityId: activityLegalEntityId,
    processingScope,
    recipientRefs: activityRecipientRefs,
    systemOfRecordRefs: activitySystemOfRecordRefs,
  } = activity;
  const { tenantId } = storedActivityRef;
  const expectedScope = processingScope.applicabilityScope.processingScopeRef;
  const activityDataCoverageRefs = activity.dataCoverage.map(({ dataCategoryRef }) => dataCategoryRef);
  const expectedOwnerCapabilityBindings: ProcessingActivityOwnerCapabilityBinding[] = activity.dataCoverage.map(
    ({ dataCategoryRef, ownerCapability, ownerModuleId, systemOfRecordRef }) => ({
      dataCategoryRef,
      ownerCapability,
      ownerModuleId,
      systemOfRecordRef,
    }),
  );
  const transferRefsAreExact = coverage.recipientTransfers.every((transfer) => {
    const target = transfer.recipientTarget;
    const targetRef = 'recipientRef' in target ? target.recipientRef : target.recipientCategoryRef;
    return (
      transfer.dataCategoryRefs.every((reference) =>
        activityDataCategoryRefs.some((activityReference) => sameOwnerRef(reference, activityReference)),
      ) &&
      transfer.downstreamSystemRefs.every((reference) =>
        activitySystemOfRecordRefs.some((activityReference) => sameOwnerRef(reference, activityReference)),
      ) &&
      targetRef.tenantId === tenantId &&
      activityRecipientRefs.some((activityReference) => sameOwnerRef(targetRef, activityReference))
    );
  });
  const coverageReferencesAreTenantBound = [
    ...coverage.controllerRefs,
    ...coverage.dataCategoryRefs,
    ...coverage.dataCoverage.flatMap(({ dataCategoryRef, systemOfRecordRef }) => [dataCategoryRef, systemOfRecordRef]),
    ...coverage.ownerCapabilityBindings.flatMap(({ dataCategoryRef, systemOfRecordRef }) => [
      dataCategoryRef,
      systemOfRecordRef,
    ]),
    ...coverage.retentionCoverage.flatMap(({ controllerRef, dataCategoryRefs, ruleRef }) => [
      controllerRef,
      ...dataCategoryRefs,
      ruleRef,
    ]),
    coverage.processingScope.purposeRef,
    ...coverage.processingScope.responsibilityAssignmentRefs,
    ...coverage.recipientRefs,
    ...coverage.systemOfRecordRefs,
    ...coverage.recipientTransfers.flatMap((transfer) => {
      const target = transfer.recipientTarget;
      return [
        ...transfer.dataCategoryRefs,
        ...transfer.downstreamSystemRefs,
        'recipientRef' in target ? target.recipientRef : target.recipientCategoryRef,
      ];
    }),
  ].every((reference) => reference.tenantId === tenantId);
  const checks = {
    activityIdentity: sameOwnerRef(coverage.activityRef, storedActivityRef),
    activityTenant: coverage.tenantId === tenantId,
    coverageData: sameRecordSet(coverage.dataCoverage, activity.dataCoverage, dataCoverageEquivalent),
    coverageEvidence: coverage.evidenceRefs.length > 0,
    coverageReferencesAreTenantBound,
    coverageSystems: sameOwnerRefSet(coverage.systemOfRecordRefs, activitySystemOfRecordRefs),
    currentControllers: sameOwnerRefSet(
      coverage.controllerRefs,
      currentControllerRefs(activity, responsibilities, asOf),
    ),
    dataCoverageRefsAreExact:
      sameOwnerRefSet(coverage.dataCategoryRefs, activityDataCoverageRefs) &&
      sameOwnerRefSet(coverage.dataCategoryRefs, activityDataCategoryRefs),
    legalEntity: coverage.legalEntityId === activityLegalEntityId,
    observedAt: coverage.observedAt <= asOf,
    ownerCapabilities:
      sameRecordSet(
        coverage.ownerCapabilityBindings,
        expectedOwnerCapabilityBindings,
        ownerCapabilityBindingEquivalent,
      ) && coverage.dataCoverage.every((dataCoverage) => ownerCapabilityBindingMatches(coverage, dataCoverage)),
    processingScope:
      coverage.processingScopeRef.scopeId === expectedScope.scopeId &&
      coverage.processingScopeRef.scopeType === expectedScope.scopeType &&
      processingScopeEquivalent(coverage.processingScope, processingScope),
    recipients: sameOwnerRefSet(coverage.recipientRefs, activityRecipientRefs),
    retention: retentionCoverageIsComplete(
      activity,
      coverage,
      coverage.applicabilityDecisions,
      currentControllerRefs(activity, responsibilities, asOf),
      retentionRules,
      asOf,
    ),
    systemsPresent: coverage.systemOfRecordRefs.length > 0,
    transferRefs: transferRefsAreExact,
    transfers: sameRecordSet(coverage.recipientTransfers, activity.recipientTransfers, recipientTransferEquivalent),
  };
  return Object.values(checks).every(Boolean);
};

const isProcessingActivityReadyForEffect = (
  activity: ProcessingActivity,
  asOf: string,
  prerequisites?: ProcessingActivityResolvedPrerequisites,
): boolean => {
  if (prerequisites === undefined) {
    return false;
  }
  const { applicabilityDecisions, legalBasisAssignments, purpose, purposeVersion, responsibilities, retentionRules } =
    prerequisites;
  return (
    purposeIsReady(activity, purpose, purposeVersion, asOf) &&
    responsibilityPrerequisitesAreReady(activity, responsibilities, asOf) &&
    policyPrerequisitesAreReady(activity, legalBasisAssignments, responsibilities, retentionRules, asOf) &&
    applicabilityIsAuthoritative(activity, applicabilityDecisions, prerequisites.coverage, responsibilities, asOf) &&
    processingActivityAuthoritativeCoverageIsReady(
      activity,
      prerequisites.coverage,
      responsibilities,
      asOf,
      retentionRules,
    )
  );
};

const copyOrEmpty = <Value>(values: readonly Value[] | undefined): Value[] => (values === undefined ? [] : [...values]);
const processingActivityScopedKey = (tenantId: string, legalEntityId: string, resourceId: string): string =>
  `${tenantId}:${legalEntityId}:${resourceId}`;

export const buildProcessingActivity = (input: {
  readonly actor: PrincipalRef;
  readonly createdAt: string;
  readonly legalEntityId: string;
  readonly request: CreateProcessingActivityInput;
  readonly tenantId: string;
}): ProcessingActivity => {
  const { actor, createdAt, legalEntityId, request, tenantId } = input;
  const id = request.activityRef?.resourceId ?? randomUUID();
  const initialEvent: ProcessingActivityLifecycleEvent = {
    actor,
    decisionEvidenceRefs: [],
    effectiveAt: createdAt,
    from: null,
    reason: 'Processing Activity proposed',
    recordedAt: createdAt,
    to: 'PROPOSED',
  };
  return {
    activityRef: request.activityRef ?? activityRef(tenantId, id),
    applicabilityDecisions: copyOrEmpty(request.applicabilityDecisions),
    createdAt,
    currentLifecycle: 'PROPOSED',
    dataCategoryRefs: copyOrEmpty(request.dataCategoryRefs),
    dataCoverage: copyOrEmpty(request.dataCoverage),
    legalBasisAssignmentRefs: copyOrEmpty(request.legalBasisAssignmentRefs),
    legalEntityId,
    lifecycle: [initialEvent],
    processingScope: {
      applicabilityScope: request.processingScope.applicabilityScope,
      purposeRef: request.processingScope.purposeRef,
      purposeVersionId: request.processingScope.purposeVersionId,
      responsibilityAssignmentRefs: [...request.processingScope.responsibilityAssignmentRefs],
    },
    recipientRefs: copyOrEmpty(request.recipientRefs),
    recipientTransfers: copyOrEmpty(request.recipientTransfers),
    retentionCoverage: copyOrEmpty(request.retentionCoverage),
    retentionRuleRefs: copyOrEmpty(request.retentionRuleRefs),
    systemOfRecordRefs: copyOrEmpty(request.systemOfRecordRefs),
    updatedAt: createdAt,
  };
};

const isAllowedProcessingActivityTransition = (
  current: ProcessingActivityLifecycle,
  target: ProcessingActivityLifecycle,
): boolean => {
  const transitions = {
    EFFECTIVE: ['ENDED', 'SUSPENDED'],
    ENDED: [],
    PROPOSED: ['EFFECTIVE', 'ENDED'],
    SUSPENDED: ['EFFECTIVE', 'ENDED'],
  } satisfies Record<ProcessingActivityLifecycle, readonly ProcessingActivityLifecycle[]>;
  const allowedTargets: readonly ProcessingActivityLifecycle[] = transitions[current];
  return allowedTargets.includes(target);
};

export const processingActivityTransitionRejection = (
  activity: ProcessingActivity,
  target: ProcessingActivityLifecycle,
  effectiveAt = activity.updatedAt,
  prerequisites?: ProcessingActivityResolvedPrerequisites,
): ProcessingActivityRegistryError | undefined => {
  if (!isAllowedProcessingActivityTransition(activity.currentLifecycle, target)) {
    return new ProcessingActivityRegistryError({
      code: 'privacy_processing_activity_transition_rejected',
      reason: `Processing Activity cannot transition from ${activity.currentLifecycle} to ${target}`,
    });
  }
  if (target === 'EFFECTIVE' && !isProcessingActivityReadyForEffect(activity, effectiveAt, prerequisites)) {
    return new ProcessingActivityRegistryError({
      code: 'privacy_processing_activity_transition_rejected',
      reason:
        'Effective processing requires authoritative current purpose, scope, responsibility, applicability, legal basis, owner mapping, and retention prerequisites',
    });
  }
  return undefined;
};

export const applyProcessingActivityTransition = (
  activity: ProcessingActivity,
  actor: PrincipalRef,
  to: ProcessingActivityLifecycle,
  decisionEvidenceRefs: readonly string[],
  effectiveAt: string,
  recordedAt: string,
): ProcessingActivity => ({
  ...activity,
  currentLifecycle: to,
  lifecycle: [
    ...activity.lifecycle,
    {
      actor,
      decisionEvidenceRefs: [...decisionEvidenceRefs],
      effectiveAt,
      from: activity.currentLifecycle,
      reason: `Processing Activity transitioned to ${to}`,
      recordedAt,
      to,
    },
  ],
  updatedAt: recordedAt,
});

export const makeInMemoryProcessingActivityRegistry = (
  configuration: InMemoryProcessingActivityRegistryConfiguration = {},
): ProcessingActivityRepositoryService => {
  const activities = new Map<string, ProcessingActivity>();
  return {
    create: Effect.fn('makeInMemoryProcessingActivityRegistry.create')(function* create(
      tenantId: string,
      legalEntityId: string,
      actor: PrincipalRef,
      _actionInvocationId: string,
      input: CreateProcessingActivityInput,
    ) {
      const foreignReferenceReason = processingActivityInputForeignReferenceReason(tenantId, input);
      if (foreignReferenceReason !== undefined) {
        return yield* new ProcessingActivityRegistryError({
          code: 'privacy_processing_activity_transition_rejected',
          reason: foreignReferenceReason,
        });
      }
      const createdAt = DateTime.formatIso(yield* DateTime.now);
      const activity = buildProcessingActivity({ actor, createdAt, legalEntityId, request: input, tenantId });
      activities.set(processingActivityScopedKey(tenantId, legalEntityId, activity.activityRef.resourceId), activity);
      return activity;
    }),
    get: (tenantId: string, legalEntityId: string, resourceId: string) =>
      Effect.succeed(
        Option.fromNullishOr(activities.get(processingActivityScopedKey(tenantId, legalEntityId, resourceId))),
      ),
    list: (tenantId: string, legalEntityId: string) =>
      Effect.succeed(
        [...activities.values()].filter(
          (activity) => activity.activityRef.tenantId === tenantId && activity.legalEntityId === legalEntityId,
        ),
      ),
    transition: Effect.fn('makeInMemoryProcessingActivityRegistry.transition')(function* transitionActivity(
      tenantId: string,
      legalEntityId: string,
      resourceId: string,
      actor: PrincipalRef,
      _actionInvocationId: string,
      to: ProcessingActivityLifecycle,
      decisionEvidenceRefs: readonly string[],
      effectiveAt: string,
      authoritativeCoverage?: ProcessingActivityAuthoritativeCoverage,
    ) {
      const key = processingActivityScopedKey(tenantId, legalEntityId, resourceId);
      const current = activities.get(key);
      if (current === undefined) {
        return yield* new ProcessingActivityRegistryError({
          code: 'privacy_processing_activity_not_found',
          reason: 'Processing Activity was not found',
        });
      }
      const prerequisites =
        to === 'EFFECTIVE' && configuration.resolvePrerequisites !== undefined
          ? yield* configuration.resolvePrerequisites(current, effectiveAt, authoritativeCoverage)
          : undefined;
      const rejection = processingActivityTransitionRejection(current, to, effectiveAt, prerequisites);
      if (rejection !== undefined) {
        return yield* rejection;
      }
      const recordedAt = DateTime.formatIso(yield* DateTime.now);
      const updated = applyProcessingActivityTransition(
        current,
        actor,
        to,
        decisionEvidenceRefs,
        effectiveAt,
        recordedAt,
      );
      activities.set(key, updated);
      return updated;
    }),
  };
};
